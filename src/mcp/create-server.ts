import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../storage/database.js";
import { getHealth } from "../application/get-health.js";

export function createMcpServer(database: AppDatabase): McpServer {
  const server = new McpServer({
    name: "agent-memory-share-mcp",
    version: "0.0.0",
  });

  server.registerTool(
    "health",
    {
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Check whether the local memory service and database are available.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(getHealth(database)),
        },
      ],
    }),
  );

  return server;
}
