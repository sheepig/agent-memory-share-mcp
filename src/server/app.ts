import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { getHealth } from "../application/get-health.js";
import { registerMcpHttp } from "../mcp/register-http.js";
import { openDatabase } from "../storage/database.js";

export interface BuildServerOptions {
  dataDirectory: string;
  logger?: boolean;
  publicDirectory?: string;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  const database = openDatabase(options.dataDirectory);

  app.addHook("onClose", async () => {
    database.close();
  });

  app.get("/api/health", async () => getHealth(database));
  registerMcpHttp(app, database);

  if (options.publicDirectory && fs.existsSync(path.join(options.publicDirectory, "index.html"))) {
    await app.register(fastifyStatic, {
      root: options.publicDirectory,
      wildcard: false,
    });
    app.get("/sessions", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/memories", async (_request, reply) => reply.sendFile("index.html"));
  }

  return app;
}
