import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance } from "fastify";

import { createInProcessMcpBackend, createMcpServer } from "./create-server.js";
import type { SourceService } from "../application/source-service.js";
import type { SourceWorker } from "../server/source-worker.js";
import type { AppDatabase } from "../storage/database.js";

export function registerMcpHttp(
  app: FastifyInstance,
  database: AppDatabase,
  sources: SourceService,
  worker: SourceWorker,
): void {
  app.post("/mcp", async (request, reply) => {
    const server = createMcpServer(createInProcessMcpBackend(database, sources, worker));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.route({
    handler: async (_request, reply) =>
      reply.code(405).send({
        error: { code: -32000, message: "Method not allowed." },
        id: null,
        jsonrpc: "2.0",
      }),
    method: ["GET", "DELETE"],
    url: "/mcp",
  });
}
