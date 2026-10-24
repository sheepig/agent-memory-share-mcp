import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "./local-api.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local daemon client", () => {
  it("forwards the excluded agent through the daemon search request", async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", fetch);
    const client = new LocalApiClient({ host: "127.0.0.1", port: 43110 });
    await client.search({ excludeAgent: "codex", query: "synthetic evidence" });
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/api/search");
    expect(url.searchParams.get("excludeAgent")).toBe("codex");
  });

  it("preserves capacity waiting metadata when listing Session candidates", async () => {
    const session = { admissionReason: "capacity", agent: "codex", candidateId: "waiting", disposition: "discovered", indexStatus: "discovered", sessionId: "waiting", sourcePath: "/synthetic/waiting.jsonl", updatedAt: "2026-10-24T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ counts: { discovered: 1, excluded: 0, selected: 0 }, sessions: [session], total: 1 }))));
    const client = new LocalApiClient({ host: "127.0.0.1", port: 43110 });
    expect((await client.listSessions()).sessions).toEqual([session]);
  });

  it("allows a search to exceed thirty seconds while retaining the short timeout for other requests", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    vi.stubGlobal("fetch", (_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ results: [] }))), 31_000);
      options.signal!.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Request aborted"));
      });
    }));
    const client = new LocalApiClient({ host: "127.0.0.1", port: 43110 });
    const search = client.search({ query: "synthetic evidence" });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await search).toEqual({ results: [] });
    const health = expect(client.health()).rejects.toThrow("Local daemon is unavailable");
    await vi.advanceTimersByTimeAsync(30_000);
    await health;
  });
});
