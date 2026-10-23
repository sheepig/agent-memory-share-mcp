import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { connectAgent, disconnectAgent } from "./agent-integration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("agent integration", () => {
  it("updates Cursor configuration atomically and preserves unrelated servers", async () => {
    const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-connect-"));
    temporaryDirectories.push(homeDirectory);
    const configPath = path.join(homeDirectory, ".cursor/mcp.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { existing: { url: "http://example.test/mcp" } } }));

    connectAgent("cursor", "http://127.0.0.1:43110/mcp", { homeDirectory });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      mcpServers: {
        existing: { url: "http://example.test/mcp" },
        "agent-memory": { url: "http://127.0.0.1:43110/mcp" },
      },
    });
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toContain("existing");

    disconnectAgent("cursor", { homeDirectory });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      mcpServers: { existing: { url: "http://example.test/mcp" } },
    });
  });

  it("uses the official user/global CLI forms for other agents", () => {
    const runner = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));
    connectAgent("codex", "http://127.0.0.1:43110/mcp", { runner });
    connectAgent("claude-code", "http://127.0.0.1:43110/mcp", { runner });
    expect(runner).toHaveBeenCalledWith("codex", ["mcp", "add", "agent-memory", "--url", "http://127.0.0.1:43110/mcp"]);
    expect(runner).toHaveBeenCalledWith("claude", ["mcp", "add", "--transport", "http", "--scope", "user", "agent-memory", "http://127.0.0.1:43110/mcp"]);
  });

  it("does not hide a real CLI removal failure", () => {
    const runner = vi.fn(() => ({ status: 1, stderr: "permission denied", stdout: "" }));
    expect(() => disconnectAgent("codex", { runner })).toThrow("permission denied");
  });

  it("supports both current and v2 OpenCode configuration shapes", async () => {
    const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-opencode-"));
    temporaryDirectories.push(homeDirectory);
    connectAgent("opencode", "http://127.0.0.1:43110/mcp", { homeDirectory });
    const configPath = path.join(homeDirectory, ".config/opencode/opencode.json");
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      mcp: { "agent-memory": { enabled: true, type: "remote", url: "http://127.0.0.1:43110/mcp" } },
    });
    await fs.writeFile(configPath, JSON.stringify({ mcp: { servers: { existing: { type: "remote", url: "https://example.test" } } } }));
    connectAgent("opencode", "http://127.0.0.1:43110/mcp", { homeDirectory });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      mcp: { servers: { "agent-memory": { oauth: false, type: "remote", url: "http://127.0.0.1:43110/mcp" }, existing: {} } },
    });
  });
});
