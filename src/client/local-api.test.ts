import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "./local-api.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local daemon client", () => {
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
