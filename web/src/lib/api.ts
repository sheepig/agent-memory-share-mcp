import { z } from "zod";

import { searchSettingsSchema, type SearchSettings } from "../../../src/contracts/search-settings.js";

const agentSchema = z.enum(["claude-code", "codex", "cursor", "opencode"]);

const healthSchema = z.object({
  database: z.literal("ok"),
  service: z.literal("agent-memory-share-mcp"),
  status: z.literal("ok"),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

const sessionSchema = z.object({
  agent: agentSchema,
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
  counts: z.object({ discovered: z.number().int().nonnegative(), excluded: z.number().int().nonnegative(), selected: z.number().int().nonnegative() }),
  sessions: z.array(sessionSchema),
  total: z.number().int().nonnegative(),
});

const sessionConversationSchema = z.object({
  messages: z.array(z.object({
    body: z.string(),
    location: z.string(),
    role: z.enum(["assistant", "user"]),
    timestamp: z.string().datetime().optional(),
  })),
  session: sessionSchema,
});

const searchResultSchema = z.object({
  agent: agentSchema,
  chunkIndex: z.number().int().nonnegative().optional(),
  contentFingerprint: z.string(),
  contentTokenCount: z.number().int().nonnegative().optional(),
  endLocation: z.string().optional(),
  endedAt: z.string().datetime().optional(),
  excerpt: z.string(),
  fragmentId: z.string(),
  location: z.string(),
  matchReason: z.string(),
  originalSessionId: z.string().optional(),
  projectPath: z.string().optional(),
  role: z.enum(["assistant", "user"]).optional(),
  sessionId: z.string().optional(),
  score: z.number().optional(),
  sourceId: z.string(),
  sourcePath: z.string(),
  sourceType: z.enum(["memory", "session"]),
  startedAt: z.string().datetime().optional(),
  title: z.string().optional(),
  turnCount: z.number().int().positive().optional(),
  updatedAt: z.string(),
});

const searchResultsSchema = z.object({ results: z.array(searchResultSchema) });
const indexedSessionSchema = z.object({
  candidateId: z.string(),
  fragmentCount: z.number().int().nonnegative(),
  sourcePath: z.string(),
});
const excludedSessionSchema = z.object({
  candidateId: z.string(),
  disposition: z.literal("excluded"),
});

export type Agent = z.infer<typeof agentSchema>;
export type SessionCandidate = z.infer<typeof sessionSchema>;
export type SessionConversation = z.infer<typeof sessionConversationSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;

const indexStatusSchema = z.object({
  activeScanCheckpoints: z.number().int().nonnegative(),
  embedding: z.record(z.string(), z.number().int().nonnegative()),
  embeddingModelId: z.string().optional(),
  fragments: z.number().int().nonnegative(),
  processing: z.record(z.string(), z.number().int().nonnegative()),
});

async function requestJson<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return schema.parse(payload);
}

export async function getHealth(): Promise<Health> {
  return requestJson("/api/health", healthSchema);
}

export async function getSearchSettings(): Promise<SearchSettings> {
  return requestJson("/api/config/search", searchSettingsSchema);
}

export async function updateSearchSettings(settings: SearchSettings): Promise<SearchSettings> {
  return requestJson("/api/config/search", searchSettingsSchema, {
    body: JSON.stringify(searchSettingsSchema.parse(settings)),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
}

export async function getIndexStatus() {
  return requestJson("/api/index/status", indexStatusSchema);
}

export async function retryEmbeddings() {
  return requestJson("/api/embeddings/retry", z.object({
    attempted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
  }), { method: "POST" });
}

export async function getSessions(input: {
  agent?: Agent;
  contextProjectPath?: string;
  disposition?: SessionCandidate["disposition"];
  limit?: number;
  offset?: number;
} = {}) {
  const query = new URLSearchParams();
  if (input.agent) query.set("agent", input.agent);
  if (input.contextProjectPath) query.set("contextProjectPath", input.contextProjectPath);
  if (input.disposition) query.set("disposition", input.disposition);
  query.set("limit", String(input.limit ?? 25));
  query.set("offset", String(input.offset ?? 0));
  return requestJson(`/api/sessions?${query}`, sessionsSchema);
}

export async function getSessionConversation(candidateId: string): Promise<SessionConversation> {
  return requestJson(`/api/sessions/${encodeURIComponent(candidateId)}`, sessionConversationSchema);
}

export async function indexSession(candidateId: string) {
  return requestJson(`/api/sessions/${encodeURIComponent(candidateId)}/index`, indexedSessionSchema, { method: "POST" });
}

export async function excludeSession(candidateId: string) {
  return requestJson(`/api/sessions/${encodeURIComponent(candidateId)}/exclude`, excludedSessionSchema, { method: "POST" });
}

export async function restoreSession(candidateId: string) {
  return requestJson(`/api/sessions/${encodeURIComponent(candidateId)}/restore`, indexedSessionSchema, { method: "POST" });
}

export async function searchFragments(input: {
  agent?: Agent;
  mode?: "hybrid" | "keyword" | "semantic";
  projectPath?: string;
  query: string;
  sourceType?: "memory" | "session";
  updatedAfter?: string;
  updatedBefore?: string;
}) {
  const query = new URLSearchParams({ limit: "50", query: input.query });
  if (input.agent) query.set("agent", input.agent);
  if (input.mode) query.set("mode", input.mode);
  if (input.projectPath) query.set("projectPath", input.projectPath);
  if (input.sourceType) query.set("sourceType", input.sourceType);
  if (input.updatedAfter) query.set("updatedAfter", input.updatedAfter);
  if (input.updatedBefore) query.set("updatedBefore", input.updatedBefore);
  return requestJson(`/api/search?${query}`, searchResultsSchema);
}
