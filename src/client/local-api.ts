import { z } from "zod";

import { searchSettingsSchema, type SearchSettings } from "../contracts/search-settings.js";

const sessionSchema = z.object({
  admissionReason: z.enum(["capacity", "oversized"]).optional(),
  agent: z.string(),
  candidateId: z.string(),
  disposition: z.enum(["discovered", "excluded", "selected"]),
  indexStatus: z.enum(["discovered", "failed", "indexed", "indexing", "source_changed", "source_unavailable"]),
  projectPath: z.string().optional(),
  sessionId: z.string(),
  sourcePath: z.string(),
  title: z.string().optional(),
  updatedAt: z.string(),
});

const sessionsSchema = z.object({
  counts: z.object({ discovered: z.number(), excluded: z.number(), selected: z.number() }),
  sessions: z.array(sessionSchema),
  total: z.number(),
});
const searchSchema = z.object({ results: z.array(z.record(z.string(), z.unknown())) });
const objectSchema = z.record(z.string(), z.unknown());

export interface LocalApiOptions {
  host: string;
  port: number;
}

export class LocalApiClient {
  private readonly baseUrl: string;

  constructor(options: LocalApiOptions) {
    const host = options.host === "::1" ? "[::1]" : options.host;
    this.baseUrl = `http://${host}:${options.port}`;
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/health", objectSchema);
  }

  updateSearchSettings(settings: SearchSettings): Promise<SearchSettings> {
    return this.request("PATCH", "/api/config/search", searchSettingsSchema, searchSettingsSchema.parse(settings));
  }

  listSessions(input: { agent?: string; disposition?: "discovered" | "excluded" | "selected"; limit?: number; offset?: number } = {}) {
    const query = new URLSearchParams();
    if (input.agent) query.set("agent", input.agent);
    if (input.disposition) query.set("disposition", input.disposition);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.offset !== undefined) query.set("offset", String(input.offset));
    return this.request("GET", `/api/sessions?${query}`, sessionsSchema);
  }

  indexSession(candidateId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(candidateId)}/index`, objectSchema);
  }

  excludeSession(candidateId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(candidateId)}/exclude`, objectSchema);
  }

  restoreSession(candidateId: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(candidateId)}/restore`, objectSchema);
  }

  scan(): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/scan", objectSchema);
  }

  rebuild(): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/rebuild", objectSchema);
  }

  indexStatus(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/index/status", objectSchema);
  }

  retryEmbeddings(): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/embeddings/retry", objectSchema);
  }

  diagnostics(input: { limit?: number; sourceId?: string } = {}): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.sourceId) query.set("sourceId", input.sourceId);
    return this.request("GET", `/api/diagnostics?${query}`, objectSchema);
  }

  search(input: {
    agent?: string;
    excludeAgent?: "claude-code" | "codex" | "cursor" | "opencode";
    contextProjectPath?: string;
    limit?: number;
    mode?: "hybrid" | "keyword" | "semantic";
    projectPath?: string;
    query: string;
    sourceType?: "memory" | "session";
    updatedAfter?: string;
    updatedBefore?: string;
  }) {
    const query = new URLSearchParams({ query: input.query });
    if (input.agent) query.set("agent", input.agent);
    if (input.excludeAgent) query.set("excludeAgent", input.excludeAgent);
    if (input.contextProjectPath) query.set("contextProjectPath", input.contextProjectPath);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.mode) query.set("mode", input.mode);
    if (input.projectPath) query.set("projectPath", input.projectPath);
    if (input.sourceType) query.set("sourceType", input.sourceType);
    if (input.updatedAfter) query.set("updatedAfter", input.updatedAfter);
    if (input.updatedBefore) query.set("updatedBefore", input.updatedBefore);
    return this.request("GET", `/api/search?${query}`, searchSchema, undefined, 300_000);
  }

  private async request<T>(method: "GET" | "PATCH" | "POST", route: string, schema: z.ZodType<T>, payload?: unknown, timeoutMs = 30_000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${route}`, {
        body: payload === undefined ? undefined : JSON.stringify(payload),
        headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
        method,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`Local daemon is unavailable at ${this.baseUrl}.`, { cause: error });
    }
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return schema.parse(body);
  }
}
