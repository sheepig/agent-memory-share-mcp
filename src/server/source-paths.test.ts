import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "../search/embedding.js";
import { openDatabase } from "../storage/database.js";
import { buildServer } from "./app.js";
import { configPath, defaultDaemonConfig, readDaemonConfig } from "./config.js";

const directories: string[] = [];
const counter: EmbeddingProvider = {
  modelId: "source-path-test",
  async countContentTokens(text) { return text.length; },
  async embedPassages(texts) { return texts.map(() => Float32Array.from([1, 0])); },
  async embedQuery() { return Float32Array.from([1, 0]); },
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("source configuration in the daemon", () => {
  it("loads edited paths on restart, preserves source decisions, and retains paths when toggling reranking", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-configured-server-"));
    directories.push(root);
    const dataDirectory = path.join(root, "data");
    const homeDirectory = path.join(root, "home");
    const firstMemory = path.join(root, "first", "notes.md");
    const nextMemory = path.join(root, "next", "notes.md");
    const session = path.join(root, "sessions", "session.jsonl");
    await Promise.all([dataDirectory, homeDirectory, path.dirname(firstMemory), path.dirname(nextMemory), path.dirname(session)].map((directory) => fs.mkdir(directory)));
    await fs.writeFile(firstMemory, "# First evidence\nThe first configured memory contains uniquefirstevidence.");
    await fs.writeFile(nextMemory, "# Next evidence\nThe replacement memory contains uniquenextevidence.");
    await fs.copyFile(fileURLToPath(new URL("../sources/fixtures/codex-jsonl-v1.jsonl", import.meta.url)), session);
    const sources = {
      codex: { sessionRoots: [path.dirname(session)], memoryRoots: [path.dirname(firstMemory)] },
      "claude-code": { projectRoots: [], memoryRoots: [] },
      cursor: { sessionRoots: [] },
      opencode: { databasePath: path.join(root, "absent.db") },
    };
    await fs.writeFile(configPath(dataDirectory), JSON.stringify({ ...defaultDaemonConfig, sources }));
    const options = { dataDirectory, homeDirectory, embeddingProvider: counter, scanIntervalMs: 0, logger: false };
    let app = await buildServer(options);
    try {
      const listed = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]).toMatchObject({ disposition: "selected", sourcePath: session });
      const id = listed.sessions[0].candidateId;
      await app.inject({ method: "POST", url: `/api/sessions/${id}/exclude` });
      const first = (await app.inject({ method: "GET", url: "/api/search?query=uniquefirstevidence" })).json();
      expect(first.results).toHaveLength(1);
      expect(first.results[0].sourcePath).toBe(firstMemory);

      const nextSources = { ...sources, codex: { ...sources.codex, memoryRoots: [path.dirname(nextMemory)] } };
      await fs.writeFile(configPath(dataDirectory), JSON.stringify({ ...readDaemonConfig(dataDirectory), sources: nextSources }));
      await app.inject({ method: "PATCH", url: "/api/config/search", payload: { rerankerEnabled: true } });
      expect(readDaemonConfig(dataDirectory)).toMatchObject({ rerankerEnabled: true, sources: nextSources });
      await app.inject({ method: "PATCH", url: "/api/config/search", payload: { rerankerEnabled: false } });
      await app.inject({ method: "POST", url: "/api/scan" });
      expect((await app.inject({ method: "GET", url: "/api/search?query=uniquefirstevidence" })).json().results).toHaveLength(1);
      await app.close();

      const database = openDatabase(dataDirectory);
      database.prepare("INSERT INTO scan_checkpoints(adapter_key, scan_id, cursor, started_at) VALUES (?, ?, ?, ?)")
        .run("codex:memory:previous-scope", "previous-scan", firstMemory, new Date().toISOString());
      database.close();
      app = await buildServer(options);
      expect((await app.inject({ method: "GET", url: "/api/search?query=uniquefirstevidence" })).json().results).toHaveLength(0);
      const next = (await app.inject({ method: "GET", url: "/api/search?query=uniquenextevidence" })).json();
      expect(next.results).toHaveLength(1);
      expect(next.results[0].sourcePath).toBe(nextMemory);
      const after = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
      expect(after.sessions[0]).toMatchObject({ candidateId: id, disposition: "excluded" });
      expect((await app.inject({ method: "GET", url: "/api/index/status" })).json().activeScanCheckpoints).toBe(0);
      expect(await fs.readFile(firstMemory, "utf8")).toContain("uniquefirstevidence");
    } finally {
      await app.close();
    }
  });
});
