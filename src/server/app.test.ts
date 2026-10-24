import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../search/embedding.js";
import { buildServer } from "./app.js";

const temporaryDirectories: string[] = [];
const visibleFinalAnswer = "Visible final answer with enough implementation detail to preserve the original source path, message role, location, and content fingerprint for later inspection.";
const embeddingProvider: EmbeddingProvider = {
  modelId: "test-embedding-v1",
  async countContentTokens(text) {
    return [...text].length;
  },
  async embedPassages(texts) {
    return texts.map(() => Float32Array.from([1, 0]));
  },
  async embedQuery() {
    return Float32Array.from([1, 0]);
  },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("server", () => {
  it("serves health while the initial background scan is waiting for embeddings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-startup-test-"));
    temporaryDirectories.push(root);
    const homeDirectory = path.join(root, "home");
    const memoryPath = path.join(homeDirectory, ".codex/memories/MEMORY.md");
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.writeFile(memoryPath, "# Startup evidence\nKeep the service available while the local embedding model loads.");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const building = buildServer({
      backgroundInitialScan: true,
      dataDirectory: path.join(root, "data"),
      embeddingProvider: {
        ...embeddingProvider,
        async embedPassages(texts) {
          await pending;
          return texts.map(() => Float32Array.from([1, 0]));
        },
      },
      homeDirectory,
      logger: false,
      scanIntervalMs: 0,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const app = await Promise.race([
        building,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Server startup blocked on initial embeddings.")), 2_000);
        }),
      ]);
      await app.listen({ host: "127.0.0.1", port: 0 });
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/scan/status" })).json().state).toBe("scanning");
    } finally {
      clearTimeout(timeout);
      release();
      await (await building).close();
    }
  });

  it("reports service and database health", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-test-"));
    temporaryDirectories.push(dataDirectory);
    const homeDirectory = path.join(dataDirectory, "home");
    await fs.mkdir(homeDirectory);
    const app = await buildServer({ dataDirectory, embeddingProvider, homeDirectory, logger: false, scanIntervalMs: 0 });

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      database: "ok",
      service: "agent-memory-share-mcp",
      status: "ok",
      version: "0.1.0",
    });
    await app.close();
  });

  it("exposes daemon identity only when started with an instance token", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-identity-"));
    temporaryDirectories.push(dataDirectory);
    const app = await buildServer({
      dataDirectory,
      embeddingProvider,
      homeDirectory: path.join(dataDirectory, "home"),
      instanceToken: "3f5ad8ea-b580-4d2f-83aa-b16372b25a5b",
      logger: false,
      scanIntervalMs: 0,
    });

    const response = await app.inject({ method: "GET", url: "/api/daemon/identity" });

    expect(response.json()).toEqual({ instanceToken: "3f5ad8ea-b580-4d2f-83aa-b16372b25a5b", pid: process.pid });
    await app.close();
  });

  it("serves the built web application and client routes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-web-test-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const homeDirectory = path.join(root, "home");
    const publicDirectory = path.join(root, "public");
    await Promise.all([fs.mkdir(homeDirectory), fs.mkdir(publicDirectory)]);
    await fs.writeFile(path.join(publicDirectory, "index.html"), "<main>Agent Memory</main>");
    const app = await buildServer({ dataDirectory, embeddingProvider, homeDirectory, logger: false, publicDirectory, scanIntervalMs: 0 });

    const rootResponse = await app.inject({ method: "GET", url: "/" });
    const sessionsResponse = await app.inject({ method: "GET", url: "/sessions" });
    const sessionDetailResponse = await app.inject({ method: "GET", url: `/sessions/${"a".repeat(64)}` });
    const searchResponse = await app.inject({ method: "GET", url: "/search" });
    const auditResponse = await app.inject({ method: "GET", url: "/audit" });

    expect(rootResponse.statusCode).toBe(200);
    expect(rootResponse.body).toContain("Agent Memory");
    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.body).toContain("Agent Memory");
    expect(sessionDetailResponse.statusCode).toBe(200);
    expect(sessionDetailResponse.body).toContain("Agent Memory");
    expect(searchResponse.statusCode).toBe(200);
    expect(searchResponse.body).toContain("Agent Memory");
    expect(auditResponse.statusCode).toBe(404);
    await app.close();
  });

  it("does not write search query text to daemon logs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-log-test-"));
    temporaryDirectories.push(root);
    const logFile = path.join(root, "daemon.log");
    const homeDirectory = path.join(root, "home");
    await fs.mkdir(homeDirectory);
    const app = await buildServer({
      dataDirectory: path.join(root, "data"),
      embeddingProvider,
      homeDirectory,
      logFile,
      scanIntervalMs: 0,
    });

    await app.inject({ method: "GET", url: "/api/search?query=credential-like-private-query" });
    await app.close();
    const logs = await fs.readFile(logFile, "utf8");

    expect(logs).toContain("/api/search");
    expect(logs).not.toContain("credential-like-private-query");
  });

  it("filters both memories and sessions by excluded agent and validates the enum", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-exclude-agent-"));
    temporaryDirectories.push(root);
    const homeDirectory = path.join(root, "home");
    const memoryPath = path.join(homeDirectory, ".codex/memories/MEMORY.md");
    const sessionPath = path.join(homeDirectory, ".codex/sessions/session.jsonl");
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(memoryPath, "# Evidence\nSynthetic searchable evidence in a memory.");
    await fs.writeFile(sessionPath, [
      { type: "session_meta", payload: { id: "exclude-agent-session" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find searchable evidence" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: visibleFinalAnswer }] } },
    ].map((record) => JSON.stringify(record)).join("\n"));
    const app = await buildServer({
      dataDirectory: path.join(root, "data"), embeddingProvider, homeDirectory, logger: false, scanIntervalMs: 0,
    });
    try {
      const listed = await app.inject({ method: "GET", url: "/api/sessions" });
      const candidateId = listed.json<{ sessions: Array<{ candidateId: string }> }>().sessions[0]!.candidateId;
      expect((await app.inject({ method: "POST", url: `/api/sessions/${candidateId}/index` })).statusCode).toBe(200);
      for (const mode of ["keyword", "semantic", "hybrid"]) {
        for (const excludeAgent of ["claude-code", "codex", "cursor", "opencode"]) {
          const result = await app.inject({ method: "GET", url: `/api/search?query=evidence&mode=${mode}&excludeAgent=${excludeAgent}` });
          expect(result.statusCode).toBe(200);
          expect(result.json().results).toHaveLength(excludeAgent === "codex" ? 0 : 2);
        }
      }
      for (const excludeAgent of ["claude", "CODEX", "unknown", ""]) {
        expect((await app.inject({ method: "GET", url: `/api/search?query=evidence&excludeAgent=${excludeAgent}` })).statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("exposes the session selection and search use cases to the web client", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-api-test-"));
    temporaryDirectories.push(root);
    const homeDirectory = path.join(root, "home");
    const sessionPath = path.join(homeDirectory, ".codex/sessions/session.jsonl");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, [
      { type: "session_meta", payload: { id: "api-session", cwd: "/project/api" } },
      { timestamp: "2026-10-16T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Expose searchable evidence" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "hidden reasoning" }] } },
      { timestamp: "2026-10-16T01:01:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: visibleFinalAnswer }] } },
    ].map((record) => JSON.stringify(record)).join("\n"));
    const app = await buildServer({
      dataDirectory: path.join(root, "data"),
      embeddingProvider,
      homeDirectory,
      logger: false,
      scanIntervalMs: 0,
    });

    const initialStatus = await app.inject({ method: "GET", url: "/api/scan/status" });
    expect(initialStatus.json<{ runCount: number; state: string }>()).toMatchObject({ runCount: 1, state: "idle" });
    const listed = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ counts: Record<string, number> }>().counts).toEqual({ discovered: 0, excluded: 0, selected: 1 });
    const candidateId = listed.json<{ sessions: Array<{ candidateId: string }> }>().sessions[0]?.candidateId;
    expect(candidateId).toHaveLength(64);
    const conversation = await app.inject({ method: "GET", url: `/api/sessions/${candidateId}` });
    expect(conversation.statusCode).toBe(200);
    expect(conversation.json<{ messages: Array<{ body: string; role: string }> }>().messages).toEqual([
      { body: "Expose searchable evidence", location: "line:2", role: "user", timestamp: "2026-10-16T01:00:00.000Z" },
      { body: visibleFinalAnswer, location: "line:4", role: "assistant", timestamp: "2026-10-16T01:01:00.000Z" },
    ]);
    expect(conversation.body).not.toContain("hidden reasoning");
    expect((await app.inject({ method: "GET", url: `/api/sessions/${"0".repeat(64)}` })).statusCode).toBe(404);
    const beforeIndexSearch = await app.inject({ method: "GET", url: "/api/search?query=searchable%20evidence&sourceType=session" });
    expect(beforeIndexSearch.json<{ results: unknown[] }>().results).toHaveLength(1);
    const statusAfterReads = await app.inject({ method: "GET", url: "/api/scan/status" });
    expect(statusAfterReads.json<{ runCount: number }>().runCount).toBe(1);
    const missing = await app.inject({ method: "POST", url: `/api/sessions/${"0".repeat(64)}/index` });
    expect(missing.statusCode).toBe(404);

    const indexed = await app.inject({ method: "POST", url: `/api/sessions/${candidateId}/index` });
    expect(indexed.statusCode).toBe(200);
    const searched = await app.inject({ method: "GET", url: "/api/search?query=searchable%20evidence&sourceType=session" });
    expect(searched.statusCode).toBe(200);
    expect(searched.json<{ results: Array<Record<string, unknown>> }>().results[0]).toMatchObject({
      chunkIndex: 0,
      endLocation: "line:4",
      endedAt: "2026-10-16T01:01:00.000Z",
      location: "line:2",
      sourcePath: sessionPath,
      startedAt: "2026-10-16T01:00:00.000Z",
      turnCount: 1,
    });
    expect(searched.json<{ results: Array<{ contentTokenCount: number }> }>().results[0]?.contentTokenCount)
      .toBeGreaterThan(0);
    const semantic = await app.inject({ method: "GET", url: "/api/search?query=find%20evidence&sourceType=session&mode=semantic" });
    expect(semantic.statusCode).toBe(200);
    expect(semantic.json<{ results: Array<Record<string, unknown>> }>().results[0]).toMatchObject({
      matchReason: "semantic similarity",
      sourcePath: sessionPath,
    });

    const excluded = await app.inject({ method: "POST", url: `/api/sessions/${candidateId}/exclude` });
    expect(excluded.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/search?query=searchable%20evidence" })).json<{ results: unknown[] }>().results).toHaveLength(0);
    const restored = await app.inject({ method: "POST", url: `/api/sessions/${candidateId}/restore` });
    expect(restored.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/search?query=searchable%20evidence" })).json<{ results: unknown[] }>().results).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/search?query=searchable%20evidence&updatedAfter=2999-01-01T00%3A00%3A00.000Z" })).json<{ results: unknown[] }>().results).toHaveLength(0);

    const rebuilt = await app.inject({ method: "POST", url: "/api/rebuild" });
    expect(rebuilt.statusCode).toBe(200);
    expect(rebuilt.json<{ queuedSources: number }>().queuedSources).toBe(1);

    const manualScan = await app.inject({ method: "POST", url: "/api/scan" });
    expect(manualScan.statusCode).toBe(200);
    const finalStatus = await app.inject({ method: "GET", url: "/api/scan/status" });
    expect(finalStatus.json<{ runCount: number }>().runCount).toBeGreaterThan(statusAfterReads.json<{ runCount: number }>().runCount);
    expect((await app.inject({ method: "GET", url: `/api/diagnostics?sourceId=${candidateId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/index/status" })).json()).toMatchObject({
      embedding: { indexed: 1 },
      fragments: 1,
    });
    expect((await app.inject({ method: "GET", url: `/api/audit?sourceId=${candidateId}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/embeddings/retry" })).json()).toEqual({ attempted: 0, failed: 0, indexed: 0 });

    await app.close();
  });
});
