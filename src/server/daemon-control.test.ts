import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getDaemonStatus, readDaemonLogs, startDaemon, stopDaemon } from "./daemon-control.js";
import { defaultDaemonConfig } from "./config.js";
import { acquireInstanceLock } from "./instance-lock.js";
import { writeRuntime } from "./runtime-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("daemon control", () => {
  it("cleans stale runtime state", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-daemon-"));
    temporaryDirectories.push(directory);
    writeRuntime(directory, {
      host: "127.0.0.1",
      instanceToken: "3f5ad8ea-b580-4d2f-83aa-b16372b25a5b",
      logPath: path.join(directory, "daemon.log"),
      mcpUrl: "http://127.0.0.1:43110/mcp",
      pid: 2_147_483_647,
      port: 43_110,
      startedAt: new Date().toISOString(),
    });

    await expect(getDaemonStatus(directory)).resolves.toEqual({ reachable: false, running: false });
  });

  it("returns the requested tail of daemon logs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-daemon-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "daemon.log"), "one\ntwo\nthree\n");

    expect(readDaemonLogs(directory, 2).lines).toEqual(["two", "three"]);
  });

  it("refuses to signal a PID when daemon identity is not reachable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-daemon-"));
    temporaryDirectories.push(directory);
    const lock = acquireInstanceLock(directory);
    writeRuntime(directory, {
      host: "127.0.0.1",
      instanceToken: lock.token,
      logPath: path.join(directory, "daemon.log"),
      mcpUrl: "http://127.0.0.1:9/mcp",
      pid: process.pid,
      port: 9,
      startedAt: new Date().toISOString(),
    });

    await expect(stopDaemon(directory, 100)).rejects.toThrow("daemon identity could not be verified");
    lock.release();
  });

  it("does not report a running but unreachable daemon as a successful start", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-daemon-"));
    temporaryDirectories.push(directory);
    const lock = acquireInstanceLock(directory);
    writeRuntime(directory, {
      host: "127.0.0.1",
      instanceToken: lock.token,
      logPath: path.join(directory, "daemon.log"),
      mcpUrl: "http://127.0.0.1:9/mcp",
      pid: process.pid,
      port: 9,
      startedAt: new Date().toISOString(),
    });

    try {
      await expect(startDaemon(defaultDaemonConfig, directory)).rejects.toThrow("not reachable");
    } finally {
      lock.release();
    }
  });
});
