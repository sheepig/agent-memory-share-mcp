import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireInstanceLock } from "./instance-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("daemon instance lock", () => {
  it("rejects a second live owner and releases only its own lock", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-lock-"));
    temporaryDirectories.push(dataDirectory);
    const first = acquireInstanceLock(dataDirectory);

    expect(() => acquireInstanceLock(dataDirectory)).toThrow(`Another daemon is already running with PID ${process.pid}.`);
    first.release();

    const second = acquireInstanceLock(dataDirectory);
    expect(second.path).toBe(path.join(dataDirectory, "daemon.lock"));
    second.release();
    await expect(fs.stat(second.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces a lock owned by a process that no longer exists", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-lock-"));
    temporaryDirectories.push(dataDirectory);
    await fs.writeFile(path.join(dataDirectory, "daemon.lock"), JSON.stringify({ pid: 2_147_483_647, token: "stale" }));

    const lock = acquireInstanceLock(dataDirectory);

    expect(JSON.parse(await fs.readFile(lock.path, "utf8"))).toMatchObject({ pid: process.pid });
    lock.release();
  });
});
