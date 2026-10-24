import type { SourceScanResult, SourceService } from "../application/source-service.js";

export type SourceWorkerState = "idle" | "scanning" | "starting" | "stopped" | "stopping";

export interface SourceWorkerStatus {
  lastCompletedAt?: string;
  lastError?: string;
  lastResult?: SourceScanResult;
  lastStartedAt?: string;
  recoveredSources: number;
  runCount: number;
  state: SourceWorkerState;
  lastStepMs?: number;
  maxStepMs?: number;
  slowSteps?: number;
}

interface WorkerSourceService {
  excludeSession(candidateId: string): ReturnType<SourceService["excludeSession"]>;
  indexSession(candidateId: string, generateEmbeddings?: boolean): ReturnType<SourceService["indexSession"]>;
  prepareRebuild(): number;
  recoverInterrupted(): number;
  retryFailedEmbeddings(generateEmbeddings?: boolean): ReturnType<SourceService["retryFailedEmbeddings"]>;
  restoreSession(candidateId: string, generateEmbeddings?: boolean): ReturnType<SourceService["restoreSession"]>;
  scanSources(): Promise<SourceScanResult>;
  scanSteps?(): AsyncGenerator<SourceScanResult, SourceScanResult>;
}

export class SourceWorker {
  private currentScan?: Promise<SourceScanResult>;
  private interval?: ReturnType<typeof setInterval>;
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private stopping = false;
  private rescanRequested = false;
  private status: SourceWorkerStatus = {
    recoveredSources: 0,
    runCount: 0,
    state: "stopped",
  };

  constructor(
    private readonly sources: WorkerSourceService,
    private readonly options: { intervalMs: number },
  ) {}

  async start(): Promise<void> {
    if (this.status.state !== "stopped") {
      return;
    }
    this.stopping = false;
    this.status = {
      recoveredSources: this.sources.recoverInterrupted(),
      runCount: this.status.runCount,
      state: "starting",
    };
    if (this.options.intervalMs > 0 && this.status.state !== "stopping" && this.status.state !== "stopped") {
      this.interval = setInterval(() => {
        void this.scanNow().catch(() => {
          // The status captures the failure; later intervals may retry it.
        });
      }, this.options.intervalMs);
      this.interval.unref();
    }
    await this.scanNow();
  }

  scanNow(): Promise<SourceScanResult> {
    if (this.currentScan) {
      return this.currentScan;
    }
    if (this.stopping) {
      return Promise.reject(new Error("Source worker is stopping."));
    }
    const scan = this.sources.scanSteps ? this.performIncrementalScan() : this.enqueue(() => this.performScan());
    this.currentScan = scan;
    void scan.finally(() => {
      if (this.currentScan === scan) {
        this.currentScan = undefined;
        if (this.rescanRequested && !this.stopping) {
          this.rescanRequested = false;
          void this.scanNow().catch(() => undefined);
        }
      }
    }).catch(() => undefined);
    return scan;
  }

  indexSession(candidateId: string): ReturnType<SourceService["indexSession"]> {
    return this.enqueue(() => this.sources.indexSession(candidateId, false)).then((result) => { this.requestScan(); return result; });
  }

  excludeSession(candidateId: string): Promise<ReturnType<SourceService["excludeSession"]>> {
    return this.enqueue(() => this.sources.excludeSession(candidateId)).then((result) => { this.requestScan(); return result; });
  }

  restoreSession(candidateId: string): ReturnType<SourceService["restoreSession"]> {
    return this.enqueue(() => this.sources.restoreSession(candidateId, false)).then((result) => { this.requestScan(); return result; });
  }

  async rebuild(): Promise<{ queuedSources: number; scan: SourceScanResult }> {
    const queuedSources = await this.enqueue(() => this.sources.prepareRebuild());
    await this.currentScan;
    return { queuedSources, scan: await this.scanNow() };
  }

  retryFailedEmbeddings(): ReturnType<SourceService["retryFailedEmbeddings"]> {
    return this.enqueue(() => this.sources.retryFailedEmbeddings(false)).then((result) => { this.requestScan(); return result; });
  }

  getStatus(): SourceWorkerStatus {
    return structuredClone(this.status);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.status.state === "stopped" && this.pendingOperations === 0) {
      return;
    }
    this.stopping = true;
    this.status = { ...this.status, state: "stopping" };
    await this.operationTail;
    await this.currentScan?.catch(() => undefined);
    this.status = { ...this.status, state: "stopped" };
  }

  private requestScan(): void {
    if (this.stopping || !this.sources.scanSteps) return;
    if (this.currentScan) this.rescanRequested = true;
    else void this.scanNow().catch(() => undefined);
  }

  private async performIncrementalScan(): Promise<SourceScanResult> {
    const iterator = this.sources.scanSteps!();
    let result: SourceScanResult = { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
    this.status = { ...this.status, lastError: undefined, lastStartedAt: new Date().toISOString(), state: "scanning" };
    try {
      while (!this.stopping) {
        const step = await this.enqueue(async () => {
          const started = performance.now();
          const next = await iterator.next();
          const duration = performance.now() - started;
          this.status = { ...this.status, lastStepMs: duration, maxStepMs: Math.max(this.status.maxStepMs ?? 0, duration),
            slowSteps: (this.status.slowSteps ?? 0) + Number(duration > 50) };
          return next;
        });
        result = step.value;
        this.status = { ...this.status, lastResult: structuredClone(result) };
        if (step.done) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return result;
    } catch (error) {
      this.status = { ...this.status, lastError: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally {
      await this.operationTail;
      await iterator.return(result);
      this.status = { ...this.status, lastCompletedAt: new Date().toISOString(), runCount: this.status.runCount + 1,
        state: this.stopping ? "stopping" : "idle" };
    }
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.stopping) {
      return Promise.reject(new Error("Source worker is stopping."));
    }
    this.pendingOperations += 1;
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    void result.then(
      () => { this.pendingOperations -= 1; },
      () => { this.pendingOperations -= 1; },
    );
    return result;
  }

  private async performScan(): Promise<SourceScanResult> {
    this.status = {
      ...this.status,
      lastError: undefined,
      lastStartedAt: new Date().toISOString(),
      state: this.stopping ? "stopping" : "scanning",
    };
    try {
      const result = await this.sources.scanSources();
      this.status = {
        ...this.status,
        lastCompletedAt: new Date().toISOString(),
        lastResult: result,
        runCount: this.status.runCount + 1,
        state: this.stopping ? "stopping" : "idle",
      };
      return result;
    } catch (error) {
      this.status = {
        ...this.status,
        lastCompletedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
        runCount: this.status.runCount + 1,
        state: this.stopping ? "stopping" : "idle",
      };
      throw error;
    }
  }
}

export function createSourceWorker(
  sources: SourceService,
  options: { intervalMs?: number } = {},
): SourceWorker {
  return new SourceWorker(sources, { intervalMs: options.intervalMs ?? 60_000 });
}
