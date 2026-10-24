import { createHash, randomUUID } from "node:crypto";
import os from "node:os";

import type {
  EmbeddingState,
  FragmentSearchResult,
  IndexDocument,
  SearchMode,
  SessionCandidate,
  SessionConversation,
  SourceReference,
  SourceType,
} from "../domain/source.js";
import { SourceNotFoundError, SourceUnavailableError } from "../domain/source.js";
import { normalizeSearchText } from "../search/normalize.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { FragmentSearch, type FragmentSearchCandidate } from "../search/fragment-search.js";
import type { RerankerProvider } from "../search/reranker.js";
import { buildSearchTerms } from "../search/tokens.js";
import { SENSITIVE_CONTENT_RULE_VERSION } from "../security/sensitive-content.js";
import { createDesktopAdapters } from "../sources/desktop-sources.js";
import type { SessionSourceAdapter, SourceAdapter, SourceDiagnostic, SourceDiscoveryStep } from "../sources/source-adapter.js";
import type { ContentTokenCounter } from "../sources/session-turns.js";
import type { AppDatabase } from "../storage/database.js";
import { discoveryCache } from "./discovery-cache.js";
import { EmbeddingIndexer, embeddingInput } from "./embedding-indexer.js";
import { SessionCapacity } from "./session-capacity.js";

export const INDEX_RULE_VERSION = 12;

interface SourceRow {
  agent: string;
  content_fingerprint: string;
  disposition: "discovered" | "excluded" | "selected";
  embedding_error: string | null;
  embedding_model_id: string | null;
  embedding_state: EmbeddingState;
  error_message: string | null;
  external_source_id: string;
  id: string;
  indexed_fingerprint: string | null;
  explicit_metadata_json: string | null;
  original_session_id: string | null;
  processing_state: SessionCandidate["indexStatus"];
  project_path: string | null;
  source_path: string;
  source_type: SourceType;
  source_updated_at: string;
  security_rule_version: number;
  title: string | null;
  admission_reason: "capacity" | "oversized" | null;
  session_fragment_count: number | null;
  retry_after: string | null;
  last_seen_scan_id: string | null;
}

export interface ListSessionsInput {
  agent?: string;
  disposition?: "discovered" | "excluded" | "selected";
  limit: number;
  offset: number;
}

export interface SearchFragmentsInput {
  agent?: string;
  excludeAgent?: "claude-code" | "codex" | "cursor" | "opencode";
  limit: number;
  mode?: SearchMode;
  contextProjectPath?: string;
  projectPath?: string;
  query: string;
  sourceType?: SourceType;
  updatedAfter?: string;
  updatedBefore?: string;
}

export interface SourceScanResult {
  failed: number;
  indexed: number;
  memories: number;
  sessions: number;
  unavailable: number;
}

export type SessionIndexResult = {
  candidateId: string;
  fragmentCount: number;
  sourcePath: string;
  disposition?: SessionCandidate["disposition"];
  admissionReason?: SessionCandidate["admissionReason"];
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function databaseId(source: SourceReference): string {
  return digest(`${source.sourceType}\0${source.agent}\0${source.sourceId}`);
}

function rowToReference(row: SourceRow): SourceReference {
  return {
    agent: row.agent,
    contentFingerprint: row.content_fingerprint,
    metadata: row.explicit_metadata_json
      ? JSON.parse(row.explicit_metadata_json) as Record<string, string | string[]>
      : undefined,
    originalSessionId: row.original_session_id ?? undefined,
    projectPath: row.project_path ?? undefined,
    sourceId: row.external_source_id,
    sourcePath: row.source_path,
    sourceType: row.source_type,
    title: row.title ?? undefined,
    updatedAt: new Date(row.source_updated_at),
  };
}

function rowToSessionCandidate(row: SourceRow): SessionCandidate {
  return {
    admissionReason: row.admission_reason ?? undefined,
    agent: row.agent,
    candidateId: row.id,
    disposition: row.disposition,
    indexStatus: row.processing_state,
    projectPath: row.project_path ?? undefined,
    sessionId: row.external_source_id,
    sourcePath: row.source_path,
    title: row.title ?? undefined,
    updatedAt: row.source_updated_at,
  };
}

export class SourceService {
  private firstScan = true;
  private scanStartedAt = "";
  private readonly memoryAdapters: SourceAdapter[];
  private readonly sessionAdapters: SessionSourceAdapter[];

  constructor(
    private readonly database: AppDatabase,
    options: {
      adapters?: { memories: SourceAdapter[]; sessions: SessionSourceAdapter[] };
      contentTokenCounter?: ContentTokenCounter;
      embeddingProvider?: EmbeddingProvider;
      homeDirectory: string;
      reranker?: RerankerProvider;
      isRerankerEnabled?: () => boolean;
      rerankCandidateCount?: number;
      sessionFragmentLimits?: Readonly<Record<string, number>>;
    },
  ) {
    const contentTokenCounter = options.contentTokenCounter ?? options.embeddingProvider;
    if (!options.adapters && !contentTokenCounter) {
      throw new Error("A content token counter is required for Session chunking.");
    }
    const adapters = options.adapters ?? createDesktopAdapters(options.homeDirectory, contentTokenCounter!);
    this.memoryAdapters = adapters.memories;
    this.sessionAdapters = adapters.sessions;
    this.embeddingProvider = options.embeddingProvider;
    this.embeddings = new EmbeddingIndexer(database, options.embeddingProvider);
    this.capacity = new SessionCapacity(database, options.sessionFragmentLimits ?? {});
    this.fragmentSearch = new FragmentSearch(database, options);
  }

  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly fragmentSearch: FragmentSearch;
  private readonly embeddings: EmbeddingIndexer;
  private readonly capacity: SessionCapacity;

  async listSessions(input: ListSessionsInput): Promise<{
    counts: Record<"discovered" | "excluded" | "selected", number>;
    sessions: SessionCandidate[];
    total: number;
  }> {
    const filters = ["source_type = 'session'", "NOT (disposition = 'discovered' AND processing_state = 'source_unavailable')"];
    const values: unknown[] = [];
    if (input.agent) {
      filters.push("agent = ?");
      values.push(input.agent);
    }
    const countRows = this.database.prepare(`
      SELECT disposition, count(*) AS count FROM sources
      WHERE ${filters.join(" AND ")}
      GROUP BY disposition
    `).all(...values) as Array<{ count: number; disposition: "discovered" | "excluded" | "selected" }>;
    const counts = { discovered: 0, excluded: 0, selected: 0 };
    for (const row of countRows) counts[row.disposition] = row.count;
    if (input.disposition) {
      filters.push("disposition = ?");
      values.push(input.disposition);
    }
    const where = filters.join(" AND ");
    const total = (this.database.prepare(`SELECT count(*) AS count FROM sources WHERE ${where}`).get(...values) as { count: number }).count;
    const rows = this.database.prepare(`
      SELECT * FROM sources
      WHERE ${where}
      ORDER BY source_updated_at DESC, id
      LIMIT ? OFFSET ?
    `).all(...values, input.limit, input.offset) as SourceRow[];
    return {
      counts,
      sessions: rows.map(rowToSessionCandidate),
      total,
    };
  }

  async getSessionConversation(candidateId: string): Promise<SessionConversation> {
    let row = this.getSource(candidateId);
    if (!row || row.source_type !== "session") {
      throw new SourceNotFoundError();
    }
    if (row.processing_state === "source_unavailable") {
      throw new SourceUnavailableError("The session source is no longer available.");
    }
    const agent = row.agent;
    const adapter = this.sessionAdapters.find((candidate) => candidate.agent === agent);
    if (!adapter) {
      throw new Error(`No session adapter is registered for ${row.agent}.`);
    }
    const messages: SessionConversation["messages"] = [];
    for await (const message of adapter.readConversation(rowToReference(row))) {
      if (message.body.trim()) {
        messages.push(message);
      }
    }
    return { messages, session: rowToSessionCandidate(row) };
  }

  async indexSession(candidateId: string, generateEmbeddings = true): Promise<SessionIndexResult> {
    let row = this.getSource(candidateId);
    if (!row || row.source_type !== "session") {
      throw new SourceNotFoundError("Unknown session candidate. Use an id returned by list_sessions.");
    }
    if (row.disposition === "excluded") throw new SourceUnavailableError("Restore the excluded Session before indexing it.");
    const agent = row.agent;
    const adapter = this.sessionAdapters.find((candidate) => candidate.agent === agent);
    if (!adapter) {
      throw new Error(`No session adapter is registered for ${row.agent}.`);
    }
    row = await this.refreshSource(row, adapter);
    if (row.processing_state === "indexed" && row.indexed_fingerprint === row.content_fingerprint) {
      const fragmentCount = (this.database.prepare("SELECT count(*) AS count FROM fragments WHERE source_id = ?").get(row.id) as { count: number }).count;
      return { candidateId, fragmentCount, sourcePath: row.source_path, disposition: row.disposition, admissionReason: row.admission_reason ?? undefined };
    }
    const fragmentCount = await this.indexSource(row, adapter, "selected", generateEmbeddings);
    const current = this.getSource(candidateId)!;
    return { candidateId, fragmentCount, sourcePath: row.source_path, disposition: current.disposition, admissionReason: current.admission_reason ?? undefined };
  }

  excludeSession(candidateId: string): { candidateId: string; disposition: "excluded" } {
    const row = this.getSource(candidateId);
    if (!row || row.source_type !== "session") {
      throw new SourceNotFoundError();
    }
    if (row.disposition === "excluded") {
      return { candidateId, disposition: "excluded" };
    }
    this.database.transaction(() => {
      this.capacity.removeFragments(row.id);
      this.database.prepare(`
        UPDATE sources
        SET disposition = 'excluded', processing_state = CASE
          WHEN processing_state = 'source_unavailable' THEN 'source_unavailable'
          ELSE 'discovered'
        END, indexed_fingerprint = NULL, error_message = NULL, admission_reason = NULL, retry_after = NULL,
        embedding_state = 'disabled', embedding_model_id = NULL, embedding_error = NULL
        WHERE id = ?
      `).run(row.id);
      this.database.prepare("INSERT INTO source_audit (source_id, action, created_at) VALUES (?, 'excluded', ?)")
        .run(row.id, new Date().toISOString());
    })();
    return { candidateId, disposition: "excluded" };
  }

  async restoreSession(candidateId: string, generateEmbeddings = true): Promise<SessionIndexResult> {
    const row = this.getSource(candidateId);
    if (!row || row.source_type !== "session") {
      throw new SourceNotFoundError();
    }
    const adapter = this.sessionAdapters.find((candidate) => candidate.agent === row.agent);
    if (!adapter) throw new SourceUnavailableError("No adapter is available for this Session.");
    await this.refreshSource(row, adapter);
    this.database.prepare("UPDATE sources SET disposition = 'discovered', processing_state = 'source_changed', retry_after = NULL WHERE id = ?").run(row.id);
    this.database.prepare("INSERT INTO source_audit (source_id, action, created_at) VALUES (?, 'restored', ?)")
      .run(row.id, new Date().toISOString());
    return this.indexSession(candidateId, generateEmbeddings);
  }

  listDiagnostics(input: { limit: number; sourceId?: string }): { diagnostics: Array<Record<string, unknown>> } {
    const filters: string[] = [];
    const values: unknown[] = [];
    if (input.sourceId) {
      filters.push("source_id = ?");
      values.push(input.sourceId);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT id, source_id AS sourceId, source_path AS sourcePath, level, code, message,
             occurrence_count AS occurrenceCount, last_seen_at AS lastSeenAt,
             resolved_at AS resolvedAt, created_at AS createdAt
      FROM scan_diagnostics
      ${where}
      ORDER BY id DESC
      LIMIT ?
    `).all(...values, input.limit) as Array<Record<string, unknown>>;
    return { diagnostics: rows };
  }

  getIndexStatus(): Record<string, unknown> {
    const processingRows = this.database.prepare("SELECT processing_state AS state, count(*) AS count FROM sources GROUP BY processing_state")
      .all() as Array<{ count: number; state: string }>;
    const embeddingRows = this.database.prepare("SELECT embedding_state AS state, count(*) AS count FROM sources GROUP BY embedding_state")
      .all() as Array<{ count: number; state: string }>;
    const fragments = (this.database.prepare("SELECT count(*) AS count FROM fragments").get() as { count: number }).count;
    const checkpoints = (this.database.prepare("SELECT count(*) AS count FROM scan_checkpoints").get() as { count: number }).count;
    return {
      activeScanCheckpoints: checkpoints,
      embedding: Object.fromEntries(embeddingRows.map((row) => [row.state, row.count])),
      embeddingModelId: this.embeddingProvider?.modelId,
      fragments,
      processing: Object.fromEntries(processingRows.map((row) => [row.state, row.count])),
      sessionCapacity: this.capacity.status(),
    };
  }

  async retryFailedEmbeddings(generateEmbeddings = true): Promise<{ attempted: number; failed: number; indexed: number }> {
    if (!this.embeddingProvider) throw new Error("Embedding search is not configured.");
    const rows = this.database.prepare(`
      SELECT id FROM sources WHERE embedding_state = 'failed' AND processing_state = 'indexed'
    `).all() as Array<{ id: string }>;
    let indexed = 0;
    if (!generateEmbeddings) {
      this.database.prepare("UPDATE sources SET retry_after = NULL, embedding_state = 'pending' WHERE embedding_state = 'failed' AND processing_state = 'indexed'").run();
      return { attempted: rows.length, failed: 0, indexed: 0 };
    }
    for (const row of rows) {
      await this.ensureEmbeddings(row.id);
      const state = (this.database.prepare("SELECT embedding_state AS state FROM sources WHERE id = ?").get(row.id) as { state: string }).state;
      if (state === "indexed") indexed += 1;
    }
    return { attempted: rows.length, failed: rows.length - indexed, indexed };
  }

  prepareRebuild(): number {
    const sourceIds = this.database.prepare(`
      SELECT id FROM sources
      WHERE disposition = 'selected' AND processing_state <> 'source_unavailable'
    `).all() as Array<{ id: string }>;
    const rebuild = this.database.transaction(() => {
      const update = this.database.prepare(`
        UPDATE sources SET processing_state = 'source_changed', indexed_fingerprint = NULL WHERE id = ?
      `);
      const audit = this.database.prepare(`
        INSERT INTO source_audit (source_id, action, created_at) VALUES (?, 'rebuild_requested', ?)
      `);
      const now = new Date().toISOString();
      for (const source of sourceIds) {
        update.run(source.id);
        audit.run(source.id, now);
      }
    });
    rebuild();
    return sourceIds.length;
  }

  async searchFragments(input: SearchFragmentsInput): Promise<{ results: FragmentSearchResult[] }> {
    return this.fragmentSearch.search(input);
  }

  async searchCandidates(input: SearchFragmentsInput, candidateCount: number): Promise<FragmentSearchCandidate[]> {
    return this.fragmentSearch.retrieveCandidates(input, candidateCount);
  }

  recoverInterrupted(): number {
    const rows = this.database.prepare("SELECT id FROM sources WHERE processing_state = 'indexing'").all() as Array<{ id: string }>;
    if (rows.length === 0) {
      return 0;
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const update = this.database.prepare(`
        UPDATE sources
        SET processing_state = CASE WHEN disposition = 'selected' THEN 'source_changed' ELSE 'failed' END,
            error_message = 'Indexing was interrupted by daemon shutdown.'
        WHERE id = ?
      `);
      const diagnostic = this.database.prepare(`
        INSERT INTO scan_diagnostics (source_id, level, code, message, created_at)
        VALUES (?, 'warning', 'index_interrupted', 'Indexing was interrupted and will be retried.', ?)
      `);
      const audit = this.database.prepare("INSERT INTO source_audit (source_id, action, created_at) VALUES (?, 'index_interrupted', ?)");
      for (const row of rows) {
        update.run(row.id);
        diagnostic.run(row.id, now);
        audit.run(row.id, now);
      }
    })();
    return rows.length;
  }

  async scanSources(): Promise<SourceScanResult> {
    const steps = this.scanSteps();
    for (;;) {
      const step = await steps.next();
      if (step.done) return step.value;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async *scanSteps(): AsyncGenerator<SourceScanResult, SourceScanResult> {
    this.scanStartedAt = new Date().toISOString();
    const result: SourceScanResult = { failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 };
    if (this.firstScan) {
      this.database.prepare("UPDATE sources SET retry_after = NULL WHERE processing_state = 'failed' OR embedding_state = 'failed'").run();
      this.firstScan = false;
    }
    const adapters = [...this.sessionAdapters, ...this.memoryAdapters];
    const activeKeys = new Set(adapters.map((adapter) => adapter.key));
    for (const row of this.database.prepare("SELECT adapter_key FROM scan_checkpoints").all() as Array<{ adapter_key: string }>) {
      if (!activeKeys.has(row.adapter_key)) this.database.prepare("DELETE FROM scan_checkpoints WHERE adapter_key = ?").run(row.adapter_key);
    }
    for (const _step of this.capacity.trimSteps()) yield result;
    const jobs = adapters.map((adapter) => {
      const checkpoint = this.beginAdapterScan(adapter.key);
      const sourceType: SourceType = this.sessionAdapters.includes(adapter as SessionSourceAdapter) ? "session" : "memory";
      const cache = discoveryCache(this.database, adapter.key, `${INDEX_RULE_VERSION}:${SENSITIVE_CONTENT_RULE_VERSION}`, this.scanStartedAt);
      const options = { after: checkpoint.cursor, cache };
      const iterator = adapter.discoverSteps ? adapter.discoverSteps(options)[Symbol.asyncIterator]()
        : (async function* (): AsyncGenerator<SourceDiscoveryStep> {
          for await (const source of adapter.discover(options)) yield { source, cursor: source.discoveryCursor ?? source.sourcePath };
        })();
      return { adapter, checkpoint, sourceType, iterator, cache, done: false, complete: true };
    });
    try {
      while (jobs.some((job) => !job.done)) {
        for (const job of jobs) {
          if (job.done) continue;
          try {
            const next = await job.iterator.next();
            if (next.done) {
              job.done = true;
              if (job.complete) {
                const counts = yield* this.completeScanSteps(job.adapter, job.sourceType, job.checkpoint.scanId, result);
                result[job.sourceType === "session" ? "sessions" : "memories"] += counts;
              }
            } else {
              if (next.value.complete === false) job.complete = false;
              this.database.transaction(() => {
                job.cache.flush();
                const id = next.value.source ? this.upsertDiscoveredSource(next.value.source,
                  job.sourceType === "memory" ? "selected" : "discovered", job.checkpoint.scanId) : undefined;
                if (next.value.cursor) this.advanceAdapterScan(job.adapter.key, next.value.cursor);
                if (id && job.sourceType === "session") {
                  const row = this.getSource(id)!;
                  if (row.disposition !== "excluded" && !this.capacity.canFit(id, row.session_fragment_count ?? 1)) {
                    this.capacity.defer(id, (row.session_fragment_count ?? 1) > this.capacity.limit(row.agent) ? "oversized" : "capacity");
                  }
                }
              })();
            }
          } catch (error) {
            job.done = true;
            result.failed += 1;
            this.recordDiscoveryFailure(`${job.adapter.agent}_${job.sourceType}_discovery_failed`, error);
          }
          this.recordAdapterDiagnostics(job.adapter, false);
          yield result;
        }
      }
      // Reconsider waiting/changed sources after discovering newer priorities and freed capacity.
      const cursors = new Map<string, { time: string; id: string }>();
      let progress = true;
      while (progress) {
        progress = false;
        for (const adapter of adapters) {
          const cursor = cursors.get(adapter.key);
          const row = this.nextPendingSource(adapter, cursor);
          if (!row) continue;
          cursors.set(adapter.key, { time: row.source_updated_at, id: row.id });
          progress = true;
          const indexed = await this.processSource(row.id, adapter, result, true);
          yield result;
          if (indexed && this.embeddingProvider) { await this.embeddings.batch(row.id); yield result; }
        }
      }
      const agents = [...new Set(adapters.map((adapter) => adapter.agent))];
      while (agents.some((agent) => this.nextEmbedding(agent) !== undefined)) {
        for (const agent of agents) {
          const id = this.nextEmbedding(agent);
          if (id) { await this.embeddings.batch(id); yield result; }
        }
      }
      const memoryAgents = new Set(this.memoryAdapters.map((adapter) => adapter.agent));
      let memoryCursor = "";
      for (;;) {
        const rows = this.database.prepare("SELECT id, agent FROM sources WHERE source_type = 'memory' AND processing_state <> 'source_unavailable' AND id > ? ORDER BY id LIMIT 100")
          .all(memoryCursor) as Array<{ agent: string; id: string }>;
        if (rows.length === 0) break;
        for (const row of rows) if (!memoryAgents.has(row.agent)) { this.markSourceUnavailable(row.id); result.unavailable += 1; }
        memoryCursor = rows.at(-1)!.id;
        yield result;
      }
      this.pruneDiagnostics();
      return result;
    } finally {
      for (const job of jobs) {
        await job.iterator.return?.();
        this.recordAdapterDiagnostics(job.adapter, false);
      }
    }
  }

  private nextPendingSource(adapter: SourceAdapter, cursor?: { time: string; id: string }) {
    const sourceType = this.sessionAdapters.includes(adapter as SessionSourceAdapter) ? "session" : "memory";
    const base = `SELECT id, source_updated_at FROM sources WHERE source_type = ? AND agent = ?
      AND disposition <> 'excluded' AND processing_state <> 'source_unavailable'
      AND (processing_state <> 'indexed' OR indexed_fingerprint IS NOT content_fingerprint)`;
    type Pending = { id: string; source_updated_at: string } | undefined;
    if (cursor) {
      const sameTime = this.database.prepare(`${base} AND source_updated_at = ? AND id > ? ORDER BY id LIMIT 1`)
        .get(sourceType, adapter.agent, cursor.time, cursor.id) as Pending;
      if (sameTime) return sameTime;
      return this.database.prepare(`${base} AND source_updated_at < ? ORDER BY source_updated_at DESC, id LIMIT 1`)
        .get(sourceType, adapter.agent, cursor.time) as Pending;
    }
    return this.database.prepare(`${base} ORDER BY source_updated_at DESC, id LIMIT 1`).get(sourceType, adapter.agent) as Pending;
  }

  private nextEmbedding(agent: string): string | undefined {
    if (!this.embeddingProvider) return undefined;
    return (this.database.prepare(`SELECT id FROM sources WHERE agent = ? AND disposition = 'selected'
      AND processing_state = 'indexed' AND (embedding_state <> 'indexed' OR embedding_model_id IS NOT ?)
      AND (retry_after IS NULL OR retry_after <= ?) ORDER BY source_updated_at DESC, id LIMIT 1`)
      .get(agent, this.embeddingProvider.modelId, new Date().toISOString()) as { id: string } | undefined)?.id;
  }

  private async processSource(id: string, adapter: SourceAdapter, result: SourceScanResult, refresh = false): Promise<boolean> {
    let row = this.getSource(id)!;
    if (row.disposition === "excluded" || row.processing_state === "source_unavailable"
      || (row.retry_after && row.retry_after > new Date().toISOString())) return false;
    if (row.processing_state === "indexed" && row.indexed_fingerprint === row.content_fingerprint) return false;
    if (row.source_type === "session") {
      const estimate = row.session_fragment_count ?? 1;
      if (!this.capacity.canFit(id, estimate)) {
        this.capacity.defer(id, estimate > this.capacity.limit(row.agent) ? "oversized" : "capacity");
        return false;
      }
    }
    try {
      if (refresh) row = await this.refreshSource(row, adapter);
      const count = await this.indexSource(row, adapter, "selected", false);
      if (count > 0) result.indexed += 1;
      return count > 0;
    } catch { result.failed += 1; return false; }
  }

  private async refreshSource(row: SourceRow, adapter: SourceAdapter): Promise<SourceRow> {
    if (adapter.refresh) {
      const source = await adapter.refresh(rowToReference(row));
      if (!source) {
        this.markSourceUnavailable(row.id);
        throw new SourceUnavailableError("The Session source is unavailable or no longer contains eligible content.");
      }
      this.upsertDiscoveredSource(source, row.disposition === "selected" ? "selected" : "discovered", row.last_seen_scan_id ?? "refresh");
    }
    const current = this.getSource(row.id)!;
    if (current.processing_state === "source_unavailable") throw new SourceUnavailableError();
    return current;
  }

  private async *completeScanSteps(adapter: SourceAdapter, sourceType: SourceType, scanId: string, result: SourceScanResult): AsyncGenerator<SourceScanResult, number> {
    for (;;) {
      const rows = this.database.prepare(`SELECT id FROM sources WHERE source_type = ? AND agent = ?
        AND last_seen_scan_id IS NOT ? AND processing_state <> 'source_unavailable' LIMIT 100`)
        .all(sourceType, adapter.agent, scanId) as Array<{ id: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        if (adapter.isAvailable && await adapter.isAvailable(rowToReference(this.getSource(row.id)!))) {
          this.database.prepare("UPDATE sources SET last_seen_scan_id = ?, processing_state = 'source_changed' WHERE id = ?").run(scanId, row.id);
        } else { this.markSourceUnavailable(row.id); result.unavailable += 1; }
        yield result;
      }
    }
    const { count } = this.database.prepare("SELECT count(*) AS count FROM sources WHERE source_type = ? AND agent = ? AND last_seen_scan_id = ?")
      .get(sourceType, adapter.agent, scanId) as { count: number };
    this.database.prepare(`UPDATE scan_diagnostics SET resolved_at = ? WHERE adapter_key = ? AND resolved_at IS NULL
      AND last_seen_at < (SELECT started_at FROM scan_checkpoints WHERE adapter_key = ?)`)
      .run(new Date().toISOString(), adapter.key, adapter.key);
    this.database.prepare("DELETE FROM scan_checkpoints WHERE adapter_key = ? AND scan_id = ?").run(adapter.key, scanId);
    return count;
  }

  private beginAdapterScan(adapterKey: string): { cursor?: string; scanId: string } {
    const existing = this.database.prepare("SELECT scan_id, cursor FROM scan_checkpoints WHERE adapter_key = ?")
      .get(adapterKey) as { cursor: string | null; scan_id: string } | undefined;
    if (existing) return { cursor: existing.cursor ?? undefined, scanId: existing.scan_id };
    const scanId = randomUUID();
    this.database.prepare("INSERT INTO scan_checkpoints (adapter_key, scan_id, started_at) VALUES (?, ?, ?)")
      .run(adapterKey, scanId, new Date().toISOString());
    return { scanId };
  }

  private advanceAdapterScan(adapterKey: string, cursor: string): void {
    this.database.prepare("UPDATE scan_checkpoints SET cursor = ? WHERE adapter_key = ?").run(cursor, adapterKey);
  }

  private pruneDiagnostics(): void {
    this.database.prepare("DELETE FROM scan_diagnostics WHERE coalesce(last_seen_at, created_at) < datetime('now', '-90 days')").run();
    this.database.prepare(`
      DELETE FROM scan_diagnostics
      WHERE id NOT IN (SELECT id FROM scan_diagnostics ORDER BY id DESC LIMIT 1000)
    `).run();
  }

  private recordDiscoveryFailure(code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.database.prepare(`
      INSERT INTO scan_diagnostics (source_id, level, code, message, created_at)
      VALUES (NULL, 'error', ?, ?, ?)
    `).run(code, message, new Date().toISOString());
  }

  private recordAdapterDiagnostics(adapter: SourceAdapter, resolve = true): void {
    const diagnostics = adapter.takeDiagnostics?.() ?? [];
    const now = new Date().toISOString();
    if (resolve) this.database.prepare("UPDATE scan_diagnostics SET resolved_at = ? WHERE adapter_key = ? AND resolved_at IS NULL")
      .run(now, adapter.key);
    if (diagnostics.length === 0) return;
    const insert = this.database.prepare(`
      INSERT INTO scan_diagnostics (
        source_id, source_path, level, code, message, created_at,
        adapter_key, occurrence_count, last_seen_at, resolved_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM scan_diagnostics
        WHERE source_path IS ? AND code = ? AND message = ?
      )
    `);
    const refresh = this.database.prepare(`
      UPDATE scan_diagnostics
      SET source_id = ?, level = ?, adapter_key = ?, occurrence_count = occurrence_count + CASE WHEN last_seen_at < ? THEN 1 ELSE 0 END,
          last_seen_at = ?, resolved_at = NULL
      WHERE source_path IS ? AND code = ? AND message = ?
    `);
    const sourceForPath = this.database.prepare("SELECT id FROM sources WHERE source_path = ?");
    const audit = this.database.prepare("INSERT INTO source_audit (source_id, action, created_at) VALUES (?, ?, ?)");
    this.database.transaction((values: SourceDiagnostic[]) => {
      for (const diagnostic of values) {
        const sourceId = diagnostic.sourcePath
          ? (sourceForPath.get(diagnostic.sourcePath) as { id: string } | undefined)?.id ?? null
          : null;
        const result = insert.run(
          sourceId,
          diagnostic.sourcePath ?? null,
          diagnostic.level,
          diagnostic.code,
          diagnostic.message,
          now,
          adapter.key,
          now,
          diagnostic.sourcePath ?? null,
          diagnostic.code,
          diagnostic.message,
        );
        if (result.changes === 0) {
          refresh.run(sourceId, diagnostic.level, adapter.key, this.scanStartedAt, now, diagnostic.sourcePath ?? null, diagnostic.code, diagnostic.message);
        }
        if (result.changes > 0 && sourceId && diagnostic.code === "sensitive_content_redacted") {
          audit.run(sourceId, "sensitive_content_redacted", now);
        }
      }
    })(diagnostics);
  }

  private markSourceUnavailable(sourceId: string): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const row = this.getSource(sourceId)!;
      if (row.source_type === "session") this.capacity.removeFragments(sourceId);
      this.database.prepare("UPDATE sources SET processing_state = 'source_unavailable' WHERE id = ?").run(sourceId);
      this.database.prepare(`
        INSERT INTO scan_diagnostics (source_id, level, code, message, created_at)
        VALUES (?, 'warning', 'source_unavailable', 'The source was not found during a completed scan.', ?)
      `).run(sourceId, now);
      this.database.prepare("INSERT INTO source_audit (source_id, action, created_at) VALUES (?, 'source_unavailable', ?)")
        .run(sourceId, now);
    })();
  }

  private upsertDiscoveredSource(source: SourceReference, defaultDisposition: "discovered" | "selected", scanId: string): string {
    const id = databaseId(source);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO sources (
        id, source_type, agent, external_source_id, title, source_path, project_path,
        original_session_id, explicit_metadata_json, last_seen_scan_id,
        content_fingerprint, disposition, processing_state, source_updated_at, last_seen_at,
        index_rule_version, security_rule_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        source_path = excluded.source_path,
        project_path = excluded.project_path,
        original_session_id = excluded.original_session_id,
        explicit_metadata_json = excluded.explicit_metadata_json,
        last_seen_scan_id = excluded.last_seen_scan_id,
        content_fingerprint = excluded.content_fingerprint,
        source_updated_at = excluded.source_updated_at,
        last_seen_at = excluded.last_seen_at,
        session_fragment_count = CASE WHEN sources.content_fingerprint IS NOT excluded.content_fingerprint
          OR sources.index_rule_version <> excluded.index_rule_version OR sources.security_rule_version <> excluded.security_rule_version
          THEN NULL ELSE sources.session_fragment_count END,
        admission_reason = CASE WHEN sources.content_fingerprint IS NOT excluded.content_fingerprint
          OR sources.index_rule_version <> excluded.index_rule_version OR sources.security_rule_version <> excluded.security_rule_version
          THEN NULL ELSE sources.admission_reason END,
        retry_after = CASE WHEN sources.content_fingerprint IS NOT excluded.content_fingerprint THEN NULL ELSE sources.retry_after END,
        processing_state = CASE
          WHEN sources.disposition = 'selected' AND sources.indexed_fingerprint IS NOT excluded.content_fingerprint THEN 'source_changed'
          WHEN sources.disposition = 'selected' AND sources.index_rule_version <> excluded.index_rule_version THEN 'source_changed'
          WHEN sources.disposition = 'selected' AND sources.security_rule_version <> excluded.security_rule_version THEN 'source_changed'
          WHEN sources.processing_state = 'source_unavailable' THEN 'discovered'
          ELSE sources.processing_state
        END,
        disposition = CASE
          WHEN sources.source_type = 'memory' THEN 'selected'
          ELSE sources.disposition
        END
    `).run(
      id,
      source.sourceType,
      source.agent,
      source.sourceId,
      source.title ?? null,
      source.sourcePath,
      source.projectPath ?? null,
      source.originalSessionId ?? null,
      source.metadata ? JSON.stringify(source.metadata) : null,
      scanId,
      source.contentFingerprint,
      defaultDisposition,
      source.updatedAt.toISOString(),
      now,
      INDEX_RULE_VERSION,
      SENSITIVE_CONTENT_RULE_VERSION,
    );
    return id;
  }

  private getSource(id: string): SourceRow | undefined {
    return this.database.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
  }

  private async indexSource(row: SourceRow, adapter: SourceAdapter, disposition: "selected", generateEmbeddings = true): Promise<number> {
    this.database.prepare("UPDATE sources SET processing_state = 'indexing', error_message = NULL WHERE id = ?").run(row.id);
    const reference = rowToReference(row);
    const documents: IndexDocument[] = [];
    try {
      for await (const document of adapter.extract(reference)) {
        if (document.body.trim()) {
          documents.push(document);
        }
      }
      if (documents.length === 0) {
        throw new Error("Source contains no visible indexable text.");
      }
      const replace = this.database.transaction(() => {
        const current = this.getSource(row.id)!;
        if (current.disposition === "excluded" || current.content_fingerprint !== row.content_fingerprint) return false;
        if (row.source_type === "session" && !this.capacity.admit(row.id, documents.length)) return false;
        const reusableEmbeddings = this.database.prepare(`
          SELECT input_hash, model_id, dimensions, embedding
          FROM fragment_embeddings
          WHERE fragment_id IN (SELECT id FROM fragments WHERE source_id = ?)
            AND input_hash IS NOT NULL
        `).all(row.id) as Array<{ dimensions: number; embedding: Buffer; input_hash: string; model_id: string }>;
        const reusableByInput = new Map(reusableEmbeddings.map((embedding) => [
          `${embedding.model_id}\0${embedding.input_hash}`,
          embedding,
        ]));
        this.capacity.removeFragments(row.id);
        const insertFragment = this.database.prepare(`
          INSERT INTO fragments (
            id, source_id, content_hash, ordinal, role, location, end_location,
            started_at, ended_at, turn_count, chunk_index, content_tokens, title, body, embedding_input_hash, search_rowid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertSearch = this.database.prepare("INSERT INTO fragment_search (fragment_id, title_terms, body_terms) VALUES (?, ?, ?)");
        const insertEmbedding = this.database.prepare(`
          INSERT INTO fragment_embeddings (fragment_id, model_id, dimensions, embedding, input_hash)
          VALUES (?, ?, ?, ?, ?)
        `);
        documents.forEach((document, index) => {
          const contentHash = digest(normalizeSearchText(document.body));
          const fragmentId = digest(`${row.id}\0${document.location}\0${index}\0${contentHash}`);
          const searchRowid = insertSearch.run(fragmentId, buildSearchTerms(document.title ?? ""), buildSearchTerms(document.searchText ?? document.body)).lastInsertRowid;
          insertFragment.run(
            fragmentId,
            row.id,
            contentHash,
            index,
            document.role ?? null,
            document.location,
            document.endLocation ?? null,
            document.startedAt ?? null,
            document.endedAt ?? null,
            document.turnCount ?? null,
            document.chunkIndex ?? null,
            document.contentTokenCount ?? null,
            document.title ?? null,
            document.body,
            digest(embeddingInput(document)),
            searchRowid,
          );
          if (this.embeddingProvider) {
            const inputHash = digest(embeddingInput(document));
            const reusable = reusableByInput.get(`${this.embeddingProvider.modelId}\0${inputHash}`);
            if (reusable) {
              insertEmbedding.run(fragmentId, reusable.model_id, reusable.dimensions, reusable.embedding, inputHash);
            }
          }
        });
        this.database.prepare(`
          UPDATE sources
          SET disposition = ?, processing_state = 'indexed', indexed_fingerprint = content_fingerprint,
              error_message = NULL, index_rule_version = ?, security_rule_version = ?, embedding_state = ?,
              embedding_model_id = ?, embedding_error = NULL, retry_after = NULL
          WHERE id = ?
        `).run(
          disposition,
          INDEX_RULE_VERSION,
          SENSITIVE_CONTENT_RULE_VERSION,
          this.embeddingProvider ? "pending" : "disabled",
          this.embeddingProvider?.modelId ?? null,
          row.id,
        );
        this.database.prepare("INSERT INTO source_audit (source_id, action, created_at) VALUES (?, ?, ?)")
          .run(row.id, row.indexed_fingerprint ? "reindexed" : "indexed", new Date().toISOString());
        return true;
      });
      if (!replace()) return 0;
      if (generateEmbeddings) await this.ensureEmbeddings(row.id);
      return documents.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.transaction(() => {
        this.database.prepare("UPDATE sources SET processing_state = 'failed', error_message = ?, retry_after = ? WHERE id = ? AND disposition <> 'excluded'")
          .run(message, new Date(Date.now() + 60_000).toISOString(), row.id);
        this.database.prepare(`
          INSERT INTO scan_diagnostics (source_id, level, code, message, created_at)
          VALUES (?, 'error', 'index_failed', ?, ?)
        `).run(row.id, message, new Date().toISOString());
      })();
      throw error;
    }
  }

  private async ensureEmbeddings(sourceId: string): Promise<void> {
    await this.embeddings.complete(sourceId);
  }

}

export function createSourceService(
  database: AppDatabase,
  options: {
    adapters?: { memories: SourceAdapter[]; sessions: SessionSourceAdapter[] };
    contentTokenCounter?: ContentTokenCounter;
    embeddingProvider?: EmbeddingProvider;
    homeDirectory?: string;
    reranker?: RerankerProvider;
    isRerankerEnabled?: () => boolean;
    rerankCandidateCount?: number;
    sessionFragmentLimits?: Readonly<Record<string, number>>;
  } = {},
): SourceService {
  return new SourceService(database, {
    adapters: options.adapters,
    contentTokenCounter: options.contentTokenCounter,
    embeddingProvider: options.embeddingProvider,
    homeDirectory: options.homeDirectory ?? os.homedir(),
    reranker: options.reranker,
    isRerankerEnabled: options.isRerankerEnabled,
    rerankCandidateCount: options.rerankCandidateCount,
    sessionFragmentLimits: options.sessionFragmentLimits,
  });
}
