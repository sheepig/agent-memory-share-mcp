import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configPath, defaultDaemonConfig, initializeDaemonConfig, readDaemonConfig, writeDaemonConfig } from "./config.js";
import { RotatingLogStream } from "./rotating-log.js";
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

  it("rotates bounded daemon logs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-log-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "daemon.log");
    const stream = new RotatingLogStream(file, { maxBytes: 8, retainedFiles: 2 });

    stream.write("12345678");
    stream.write("abcdef");
    await new Promise<void>((resolve, reject) => stream.end((error?: Error) => error ? reject(error) : resolve()));

    expect(await fs.readFile(file, "utf8")).toBe("abcdef");
    expect(await fs.readFile(`${file}.1`, "utf8")).toBe("12345678");
  });
});
