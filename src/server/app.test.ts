import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "./app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("server", () => {
  it("reports service and database health", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-test-"));
    temporaryDirectories.push(dataDirectory);
    const app = await buildServer({ dataDirectory, logger: false });

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      database: "ok",
      service: "agent-memory-share-mcp",
      status: "ok",
      version: "0.0.0",
    });
    await app.close();
  });

  it("serves the built web application and client routes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-web-test-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const publicDirectory = path.join(root, "public");
    await fs.mkdir(publicDirectory);
    await fs.writeFile(path.join(publicDirectory, "index.html"), "<main>Agent Memory</main>");
    const app = await buildServer({ dataDirectory, logger: false, publicDirectory });

    const rootResponse = await app.inject({ method: "GET", url: "/" });
    const sessionsResponse = await app.inject({ method: "GET", url: "/sessions" });

    expect(rootResponse.statusCode).toBe(200);
    expect(rootResponse.body).toContain("Agent Memory");
    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.body).toContain("Agent Memory");
    await app.close();
  });
});
