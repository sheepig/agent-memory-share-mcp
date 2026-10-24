import fs from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { LocalApiClient } from "../client/local-api.js";
import { resolveDesktopSourcePaths, type DesktopSourcePaths } from "../sources/source-paths.js";
import { APP_VERSION } from "../version.js";
import { inspectAgentIntegration, type SupportedAgent } from "./agent-integration.js";

export interface DoctorCheck {
  detail: string;
  name: string;
  status: "fail" | "pass" | "warn";
}

const agents: SupportedAgent[] = ["codex", "claude-code", "cursor", "opencode"];

export async function runDoctor(options: {
  api: LocalApiClient;
  homeDirectory: string;
  mcpUrl: string;
  sources?: DesktopSourcePaths;
}): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [];
  try {
    const health = await options.api.health();
    checks.push({ detail: JSON.stringify(health), name: "daemon", status: "pass" });
  } catch (error) {
    checks.push({ detail: error instanceof Error ? error.message : String(error), name: "daemon", status: "fail" });
  }
  try {
    const client = new Client({ name: "agent-memory-doctor", version: APP_VERSION });
    await client.connect(new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
      requestInit: { signal: AbortSignal.timeout(3_000) },
    }));
    const tools = await client.listTools();
    await client.close();
    checks.push({ detail: `${tools.tools.length} tools available`, name: "mcp-handshake", status: "pass" });
  } catch (error) {
    checks.push({ detail: error instanceof Error ? error.message : String(error), name: "mcp-handshake", status: "fail" });
  }
  try {
    const status = await options.api.indexStatus();
    const embedding = status.embedding as Record<string, number> | undefined;
    const failed = embedding?.failed ?? 0;
    checks.push({
      detail: JSON.stringify(status),
      name: "index",
      status: failed > 0 ? "warn" : "pass",
    });
  } catch (error) {
    checks.push({ detail: error instanceof Error ? error.message : String(error), name: "index", status: "fail" });
  }
  const sourcePaths = resolveDesktopSourcePaths(options.homeDirectory, options.sources);
  const roots = [
    ...sourcePaths.codex.sessionRoots,
    ...sourcePaths.codex.memoryRoots,
    ...sourcePaths["claude-code"].projectRoots,
    ...(sourcePaths["claude-code"].memoryRoots ?? []),
    ...sourcePaths.cursor.sessionRoots,
    sourcePaths.opencode.databasePath,
  ];
  const availableRoots = [...new Set(roots)].filter((root) => fs.existsSync(root));
  checks.push({
    detail: availableRoots.length > 0 ? availableRoots.join(", ") : "No supported source locations found.",
    name: "source-locations",
    status: availableRoots.length > 0 ? "pass" : "warn",
  });
  for (const agent of agents) {
    const integration = inspectAgentIntegration(agent, { homeDirectory: options.homeDirectory });
    checks.push({
      detail: integration.detail,
      name: `integration:${agent}`,
      status: integration.configured ? "pass" : "warn",
    });
  }
  return { checks, ok: checks.every((check) => check.status !== "fail") };
}
