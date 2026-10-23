import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { LocalApiClient } from "../client/local-api.js";
import { readDaemonConfig } from "../server/config.js";
import { getDataDirectory } from "../server/paths.js";
import { processIsRunning, readRuntime } from "../server/runtime-state.js";
import { createMcpServer, type McpBackend } from "./create-server.js";

export async function runStdioBridge(dataDirectoryOverride?: string): Promise<void> {
  const dataDirectory = getDataDirectory(dataDirectoryOverride);
  const runtime = readRuntime(dataDirectory);
  const address = runtime && processIsRunning(runtime.pid)
    ? { host: runtime.host, port: runtime.port }
    : readDaemonConfig(dataDirectory);
  const api = new LocalApiClient(address);
  const backend: McpBackend = {
    health: () => api.health(),
    indexSession: (candidateId) => api.indexSession(candidateId),
    listSessions: (input) => api.listSessions(input),
    searchFragments: (input) => api.search(input),
  };
  const server = createMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
