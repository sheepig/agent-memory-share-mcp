import os from "node:os";
import path from "node:path";

export function getDataDirectory(override?: string): string {
  return override ?? process.env.AGENT_MEMORY_DATA_DIR ?? path.join(os.homedir(), ".agent-memory-share-mcp");
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
