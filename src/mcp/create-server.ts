import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SourceService } from "../application/source-service.js";
import type { SourceWorker } from "../server/source-worker.js";
import type { AppDatabase } from "../storage/database.js";
import { getHealth } from "../application/get-health.js";
import { APP_VERSION } from "../version.js";

export interface McpBackend {
  health(): Record<string, unknown> | Promise<Record<string, unknown>>;
  indexSession(candidateId: string): Promise<Record<string, unknown>>;
  listSessions(input: { agent?: string; disposition?: "discovered" | "excluded" | "selected"; limit: number; offset: number }): Promise<Record<string, unknown>>;
  searchFragments(input: {
    agent?: string;
    contextProjectPath?: string;
    limit: number;
    mode?: "hybrid" | "keyword" | "semantic";
    projectPath?: string;
    query: string;
    sourceType?: "memory" | "session";
    updatedAfter?: string;
    updatedBefore?: string;
  }): Promise<Record<string, unknown>>;
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

export function createInProcessMcpBackend(
  database: AppDatabase,
  sources: SourceService,
  worker: SourceWorker,
): McpBackend {
  return {
    health: () => ({ ...getHealth(database), index: sources.getIndexStatus(), worker: worker.getStatus() }),
    indexSession: (candidateId) => worker.indexSession(candidateId),
    listSessions: (input) => sources.listSessions(input),
    searchFragments: (input) => sources.searchFragments(input),
  };
}

export function createMcpServer(backend: McpBackend): McpServer {
  const server = new McpServer({
    name: "agent-memory-share-mcp",
    version: APP_VERSION,
  });

  server.registerTool(
    "health",
    {
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Check local service, database, source worker, and derived index readiness.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await backend.health()),
        },
      ],
    }),
  );

  server.registerTool(
    "list_sessions",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "List local coding-agent sessions that satisfy the Agentic Stack Desktop persistent-import discovery and subagent filtering rules. Returns stable candidate ids and original source paths; it does not index session text.",
      inputSchema: {
        agent: z.enum(["claude-code", "codex", "cursor", "opencode"]).optional(),
        disposition: z.enum(["discovered", "excluded", "selected"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ agent, disposition, limit, offset }) => toolResult(await backend.listSessions({ agent, disposition, limit, offset })),
  );

  server.registerTool(
    "index_session",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Select and index one session candidate returned by list_sessions. Writes only derived local search data and never modifies the original session.",
      inputSchema: {
        candidateId: z.string().length(64),
      },
    },
    async ({ candidateId }) => toolResult(await backend.indexSession(candidateId)),
  );

  server.registerTool(
    "search_fragments",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Search explicitly indexed sessions and automatically indexed coding-agent memories. Defaults to hybrid retrieval, combining BM25 keyword and local semantic embedding rankings. Keyword and semantic modes are also available. Results include the original source path and source location so the caller can decide whether to read the source.",
      inputSchema: {
        agent: z.enum(["claude-code", "codex", "cursor", "opencode"]).optional(),
        contextProjectPath: z.string().max(4_096).optional().describe("Optional current project path used only as a ranking preference; it never filters out other projects."),
        limit: z.number().int().min(1).max(100).default(20),
        mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid"),
        projectPath: z.string().max(4_096).optional(),
        query: z.string().trim().min(1).max(300).describe("Describe one information need using concise natural language or keywords. Preserve important function names, paths, error codes, negation, comparisons, and temporal relationships; omit conversational filler and repeated background. Boolean operators and quotation syntax are unnecessary. Put explicit agent, project, source-type, and date constraints in the separate filter parameters."),
        sourceType: z.enum(["memory", "session"]).optional(),
        updatedAfter: z.string().datetime({ offset: true }).optional(),
        updatedBefore: z.string().datetime({ offset: true }).optional(),
      },
    },
    async ({ agent, contextProjectPath, limit, mode, projectPath, query, sourceType, updatedAfter, updatedBefore }) => toolResult(await backend.searchFragments({
      agent,
      contextProjectPath,
      limit,
      mode,
      projectPath,
      query,
      sourceType,
      updatedAfter,
      updatedBefore,
    })),
  );

  return server;
}
