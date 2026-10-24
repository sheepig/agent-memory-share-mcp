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
  it("runs mutations between scan steps and closes an unfinished scan on stop", async () => {
    const events: string[] = [];
    const service = { ...serviceWith(),
      excludeSession: vi.fn(() => { events.push("excluded"); return { candidateId: "candidate", disposition: "excluded" as const }; }),
      scanSteps: vi.fn(async function* () {
        try {
          events.push("step");
          yield { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
          for (;;) { events.push("step"); yield { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 }; }
        } finally { events.push("closed"); }
      }),
    };
    const worker = new SourceWorker(service, { intervalMs: 0 });
    const scan = worker.scanNow();
    await worker.excludeSession("candidate");
    await worker.stop();
    await scan;
    expect(service.scanSteps).toHaveBeenCalledOnce();
    expect(service.scanSources).not.toHaveBeenCalled();
    expect(events.indexOf("excluded")).toBeLessThan(events.indexOf("closed"));
    expect(events.filter((event) => event === "step").length).toBeLessThanOrEqual(2);
  });

  it("completes a fresh scan after rebuild mutates an already-scanned source", async () => {
    const ready = deferred();
    let dirty = false;
    let scans = 0;
    const result = { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
    const service = { ...serviceWith(),
      prepareRebuild: vi.fn(() => { dirty = true; return 1; }),
      scanSteps: vi.fn(async function* () {
        scans += 1;
        dirty = false;
        ready.resolve();
        yield { ...result };
        return { ...result };
      }),
    };
    const worker = new SourceWorker(service, { intervalMs: 0 });
    const scan = worker.scanNow();
    await ready.promise;
    try {
      expect((await worker.rebuild()).queuedSources).toBe(1);
      await scan;
      expect(scans).toBeGreaterThanOrEqual(2);
      expect(dirty).toBe(false);
    } finally { await worker.stop(); }
  });

  it("keeps periodic retries active after an initial background scan failure", async () => {
    let attempts = 0;
    const retried = deferred();
    const result = { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
    const service = { ...serviceWith(), scanSteps: vi.fn(async function* () {
      attempts += 1;
      if (attempts === 1) throw new Error("transient scan failure");
      retried.resolve();
      return { ...result };
    }) };
    const worker = new SourceWorker(service, { intervalMs: 5 });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(worker.start()).rejects.toThrow("transient scan failure");
      await Promise.race([retried.promise, new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Periodic scan did not retry.")), 500);
      })]);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      if (timeout) clearTimeout(timeout);
      await worker.stop();
    }
  });

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
