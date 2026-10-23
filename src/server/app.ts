import fs from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from "fastify";
import pino from "pino";
import { z, ZodError } from "zod";

import { getHealth } from "../application/get-health.js";
import { createSourceService } from "../application/source-service.js";
import { searchSettingsSchema } from "../contracts/search-settings.js";
import { SourceNotFoundError, SourceUnavailableError } from "../domain/source.js";
import { registerMcpHttp } from "../mcp/register-http.js";
import { LocalEmbeddingProvider, type EmbeddingProvider } from "../search/embedding.js";
import { LocalRerankerProvider, type RerankerProvider } from "../search/reranker.js";
import { openDatabase } from "../storage/database.js";
import { initializeDaemonConfig, readSearchSettings, updateSearchSettings } from "./config.js";
import { RotatingLogStream } from "./rotating-log.js";
import { createSourceWorker } from "./source-worker.js";

export interface BuildServerOptions {
  dataDirectory: string;
  embeddingProvider?: EmbeddingProvider;
  logger?: boolean;
  logFile?: string;
  homeDirectory?: string;
  instanceToken?: string;
  publicDirectory?: string;
  rerankerProvider?: RerankerProvider & { dispose?(): Promise<void> };
  scanIntervalMs?: number;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const loggerOptions = {
    level: "info",
    serializers: {
      req(request: { method?: string; remoteAddress?: string; url?: string }) {
        return {
          method: request.method,
          remoteAddress: request.remoteAddress,
          url: request.url?.split("?", 1)[0],
        };
      },
    },
  };
  const fastifyOptions: FastifyServerOptions = options.logFile
    ? { loggerInstance: pino(loggerOptions, new RotatingLogStream(options.logFile)) as unknown as FastifyBaseLogger }
    : { logger: options.logger === false ? false : loggerOptions };
  const app = Fastify(fastifyOptions);
  initializeDaemonConfig(options.dataDirectory);
  const database = openDatabase(options.dataDirectory);
  const embeddingProvider = options.embeddingProvider ?? new LocalEmbeddingProvider(path.join(options.dataDirectory, "models"));
  const reranker = options.rerankerProvider ?? new LocalRerankerProvider(path.join(options.dataDirectory, "models"));
  const sources = createSourceService(database, {
    embeddingProvider,
    homeDirectory: options.homeDirectory,
    isRerankerEnabled: () => readSearchSettings(options.dataDirectory).rerankerEnabled,
    reranker,
  });
  const worker = createSourceWorker(sources, { intervalMs: options.scanIntervalMs });

  app.addHook("onClose", async () => {
    await worker.stop();
    try {
      await reranker.dispose?.();
    } finally {
      database.close();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request.", issues: error.issues });
    }
    if (error instanceof SourceNotFoundError) {
      return reply.code(404).send({ error: error.message });
    }
    if (error instanceof SourceUnavailableError) {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  });

  app.get("/api/health", async () => getHealth(database));
  app.get("/api/config/search", async () => readSearchSettings(options.dataDirectory));
  app.patch("/api/config/search", async (request) =>
    updateSearchSettings(options.dataDirectory, searchSettingsSchema.parse(request.body)));
  if (options.instanceToken) {
    app.get("/api/daemon/identity", async () => ({ instanceToken: options.instanceToken, pid: process.pid }));
  }
  app.get("/api/sessions", async (request) => {
    const query = z.object({
      agent: z.enum(["claude-code", "codex", "cursor", "opencode"]).optional(),
      disposition: z.enum(["discovered", "excluded", "selected"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    return sources.listSessions(query);
  });
  app.get("/api/sessions/:candidateId", async (request) => {
    const { candidateId } = z.object({ candidateId: z.string().length(64) }).parse(request.params);
    return sources.getSessionConversation(candidateId);
  });
  app.post("/api/sessions/:candidateId/index", async (request) => {
    const { candidateId } = z.object({ candidateId: z.string().length(64) }).parse(request.params);
    return worker.indexSession(candidateId);
  });
  app.post("/api/sessions/:candidateId/exclude", async (request) => {
    const { candidateId } = z.object({ candidateId: z.string().length(64) }).parse(request.params);
    return worker.excludeSession(candidateId);
  });
  app.post("/api/sessions/:candidateId/restore", async (request) => {
    const { candidateId } = z.object({ candidateId: z.string().length(64) }).parse(request.params);
    return worker.restoreSession(candidateId);
  });
  app.get("/api/search", async (request) => {
    const query = z.object({
      agent: z.enum(["claude-code", "codex", "cursor", "opencode"]).optional(),
      contextProjectPath: z.string().max(4_096).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      mode: z.enum(["hybrid", "keyword", "semantic"]).default("keyword"),
      projectPath: z.string().max(4_096).optional(),
      query: z.string().trim().min(1).max(300),
      sourceType: z.enum(["memory", "session"]).optional(),
      updatedAfter: z.string().datetime({ offset: true }).optional(),
      updatedBefore: z.string().datetime({ offset: true }).optional(),
    }).parse(request.query);
    return sources.searchFragments(query);
  });
  app.get("/api/scan/status", async () => worker.getStatus());
  app.get("/api/index/status", async () => sources.getIndexStatus());
  app.post("/api/scan", async () => worker.scanNow());
  app.post("/api/rebuild", async () => worker.rebuild());
  app.post("/api/embeddings/retry", async () => worker.retryFailedEmbeddings());
  app.get("/api/diagnostics", async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      sourceId: z.string().length(64).optional(),
    }).parse(request.query);
    return sources.listDiagnostics(query);
  });
  registerMcpHttp(app, database, sources, worker);

  if (options.publicDirectory && fs.existsSync(path.join(options.publicDirectory, "index.html"))) {
    await app.register(fastifyStatic, {
      root: options.publicDirectory,
      wildcard: false,
    });
    app.get("/sessions", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/sessions/:candidateId", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/search", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/memories", async (_request, reply) => reply.redirect("/search"));
  }

  try {
    await worker.start();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
