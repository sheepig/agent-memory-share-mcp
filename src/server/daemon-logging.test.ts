import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("daemon output", () => {
  it("saves startup errors through Pino with stdout/stderr disconnected from log files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-daemon-logging-"));
    temporaryDirectories.push(directory);
    await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ host: "invalid-host" }));
    const cli = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
    const entry = path.join(directory, "entry.mjs");
    await fs.writeFile(entry, `
      import fs from "node:fs";
      await import(${JSON.stringify(cli)});
      process.stdout.write("x".repeat(25_000_000));
      process.stderr.write("raw-stderr-is-not-persisted\\n");
      fs.writeSync(2, "native-stderr-is-not-persisted\\n");
    `);
    const result = spawnSync(process.execPath, ["--import", "tsx", entry, "--data-dir", directory, "serve", "--daemon-child"], {
      stdio: "ignore", timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const files = (await fs.readdir(directory)).filter((name) => name.startsWith("daemon.log"));
    expect(files).toEqual(["daemon.log"]);
    const current = await fs.readFile(path.join(directory, "daemon.log"), "utf8");
    expect(JSON.parse(current).msg).toBe("Daemon startup failed.");
    expect(JSON.parse(current).err.message).toContain("loopback");
  });
});
