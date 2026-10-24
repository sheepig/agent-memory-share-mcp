import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileLogger } from "./file-logger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

async function logFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-log-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "daemon.log");
}

describe("bounded Pino logging", () => {
  it("keeps at most four files of 5 MB across repeated writes and restarts", async () => {
    const file = await logFile();
    for (let run = 0; run < 2; run += 1) {
      const output = await createFileLogger(file);
      for (let index = 0; index < 400; index += 1) output.logger.info({ run, index, padding: "x".repeat(64_000) });
      output.logger.info("last-record");
      await output.close();

      const files = await fs.readdir(path.dirname(file));
      expect(files.sort()).toEqual(["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3"]);
      const sizes = await Promise.all(files.map(async (name) => (await fs.stat(path.join(path.dirname(file), name))).size));
      expect(sizes.every((size) => size <= 5_000_000)).toBe(true);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(20_000_000);
      expect(await fs.readFile(file, "utf8")).toContain("last-record");
      for (const name of files) expect((await fs.stat(path.join(path.dirname(file), name))).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces a multibyte oversized record with a bounded, valid JSON diagnostic", async () => {
    const file = await logFile();
    const output = await createFileLogger(file);
    output.logger.error({ detail: "界".repeat(10_000_000) });
    await output.close();

    const record = JSON.parse(await fs.readFile(file, "utf8"));
    expect(record.msg).toBe("Oversized log record omitted.");
    expect(record.bytes).toBeGreaterThan(30_000_000);
    expect(record.detail).toBeUndefined();
    expect((await fs.stat(file)).size).toBeLessThan(65_536);
  });

  it("removes oversized legacy files before opening the log", async () => {
    const file = await logFile();
    for (const suffix of ["", ".1", ".2", ".3"]) await fs.writeFile(`${file}${suffix}`, "x".repeat(5_000_001));
    const output = await createFileLogger(file);
    output.logger.info("new-version");
    await output.close();

    expect(await fs.readdir(path.dirname(file))).toEqual(["daemon.log"]);
    expect(await fs.readFile(file, "utf8")).toContain("new-version");
  });

  it("flushes on close and omits query strings from request logs", async () => {
    const file = await logFile();
    const output = await createFileLogger(file);
    output.logger.info({ req: { method: "GET", url: "/api/search?query=private-query" } }, "request");
    await output.close();
    await output.close();

    const body = await fs.readFile(file, "utf8");
    expect(JSON.parse(body).req.url).toBe("/api/search");
    expect(body).not.toContain("private-query");
  });
});
