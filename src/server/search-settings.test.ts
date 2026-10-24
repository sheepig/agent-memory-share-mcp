import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../search/embedding.js";
import { buildServer } from "./app.js";
import { configPath, defaultDaemonConfig, readDaemonConfig, writeDaemonConfig } from "./config.js";

const directories: string[] = [];
const embeddingProvider: EmbeddingProvider = {
  modelId: "settings-fixture",
  async countContentTokens(text) { return text.length; },
  async embedPassages(texts) { return texts.map(() => Float32Array.from([1, 0])); },
  async embedQuery() { return Float32Array.from([1, 0]); },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-search-settings-"));
  directories.push(root);
  const homeDirectory = path.join(root, "home");
  const memory = path.join(homeDirectory, ".codex/memories/MEMORY.md");
  await fs.mkdir(path.dirname(memory), { recursive: true });
  await fs.writeFile(memory, "# Search evidence\nRetain original evidence positions and inspectable source paths.");
  const score = vi.fn(async (_query: string, documents: readonly string[]) => documents.map(() => 7));
  const dispose = vi.fn(async () => {});
  const options = {
    dataDirectory: path.join(root, "data"), embeddingProvider, homeDirectory, logger: false, scanIntervalMs: 0,
    rerankerProvider: { modelId: "settings-reranker", score, dispose },
  };
  return { options, score, dispose };
}

describe("persisted search settings", () => {
  it("switches HTTP and MCP searches immediately, reads manual edits and retains settings after restart", async () => {
    const { options, score, dispose } = await fixture();
    let app = await buildServer(options);
    try {
      expect((await app.inject({ method: "GET", url: "/api/config/search" })).json()).toEqual({ rerankerEnabled: false });
      const search = () => app.inject({ method: "GET", url: "/api/search?query=evidence&mode=hybrid" });
      expect((await search()).json().results).toHaveLength(1);
      expect(score).not.toHaveBeenCalled();

      const saved = await app.inject({ method: "PATCH", url: "/api/config/search", payload: { rerankerEnabled: true } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ rerankerEnabled: true });
      expect(readDaemonConfig(options.dataDirectory)).toEqual({ ...defaultDaemonConfig, rerankerEnabled: true });
      expect((await search()).json().results[0]).toMatchObject({ score: 7, matchReason: expect.stringContaining("settings-reranker") });
      expect(score).toHaveBeenCalledOnce();

      const mcp = await app.inject({ method: "POST", url: "/mcp",
        headers: { accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_fragments", arguments: { excludeAgent: "claude-code", query: "evidence" } } },
      });
      expect(mcp.statusCode).toBe(200);
      expect(mcp.body).toContain("settings-reranker");
      expect(score).toHaveBeenCalledTimes(2);

      writeDaemonConfig(options.dataDirectory, { ...readDaemonConfig(options.dataDirectory), rerankerEnabled: false });
      expect((await search()).json().results[0].matchReason).not.toContain("reranker");
      expect(score).toHaveBeenCalledTimes(2);
      await app.inject({ method: "PATCH", url: "/api/config/search", payload: { rerankerEnabled: true } });
      await app.close();
      expect(dispose).toHaveBeenCalledOnce();
      app = await buildServer(options);
      expect((await app.inject({ method: "GET", url: "/api/config/search" })).json()).toEqual({ rerankerEnabled: true });
      expect((await search()).json().results[0].score).toBe(7);

      await app.inject({ method: "PATCH", url: "/api/config/search", payload: { rerankerEnabled: false } });
      expect((await search()).json().results[0].matchReason).not.toContain("reranker");
      expect(score).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed or unrelated settings without changing the file", async () => {
    const { options } = await fixture();
    const app = await buildServer(options);
    try {
      const before = await fs.readFile(configPath(options.dataDirectory), "utf8");
      for (const payload of [{}, { rerankerEnabled: "false" }, { rerankerEnabled: true, host: "0.0.0.0" }]) {
        expect((await app.inject({ method: "PATCH", url: "/api/config/search", payload })).statusCode).toBe(400);
        expect(await fs.readFile(configPath(options.dataDirectory), "utf8")).toBe(before);
      }
    } finally {
      await app.close();
    }
  });

  it("reports a failed atomic write and keeps the previous configuration active", async () => {
    const { options, score } = await fixture();
    const app = await buildServer(options);
    try {
      const before = await fs.readFile(configPath(options.dataDirectory), "utf8");
      vi.spyOn(fsSync, "renameSync").mockImplementationOnce(() => { throw new Error("Configuration replacement failed"); });
      const response = await app.inject({ method: "PATCH", url: "/api/config/search", payload: { rerankerEnabled: true } });
      expect(response.statusCode).toBe(500);
      expect(await fs.readFile(configPath(options.dataDirectory), "utf8")).toBe(before);
      expect((await app.inject({ method: "GET", url: "/api/config/search" })).json()).toEqual({ rerankerEnabled: false });
      await app.inject({ method: "GET", url: "/api/search?query=evidence" });
      expect(score).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
