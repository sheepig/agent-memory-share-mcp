import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type SupportedAgent = "claude-code" | "codex" | "cursor" | "opencode";

export interface CommandResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

type CommandRunner = (command: string, args: string[]) => CommandResult;

const SERVER_NAME = "agent-memory";

function defaultRunner(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stderr: result.error?.message ?? result.stderr,
    stdout: result.stdout,
  };
}

function runOrThrow(runner: CommandRunner, command: string, args: string[]): void {
  const result = runner(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "command unavailable"}`);
  }
}

function removeIfPresent(runner: CommandRunner, command: string, args: string[]): void {
  const result = runner(command, args);
  if (result.status === 0) return;
  const detail = `${result.stderr}\n${result.stdout}`;
  if (/no mcp server|not found|does not exist/iu.test(detail)) return;
  throw new Error(`${command} ${args.join(" ")} failed: ${detail.trim() || "command unavailable"}`);
}

function writeCursorConfig(homeDirectory: string, url?: string): string {
  const configPath = path.join(homeDirectory, ".cursor/mcp.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    fs.copyFileSync(configPath, `${configPath}.bak`);
  }
  const currentServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers as Record<string, unknown>
    : {};
  const mcpServers = { ...currentServers };
  if (url) mcpServers[SERVER_NAME] = { url };
  else delete mcpServers[SERVER_NAME];
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...config, mcpServers }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  return configPath;
}

function writeOpenCodeConfig(homeDirectory: string, url?: string): string {
  const configPath = path.join(homeDirectory, ".config/opencode/opencode.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    fs.copyFileSync(configPath, `${configPath}.bak`);
  }
  const currentMcp = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)
    ? config.mcp as Record<string, unknown>
    : {};
  const usesV2Shape = currentMcp.servers && typeof currentMcp.servers === "object" && !Array.isArray(currentMcp.servers);
  const currentServers = usesV2Shape ? currentMcp.servers as Record<string, unknown> : currentMcp;
  const servers = { ...currentServers };
  if (url) servers[SERVER_NAME] = { ...(usesV2Shape ? { oauth: false } : { enabled: true }), type: "remote", url };
  else delete servers[SERVER_NAME];
  const mcp = usesV2Shape ? { ...currentMcp, servers } : servers;
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...config, mcp }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  return configPath;
}

export function connectAgent(
  agent: SupportedAgent,
  url: string,
  options: { homeDirectory?: string; runner?: CommandRunner } = {},
): { agent: SupportedAgent; configuration: string; url: string } {
  const runner = options.runner ?? defaultRunner;
  let configuration: string;
  if (agent === "codex") {
    removeIfPresent(runner, "codex", ["mcp", "remove", SERVER_NAME]);
    runOrThrow(runner, "codex", ["mcp", "add", SERVER_NAME, "--url", url]);
    configuration = "Codex user MCP configuration";
  } else if (agent === "claude-code") {
    removeIfPresent(runner, "claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]);
    runOrThrow(runner, "claude", ["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, url]);
    configuration = "Claude Code user MCP configuration";
  } else if (agent === "opencode") {
    configuration = writeOpenCodeConfig(options.homeDirectory ?? process.env.HOME ?? "", url);
  } else {
    configuration = writeCursorConfig(options.homeDirectory ?? process.env.HOME ?? "", url);
  }
  return { agent, configuration, url };
}

export function disconnectAgent(
  agent: SupportedAgent,
  options: { homeDirectory?: string; runner?: CommandRunner } = {},
): { agent: SupportedAgent; configuration: string } {
  const runner = options.runner ?? defaultRunner;
  let configuration: string;
  if (agent === "codex") {
    removeIfPresent(runner, "codex", ["mcp", "remove", SERVER_NAME]);
    configuration = "Codex user MCP configuration";
  } else if (agent === "claude-code") {
    removeIfPresent(runner, "claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]);
    configuration = "Claude Code user MCP configuration";
  } else if (agent === "opencode") {
    configuration = writeOpenCodeConfig(options.homeDirectory ?? process.env.HOME ?? "");
  } else {
    configuration = writeCursorConfig(options.homeDirectory ?? process.env.HOME ?? "");
  }
  return { agent, configuration };
}

export function inspectAgentIntegration(
  agent: SupportedAgent,
  options: { homeDirectory?: string; runner?: CommandRunner } = {},
): { configured: boolean; detail: string } {
  const runner = options.runner ?? defaultRunner;
  const homeDirectory = options.homeDirectory ?? process.env.HOME ?? "";
  if (agent === "codex" || agent === "claude-code") {
    const command = agent === "codex" ? "codex" : "claude";
    const result = runner(command, ["mcp", "get", SERVER_NAME]);
    return {
      configured: result.status === 0,
      detail: result.status === 0 ? result.stdout.trim() || "configured" : result.stderr.trim() || `${command} is unavailable or not configured`,
    };
  }
  const configPath = agent === "cursor"
    ? path.join(homeDirectory, ".cursor/mcp.json")
    : path.join(homeDirectory, ".config/opencode/opencode.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mcp = agent === "cursor" ? config.mcpServers : config.mcp;
    const direct = mcp && typeof mcp === "object" && !Array.isArray(mcp) ? mcp as Record<string, unknown> : {};
    const servers = direct.servers && typeof direct.servers === "object" && !Array.isArray(direct.servers)
      ? direct.servers as Record<string, unknown>
      : direct;
    return { configured: SERVER_NAME in servers, detail: configPath };
  } catch (error) {
    return { configured: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
