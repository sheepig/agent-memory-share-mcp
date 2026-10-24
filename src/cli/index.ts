#!/usr/bin/env node

import { Command, InvalidArgumentError, Option } from "commander";
import os from "node:os";
import { z } from "zod";

import { LocalApiClient } from "../client/local-api.js";
import { connectAgent, disconnectAgent, type SupportedAgent } from "./agent-integration.js";
import { runDoctor } from "./doctor.js";
import { registerEvaluationCommands } from "./evaluation.js";
import { runStdioBridge } from "../mcp/stdio-bridge.js";
import {
  initializeDaemonConfig,
  readDaemonConfig,
  writeDaemonConfig,
  type DaemonConfig,
} from "../server/config.js";
import { getDaemonStatus, readDaemonLogs, startDaemon, stopDaemon } from "../server/daemon-control.js";
import { createFileLogger, type FileLogger } from "../server/file-logger.js";
import { getDataDirectory } from "../server/paths.js";
import { logPath, processIsRunning, readRuntime } from "../server/runtime-state.js";
import { startServer } from "../server/start.js";
import { APP_VERSION } from "../version.js";

let daemonLogger: FileLogger | undefined;

const agents = ["claude-code", "codex", "cursor", "opencode"] as const;

function parseInteger(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new InvalidArgumentError(`value must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function parseAgent(value: string): typeof agents[number] {
  if (!agents.includes(value as typeof agents[number])) {
    throw new InvalidArgumentError(`agent must be one of ${agents.join(", ")}`);
  }
  return value as typeof agents[number];
}

function parseSourceType(value: string): "memory" | "session" {
  if (value !== "memory" && value !== "session") {
    throw new InvalidArgumentError("source type must be memory or session");
  }
  return value;
}

function parseSearchMode(value: string): "hybrid" | "keyword" | "semantic" {
  if (value !== "hybrid" && value !== "keyword" && value !== "semantic") {
    throw new InvalidArgumentError("search mode must be keyword, semantic, or hybrid");
  }
  return value;
}

function parseIsoDate(value: string): string {
  if (!z.string().datetime({ offset: true }).safeParse(value).success) {
    throw new InvalidArgumentError("date must be an ISO 8601 timestamp");
  }
  return value;
}

function context(command: Command) {
  const options = command.optsWithGlobals<{ dataDir?: string; json?: boolean }>();
  const dataDirectory = getDataDirectory(options.dataDir);
  const config = readDaemonConfig(dataDirectory);
  const runtime = readRuntime(dataDirectory);
  const apiAddress = runtime && processIsRunning(runtime.pid)
    ? { host: runtime.host, port: runtime.port }
    : config;
  return {
    api: new LocalApiClient(apiAddress),
    apiAddress,
    config,
    dataDirectory,
    json: options.json ?? false,
  };
}

function mcpUrl(config: { host: string; port: number }): string {
  return `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}/mcp`;
}

function output(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function updateConfigValue(config: DaemonConfig, key: string, value: string): DaemonConfig {
  if (key === "host") return { ...config, host: value };
  if (key === "port") return { ...config, port: parseInteger(value, 1, 65_535) };
  if (key === "scanIntervalSeconds") return { ...config, scanIntervalSeconds: parseInteger(value, 0) };
  if (key === "rerankerEnabled") {
    if (value !== "true" && value !== "false") throw new InvalidArgumentError("rerankerEnabled must be true or false");
    return { ...config, rerankerEnabled: value === "true" };
  }
  if (key.startsWith("sessionFragmentLimits.")) {
    const agent = parseAgent(key.slice("sessionFragmentLimits.".length));
    return { ...config, sessionFragmentLimits: { ...config.sessionFragmentLimits, [agent]: parseInteger(value, 1) } };
  }
  throw new InvalidArgumentError("key must be host, port, scanIntervalSeconds, rerankerEnabled, or sessionFragmentLimits.<agent>");
}

const program = new Command()
  .name("agent-memory")
  .description("Local-first search service for coding-agent sessions and memories.")
  .version(APP_VERSION)
  .option("--data-dir <path>", "application data directory")
  .option("--json", "emit stable JSON output");

program.hook("preAction", async (_program, command) => {
  if (command.name() === "serve" && command.opts().daemonChild) {
    const dataDirectory = getDataDirectory(command.optsWithGlobals<{ dataDir?: string }>().dataDir);
    daemonLogger = await createFileLogger(logPath(dataDirectory));
    process.once("beforeExit", () => { void daemonLogger?.close(); });
  }
});

program.command("init")
  .description("Initialize the local application configuration.")
  .action((_options, command) => {
    const current = context(command);
    output({ config: initializeDaemonConfig(current.dataDirectory), dataDirectory: current.dataDirectory }, current.json);
  });

program.command("start")
  .description("Start the local background service and show its MCP URL and Agent connection instructions.")
  .option("--source-home <path>", "override the Agent source home directory")
  .action(async (options: { sourceHome?: string }, command) => {
    const current = context(command);
    const status = await startDaemon(current.config, current.dataDirectory, { sourceHome: options.sourceHome });
    const webUrl = status.mcpUrl?.replace(/\/mcp$/, "/");
    output(current.json ? { ...status, webUrl } : [
      status.alreadyRunning ? "Local MCP service is already running." : "Local MCP service started.",
      `MCP: ${status.mcpUrl}`,
      `Web: ${webUrl}`,
      "Connect Codex: agent-memory connect codex",
      "Stop: agent-memory daemon stop",
    ].join("\n"), current.json);
  });

program.command("serve")
  .description("Run the local HTTP, MCP, and web server in the foreground.")
  .option("--host <host>", "loopback host")
  .option("--port <port>", "listening port", (value) => parseInteger(value, 1, 65_535))
  .option("--source-home <path>", "override the Agent source home directory")
  .option("--scan-interval <seconds>", "source scan interval; 0 disables periodic scans", (value) => parseInteger(value, 0))
  .addOption(new Option("--daemon-child").hideHelp())
  .action(async (options: { daemonChild?: boolean; host?: string; port?: number; scanInterval?: number; sourceHome?: string }, command) => {
    const current = context(command);
    const result = await startServer({
      dataDirectory: current.dataDirectory,
      host: options.host ?? current.config.host,
      homeDirectory: options.sourceHome,
      loggerInstance: daemonLogger?.logger,
      port: options.port ?? current.config.port,
      scanIntervalMs: (options.scanInterval ?? current.config.scanIntervalSeconds) * 1_000,
      writeLogs: options.daemonChild || current.json,
    });
    if (current.json || result.alreadyRunning) output(result, current.json);
  });

const daemon = program.command("daemon").description("Manage the background daemon.");
daemon.command("start").option("--source-home <path>", "override the Agent source home directory").action(async (options: { sourceHome?: string }, command) => {
  const current = context(command);
  output(await startDaemon(current.config, current.dataDirectory, { sourceHome: options.sourceHome }), current.json);
});
daemon.command("stop").action(async (_options, command) => {
  const current = context(command);
  output(await stopDaemon(current.dataDirectory), current.json);
});
daemon.command("status").action(async (_options, command) => {
  const current = context(command);
  output(await getDaemonStatus(current.dataDirectory), current.json);
});
daemon.command("logs")
  .option("--lines <count>", "number of lines", (value) => parseInteger(value, 1, 10_000), 100)
  .action((options: { lines: number }, command) => {
    const current = context(command);
    const result = readDaemonLogs(current.dataDirectory, options.lines);
    output(current.json ? result : result.lines.join("\n"), current.json);
  });

program.command("scan").description("Run a source scan now.").action(async (_options, command) => {
  const current = context(command);
  output(await current.api.scan(), current.json);
});
program.command("rebuild").description("Rebuild all selected derived indexes.").action(async (_options, command) => {
  const current = context(command);
  output(await current.api.rebuild(), current.json);
});

program.command("doctor").description("Check daemon, MCP, index, source, and Agent integration readiness.").action(async (_options, command) => {
  const current = context(command);
  const result = await runDoctor({ api: current.api, homeDirectory: os.homedir(), mcpUrl: mcpUrl(current.apiAddress), sources: current.config.sources });
  output(result, current.json);
  if (!result.ok) process.exitCode = 1;
});

program.command("connect <agent>")
  .description("Configure a supported Agent to use this daemon's MCP endpoint.")
  .action((agentValue: string, _options, command) => {
    const current = context(command);
    const agent = parseAgent(agentValue) as SupportedAgent;
    output(connectAgent(agent, mcpUrl(current.apiAddress), { homeDirectory: os.homedir() }), current.json);
  });

program.command("disconnect <agent>")
  .description("Remove this daemon from a supported Agent's MCP configuration.")
  .action((agentValue: string, _options, command) => {
    const current = context(command);
    output(disconnectAgent(parseAgent(agentValue) as SupportedAgent, { homeDirectory: os.homedir() }), current.json);
  });

const index = program.command("index").description("Inspect derived index readiness.");
index.command("status").action(async (_options, command) => {
  const current = context(command);
  output(await current.api.indexStatus(), current.json);
});

const embeddings = program.command("embeddings").description("Manage semantic-search embeddings.");
embeddings.command("retry").description("Retry only sources with failed embeddings.").action(async (_options, command) => {
  const current = context(command);
  output(await current.api.retryEmbeddings(), current.json);
});

const sessions = program.command("sessions").description("List and manage discovered sessions.");
sessions.command("list")
  .option("--agent <agent>", "agent filter", parseAgent)
  .option("--limit <count>", "result limit", (value) => parseInteger(value, 1, 200), 50)
  .option("--offset <count>", "result offset", (value) => parseInteger(value, 0), 0)
  .action(async (options: { agent?: string; limit: number; offset: number }, command) => {
    const current = context(command);
    output(await current.api.listSessions(options), current.json);
  });
sessions.command("index <candidateId>").action(async (candidateId: string, _options, command) => {
  const current = context(command);
  output(await current.api.indexSession(candidateId), current.json);
});
sessions.command("exclude <candidateId>").action(async (candidateId: string, _options, command) => {
  const current = context(command);
  output(await current.api.excludeSession(candidateId), current.json);
});
sessions.command("restore <candidateId>").action(async (candidateId: string, _options, command) => {
  const current = context(command);
  output(await current.api.restoreSession(candidateId), current.json);
});

program.command("search <query>")
  .description("Search selected sessions and agent memories.")
  .option("--agent <agent>", "agent filter", parseAgent)
  .option("--exclude-agent <agent>", "exclude this agent's memories and sessions: claude-code, codex, cursor, opencode", parseAgent)
  .option("--limit <count>", "result limit", (value) => parseInteger(value, 1, 100), 20)
  .option("--mode <mode>", "keyword, semantic, or hybrid", parseSearchMode, "keyword")
  .option("--context-project-path <path>", "project path used only as a ranking preference")
  .option("--project-path <path>", "exact project path")
  .option("--source-type <type>", "memory or session", parseSourceType)
  .option("--updated-after <iso-date>", "inclusive source update lower bound", parseIsoDate)
  .option("--updated-before <iso-date>", "inclusive source update upper bound", parseIsoDate)
  .action(async (query: string, options: Record<string, unknown>, command: Command) => {
    const current = context(command);
    output(await current.api.search({ ...options, query } as Parameters<LocalApiClient["search"]>[0]), current.json);
  });

program.command("diagnostics")
  .option("--limit <count>", "result limit", (value) => parseInteger(value, 1, 200), 50)
  .option("--source-id <id>", "source id")
  .action(async (options: { limit: number; sourceId?: string }, command) => {
    const current = context(command);
    output(await current.api.diagnostics(options), current.json);
  });

const config = program.command("config").description("Read or update daemon configuration.");
config.command("get").action((_options, command) => {
  const current = context(command);
  output(current.config, current.json);
});
config.command("set <key> <value>").action(async (key: string, value: string, _options, command) => {
  const current = context(command);
  const next = updateConfigValue(current.config, key, value);
  const runtime = readRuntime(current.dataDirectory);
  if (key === "rerankerEnabled" && runtime && processIsRunning(runtime.pid)) {
    await current.api.updateSearchSettings({ rerankerEnabled: next.rerankerEnabled });
    output(readDaemonConfig(current.dataDirectory), current.json);
  } else {
    output(writeDaemonConfig(current.dataDirectory, next), current.json);
  }
});

registerEvaluationCommands(program, output);

program.command("mcp-stdio")
  .description("Run an MCP stdio bridge to the local daemon.")
  .action(async (_options, command) => {
    const current = context(command);
    await runStdioBridge(current.dataDirectory);
  });

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (daemonLogger) {
    daemonLogger.logger.error({ err: error }, "Daemon startup failed.");
    await daemonLogger.close();
  } else if (process.argv.includes("--json") && !process.argv.includes("mcp-stdio")) {
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exitCode = 1;
}
