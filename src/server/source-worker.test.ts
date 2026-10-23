import { describe, expect, it, vi } from "vitest";

import { SourceWorker } from "./source-worker.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function serviceWith(overrides: Record<string, unknown> = {}) {
  return {
    excludeSession: vi.fn(() => ({ candidateId: "candidate", disposition: "excluded" as const })),
    indexSession: vi.fn(async () => ({ candidateId: "candidate", fragmentCount: 1, sourcePath: "/session" })),
    prepareRebuild: vi.fn(() => 0),
    recoverInterrupted: vi.fn(() => 0),
    retryFailedEmbeddings: vi.fn(async () => ({ attempted: 0, failed: 0, indexed: 0 })),
    restoreSession: vi.fn(async () => ({ candidateId: "candidate", fragmentCount: 1, sourcePath: "/session" })),
    scanSources: vi.fn(async () => ({ failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 })),
    ...overrides,
  };
}

describe("source worker", () => {
  it("recovers interrupted sources and completes an initial scan", async () => {
    const service = serviceWith({
      recoverInterrupted: vi.fn(() => 2),
      scanSources: vi.fn(async () => ({ failed: 0, indexed: 3, memories: 1, sessions: 2, unavailable: 0 })),
    });
    const worker = new SourceWorker(service, { intervalMs: 0 });

    await worker.start();

    expect(service.recoverInterrupted).toHaveBeenCalledOnce();
    expect(service.scanSources).toHaveBeenCalledOnce();
    expect(worker.getStatus()).toMatchObject({ recoveredSources: 2, runCount: 1, state: "idle" });
    await worker.stop();
  });

  it("coalesces concurrent triggers and exposes live status", async () => {
    const current = deferred();
    const service = serviceWith({
      scanSources: vi.fn(async () => {
        await current.promise;
        return { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
      }),
    });
    const worker = new SourceWorker(service, { intervalMs: 0 });

    const first = worker.scanNow();
    const second = worker.scanNow();
    await Promise.resolve();
    expect(service.scanSources).toHaveBeenCalledOnce();
    expect(worker.getStatus().state).toBe("scanning");
    current.resolve();
    await Promise.all([first, second]);

    expect(service.scanSources).toHaveBeenCalledOnce();
    expect(worker.getStatus()).toMatchObject({ runCount: 1, state: "idle" });
  });

  it("waits for an active scan before stopping", async () => {
    const current = deferred();
    const service = serviceWith({
      scanSources: vi.fn(async () => {
        await current.promise;
        return { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
      }),
    });
    const worker = new SourceWorker(service, { intervalMs: 0 });
    const scan = worker.scanNow();
    await Promise.resolve();
    let stopped = false;

    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(worker.getStatus().state).toBe("stopping");
    current.resolve();
    await Promise.all([scan, stopping]);

    expect(stopped).toBe(true);
    expect(worker.getStatus().state).toBe("stopped");
  });

  it("records a failed scan and permits a later retry", async () => {
    const service = serviceWith({
      scanSources: vi.fn()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValueOnce({ failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 }),
    });
    const worker = new SourceWorker(service, { intervalMs: 0 });

    await expect(worker.scanNow()).rejects.toThrow("database unavailable");
    expect(worker.getStatus()).toMatchObject({ lastError: "database unavailable", runCount: 1, state: "idle" });
    await worker.scanNow();
    expect(worker.getStatus()).toMatchObject({ lastError: undefined, runCount: 2, state: "idle" });
  });

  it("serializes session mutations with scans", async () => {
    const current = deferred();
    const events: string[] = [];
    const service = serviceWith({
      excludeSession: vi.fn(() => {
        events.push("excluded");
        return { candidateId: "candidate", disposition: "excluded" as const };
      }),
      scanSources: vi.fn(async () => {
        events.push("scan-started");
        await current.promise;
        events.push("scan-finished");
        return { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
      }),
    });
    const worker = new SourceWorker(service, { intervalMs: 0 });

    const scan = worker.scanNow();
    const exclusion = worker.excludeSession("candidate");
    await Promise.resolve();
    expect(events).toEqual(["scan-started"]);
    current.resolve();
    await Promise.all([scan, exclusion]);

    expect(events).toEqual(["scan-started", "scan-finished", "excluded"]);
  });
});
