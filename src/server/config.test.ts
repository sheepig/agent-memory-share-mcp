import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configPath, defaultDaemonConfig, initializeDaemonConfig, readDaemonConfig, writeDaemonConfig } from "./config.js";
import { readRuntime, removeRuntime, writeRuntime } from "./runtime-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("daemon files", () => {
  it("initializes and validates daemon configuration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-config-"));
    temporaryDirectories.push(directory);

    expect(initializeDaemonConfig(directory)).toEqual(defaultDaemonConfig);
    expect(writeDaemonConfig(directory, { host: "::1", port: 45_000, scanIntervalSeconds: 0 })).toEqual({
      ...defaultDaemonConfig,
      host: "::1",
      port: 45_000,
      rerankerEnabled: false,
      scanIntervalSeconds: 0,
    });
    expect(readDaemonConfig(directory).port).toBe(45_000);
    expect(() => writeDaemonConfig(directory, { host: "0.0.0.0", port: 45_000, scanIntervalSeconds: 1 })).toThrow();
  });

  it("defaults legacy files to disabled and persists a strict reranker boolean", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-reranker-config-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(configPath(directory), JSON.stringify({ host: "127.0.0.1", port: 45_123, scanIntervalSeconds: 0 }));

    expect(readDaemonConfig(directory).rerankerEnabled).toBe(false);
    writeDaemonConfig(directory, { ...readDaemonConfig(directory), rerankerEnabled: true });
    expect(readDaemonConfig(directory)).toMatchObject({ port: 45_123, rerankerEnabled: true });
    await fs.writeFile(configPath(directory), JSON.stringify({ ...readDaemonConfig(directory), rerankerEnabled: "false" }));
    expect(() => readDaemonConfig(directory)).toThrow();
  });

  it("materializes source paths for legacy files and preserves edits when saving search settings", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-source-config-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(configPath(directory), JSON.stringify({ host: "127.0.0.1", port: 45_123, scanIntervalSeconds: 0 }));

    initializeDaemonConfig(directory);
    const saved = JSON.parse(await fs.readFile(configPath(directory), "utf8"));
    expect(saved.sources.codex.sessionRoots).toEqual(["~/.codex/sessions", "~/.codex/archived_sessions"]);
    saved.sources.codex.memoryRoots = ["~/custom-memories", "/shared/notes.md"];
    await fs.writeFile(configPath(directory), JSON.stringify(saved));
    writeDaemonConfig(directory, { ...readDaemonConfig(directory), rerankerEnabled: true });
    expect(readDaemonConfig(directory)).toMatchObject({
      port: 45_123, rerankerEnabled: true,
      sources: { codex: { memoryRoots: ["~/custom-memories", "/shared/notes.md"] } },
    });
  });

  it("rejects ambiguous paths and misspelled source options", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-invalid-sources-"));
    temporaryDirectories.push(directory);
    for (const sources of [
      { codex: { sessionRoots: ["relative/sessions"] } },
      { codex: { memoryRoots: [""] } },
      { codex: { memoryRoot: ["/notes"] } },
      { opencode: { databasePath: "/database\0.db" } },
    ]) {
      await fs.writeFile(configPath(directory), JSON.stringify({ ...defaultDaemonConfig, sources }));
      expect(() => readDaemonConfig(directory)).toThrow();
    }
  });

  it("defaults and persists per-agent fragment budgets without a Session count limit", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-capacity-config-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(configPath(directory), JSON.stringify({ ...defaultDaemonConfig, sessionFragmentLimits: undefined }));

    expect(readDaemonConfig(directory).sessionFragmentLimits).toEqual({ codex: 5_000, "claude-code": 5_000, cursor: 5_000, opencode: 5_000 });
    initializeDaemonConfig(directory);
    expect(JSON.parse(await fs.readFile(configPath(directory), "utf8")).sessionFragmentLimits.codex).toBe(5_000);
    writeDaemonConfig(directory, { ...readDaemonConfig(directory), sessionFragmentLimits: { codex: 10_000 } });
    expect(readDaemonConfig(directory).sessionFragmentLimits).toEqual({ codex: 10_000, "claude-code": 5_000, cursor: 5_000, opencode: 5_000 });
    for (const value of [0, -1, 1.5, "5000"]) {
      await fs.writeFile(configPath(directory), JSON.stringify({ ...defaultDaemonConfig, sessionFragmentLimits: { codex: value } }));
      expect(() => readDaemonConfig(directory)).toThrow();
    }
  });

  it("writes and removes runtime state only for its owning process", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-runtime-"));
    temporaryDirectories.push(directory);
    const runtime = {
      host: "127.0.0.1",
      instanceToken: "3f5ad8ea-b580-4d2f-83aa-b16372b25a5b",
      logPath: path.join(directory, "daemon.log"),
      mcpUrl: "http://127.0.0.1:43110/mcp",
      pid: process.pid,
      port: 43_110,
      startedAt: new Date().toISOString(),
    };

    writeRuntime(directory, runtime);
    expect(readRuntime(directory)).toEqual(runtime);
    removeRuntime(directory, process.pid + 1);
    expect(readRuntime(directory)).toEqual(runtime);
    removeRuntime(directory, process.pid);
    expect(readRuntime(directory)).toBeUndefined();
  });
});
