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
}

interface WorkerSourceService {
  excludeSession(candidateId: string): ReturnType<SourceService["excludeSession"]>;
  indexSession(candidateId: string): ReturnType<SourceService["indexSession"]>;
  prepareRebuild(): number;
  recoverInterrupted(): number;
  retryFailedEmbeddings(): ReturnType<SourceService["retryFailedEmbeddings"]>;
  restoreSession(candidateId: string): ReturnType<SourceService["restoreSession"]>;
  scanSources(): Promise<SourceScanResult>;
}

export class SourceWorker {
  private currentScan?: Promise<SourceScanResult>;
  private interval?: ReturnType<typeof setInterval>;
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;
  private stopping = false;
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
    await this.scanNow();
    if (this.options.intervalMs > 0 && this.status.state !== "stopping" && this.status.state !== "stopped") {
      this.interval = setInterval(() => {
        void this.scanNow().catch(() => {
          // The status captures the failure; later intervals may retry it.
        });
      }, this.options.intervalMs);
      this.interval.unref();
    }
  }

  scanNow(): Promise<SourceScanResult> {
    if (this.currentScan) {
      return this.currentScan;
    }
    if (this.stopping) {
      return Promise.reject(new Error("Source worker is stopping."));
    }
    const scan = this.enqueue(() => this.performScan());
    this.currentScan = scan;
    void scan.finally(() => {
      if (this.currentScan === scan) {
        this.currentScan = undefined;
      }
    }).catch(() => undefined);
    return scan;
  }

  indexSession(candidateId: string): ReturnType<SourceService["indexSession"]> {
    return this.enqueue(async () => {
      await this.performScan();
      return this.sources.indexSession(candidateId);
    });
  }

  excludeSession(candidateId: string): Promise<ReturnType<SourceService["excludeSession"]>> {
    return this.enqueue(() => this.sources.excludeSession(candidateId));
  }

  restoreSession(candidateId: string): ReturnType<SourceService["restoreSession"]> {
    return this.enqueue(async () => {
      await this.performScan();
      return this.sources.restoreSession(candidateId);
    });
  }

  rebuild(): Promise<{ queuedSources: number; scan: SourceScanResult }> {
    return this.enqueue(async () => {
      const queuedSources = this.sources.prepareRebuild();
      const scan = await this.performScan();
      return { queuedSources, scan };
    });
  }

  retryFailedEmbeddings(): ReturnType<SourceService["retryFailedEmbeddings"]> {
    return this.enqueue(() => this.sources.retryFailedEmbeddings());
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
    this.status = { ...this.status, state: "stopped" };
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
