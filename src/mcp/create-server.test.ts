import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createSourceService } from "../application/source-service.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { openDatabase } from "../storage/database.js";
import { createSourceWorker } from "../server/source-worker.js";
import { createInProcessMcpBackend, createMcpServer } from "./create-server.js";

const temporaryDirectories: string[] = [];
const assistantReply = "The indexed evidence keeps its source path, original message position, role, and content fingerprint so every search result remains inspectable.";
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

describe("MCP source tools", () => {
  it("lists, selects, and searches a session through the SDK", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-mcp-"));
    temporaryDirectories.push(root);
    const homeDirectory = path.join(root, "home");
    const sessionPath = path.join(homeDirectory, ".codex/sessions/session.jsonl");
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, [
      { type: "session_meta", payload: { id: "mcp-session", cwd: "/project/mcp" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Preserve source provenance" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: assistantReply }] } },
    ].map((record) => JSON.stringify(record)).join("\n"));

    const database = openDatabase(path.join(root, "data"));
    const sources = createSourceService(database, { embeddingProvider, homeDirectory });
    const worker = createSourceWorker(sources, { intervalMs: 0 });
    await worker.start();
    const server = createMcpServer(createInProcessMcpBackend(database, sources, worker));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "health",
      "index_session",
      "list_sessions",
      "search_fragments",
    ]);
    const health = await client.callTool({ name: "health", arguments: {} });
    const healthContent = health.content as Array<{ text: string; type: string }>;
    expect(healthContent[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(healthContent[0]!.text)).toMatchObject({
      index: { activeScanCheckpoints: 0 },
      status: "ok",
      worker: { state: "idle" },
    });
    const listed = await client.callTool({ name: "list_sessions", arguments: {} });
    const candidateId = (listed.structuredContent as { sessions: Array<{ candidateId: string }> }).sessions[0]?.candidateId;
    expect(candidateId).toHaveLength(64);

    await client.callTool({ name: "index_session", arguments: { candidateId } });
    const searched = await client.callTool({
      name: "search_fragments",
      arguments: { query: "source provenance", sourceType: "session" },
    });
    const result = (searched.structuredContent as { results: Array<{ sourcePath: string; matchReason: string; score: number }> }).results[0];
    expect(result?.sourcePath).toBe(sessionPath);
    expect(result?.matchReason).toBe("hybrid match");
    expect(result?.score).toBeCloseTo(2 / 61);
    const semantic = await client.callTool({
      name: "search_fragments",
      arguments: { mode: "semantic", query: "locate historical evidence", sourceType: "session" },
    });
    expect((semantic.structuredContent as { results: Array<{ matchReason: string; sourcePath: string }> }).results[0])
      .toMatchObject({ matchReason: "semantic similarity", sourcePath: sessionPath });

    await client.close();
    await server.close();
    await worker.stop();
    database.close();
  });
});
