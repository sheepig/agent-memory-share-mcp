import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultDaemonConfig } from "../server/config.js";

const { startDaemon, connectAgent } = vi.hoisted(() => ({ startDaemon: vi.fn(), connectAgent: vi.fn() }));
vi.mock("../server/daemon-control.js", () => ({
  getDaemonStatus: vi.fn(), readDaemonLogs: vi.fn(), startDaemon, stopDaemon: vi.fn(),
}));
vi.mock("./agent-integration.js", () => ({ connectAgent, disconnectAgent: vi.fn() }));
vi.mock("./evaluation.js", () => ({ registerEvaluationCommands: vi.fn() }));
vi.mock("../server/start.js", () => ({ startServer: vi.fn() }));

const originalArguments = process.argv;
const originalExitCode = process.exitCode;
let directory: string;
let stdout: string;
let stderr: string;
const status = {
  alreadyRunning: false,
  mcpUrl: "http://127.0.0.1:43110/mcp",
  pid: 12345,
  reachable: true,
  running: true,
  startedAt: "2026-10-23T00:00:00.000Z",
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-cli-"));
  stdout = "";
  stderr = "";
  process.exitCode = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected CLI exit."); });
  startDaemon.mockResolvedValue(status);
});

afterEach(async () => {
  process.argv = originalArguments;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

async function run(...args: string[]) {
  process.argv = [process.execPath, "agent-memory", "--data-dir", directory, ...args];
  await import("./index.js");
}

describe("local service startup CLI", () => {
  it("starts without init and prints usable URLs and the explicit Codex connection command", async () => {
    await run("start", "--source-home", path.join(directory, "sources"));

    expect(startDaemon).toHaveBeenCalledWith(defaultDaemonConfig, directory, { sourceHome: path.join(directory, "sources") });
    expect(process.exitCode, stderr).toBe(0);
    expect(stdout).toContain(`MCP: ${status.mcpUrl}`);
    expect(stdout).toContain("Web: http://127.0.0.1:43110/");
    expect(stdout).toContain("agent-memory connect codex");
    expect(stdout).toContain("agent-memory daemon stop");
    expect(connectAgent).not.toHaveBeenCalled();
  });

  it("keeps JSON output machine readable and uses the actual running address", async () => {
    startDaemon.mockResolvedValue({ ...status, alreadyRunning: true, mcpUrl: "http://[::1]:45123/mcp" });
    await run("start", "--json");

    expect(process.exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ...status, alreadyRunning: true, mcpUrl: "http://[::1]:45123/mcp", webUrl: "http://[::1]:45123/",
    });
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stderr).toBe("");
  });

  it("reports repeated starts without claiming to create another daemon", async () => {
    startDaemon.mockResolvedValue({ ...status, alreadyRunning: true });
    await run("start");

    expect(process.exitCode, stderr).toBe(0);
    expect(stdout).toContain("already running");
    expect(stdout).toContain(status.mcpUrl);
  });

  it("reports startup failure as a JSON error without a successful connection address", async () => {
    startDaemon.mockRejectedValue(new Error("Daemon did not become ready."));
    await run("--json", "start");

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: "Daemon did not become ready." });
    expect(stderr).toBe("");
  });
});

describe("Session capacity CLI", () => {
  it("persists one Agent fragment budget and leaves the others unchanged", async () => {
    await run("--json", "config", "set", "sessionFragmentLimits.claude-code", "12000");

    expect(process.exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout).sessionFragmentLimits).toEqual({ codex: 5000, "claude-code": 12000, cursor: 5000, opencode: 5000 });
    expect(JSON.parse(await fs.readFile(path.join(directory, "config.json"), "utf8")).sessionFragmentLimits["claude-code"]).toBe(12000);
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it("rejects zero fragment budgets without saving a configuration", async () => {
    await run("--json", "config", "set", "sessionFragmentLimits.codex", "0");

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout).error).toMatch(/integer between 1/);
    await expect(fs.stat(path.join(directory, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
