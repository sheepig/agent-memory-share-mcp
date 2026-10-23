import type { SearchFragmentsInput } from "../application/source-service.js";
import type { FragmentSearchResult } from "../domain/source.js";
import type { AppDatabase } from "../storage/database.js";
import { buildSearchExcerpt } from "./excerpt.js";
import { cosineSimilarity, decodeEmbedding, type EmbeddingProvider } from "./embedding.js";
import type { FragmentRow } from "./fragment-row.js";
import { normalizeSearchText } from "./normalize.js";
import type { RerankerProvider } from "./reranker.js";
import { countDiverseSessionChunks, diversifySessionChunks } from "./session-diversity.js";
import { buildFtsQuery } from "./tokens.js";

export interface FragmentSearchCandidate {
  reason: string;
  row: FragmentRow;
  score?: number;
}

function fragmentIdentity(row: FragmentRow) {
  return {
    endLocation: row.end_location,
    location: row.location,
    sourceId: row.source_id,
    sourceType: row.source_type,
  };
}

export class FragmentSearch {
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly reranker?: RerankerProvider;
  private readonly isRerankerEnabled?: () => boolean;
  private readonly rerankCandidateCount: number;

  constructor(private readonly database: AppDatabase, options: {
    embeddingProvider?: EmbeddingProvider;
    reranker?: RerankerProvider;
    isRerankerEnabled?: () => boolean;
    rerankCandidateCount?: number;
  } = {}) {
    this.embeddingProvider = options.embeddingProvider;
    this.reranker = options.reranker;
    this.isRerankerEnabled = options.isRerankerEnabled;
    this.rerankCandidateCount = options.rerankCandidateCount ?? 50;
    if (!Number.isInteger(this.rerankCandidateCount) || this.rerankCandidateCount < 1) {
      throw new Error("Reranker candidate count must be a positive integer.");
    }
  }

  async search(input: SearchFragmentsInput): Promise<{ results: FragmentSearchResult[] }> {
    const reranker = this.reranker && (this.isRerankerEnabled?.() ?? true) ? this.reranker : undefined;
    let candidates = await this.retrieve(input, reranker ? Math.max(input.limit, this.rerankCandidateCount) : undefined);
    if (reranker && candidates.length > 0) {
      const scores = await reranker.score(input.query, candidates.map(({ row }) => (
        row.source_type === "memory" && row.fragment_title ? `${row.fragment_title}\n\n${row.body}` : row.body
      )));
      if (scores.length !== candidates.length || candidates.some((_, index) => !Number.isFinite(scores[index]))) {
        throw new Error("Reranker returned invalid scores: expected one finite score per candidate.");
      }
      candidates = candidates.map((candidate, index) => ({
        ...candidate,
        reason: `${candidate.reason} + reranker ${reranker.modelId}`,
        score: scores[index]!,
      })).sort((left, right) => right.score - left.score);
    }
    return {
      results: diversifySessionChunks(candidates, (value) => fragmentIdentity(value.row), input.limit)
        .map(({ reason, row, score }) => mapFragmentSearchResult(row, reason, input.query, score)),
    };
  }

  async retrieveCandidates(input: SearchFragmentsInput, candidateCount: number): Promise<FragmentSearchCandidate[]> {
    if (!Number.isInteger(candidateCount) || candidateCount < 1) {
      throw new Error("Candidate count must be a positive integer.");
    }
    return this.retrieve(input, candidateCount);
  }

  private async retrieve(input: SearchFragmentsInput, candidateCount?: number): Promise<FragmentSearchCandidate[]> {
    if (!input.query.trim()) throw new Error("Search query must not be empty.");
    const mode = input.mode ?? "keyword";
    if (mode !== "keyword" && !this.embeddingProvider) {
      throw new Error("Embedding search is not configured.");
    }
    const candidateLimit = Math.max(input.limit * 4, 50, candidateCount ?? 0);
    const keywordRows = mode === "semantic" ? [] : this.searchKeywordRows(
      input, mode === "keyword" ? candidateCount ?? input.limit : candidateLimit,
    );
    const contextReason = (row: FragmentRow) => input.contextProjectPath === row.project_path ? " + project context" : "";
    let candidates: FragmentSearchCandidate[];
    if (mode === "keyword") {
      const normalizedQuery = normalizeSearchText(input.query);
      candidates = keywordRows.map((row) => ({
        row,
        reason: `${normalizeSearchText(row.fragment_title ?? "").includes(normalizedQuery) ? "title match" : "body match"}${contextReason(row)}`,
      }));
    } else {
      const semanticRows = await this.searchSemanticRows(input);
      if (mode === "semantic") {
        candidates = semanticRows.map(({ row, score }) => ({ row, score, reason: `semantic similarity${contextReason(row)}` }));
      } else {
        const fused = new Map<string, { reason: string; row: FragmentRow; score: number }>();
        keywordRows.forEach((row, index) => {
          fused.set(row.fragment_id, { reason: "keyword match", row, score: 1 / (60 + index + 1) });
        });
        semanticRows.slice(0, candidateLimit).forEach(({ row }, index) => {
          const existing = fused.get(row.fragment_id);
          fused.set(row.fragment_id, {
            reason: existing ? "hybrid match" : "semantic similarity",
            row,
            score: (existing?.score ?? 0) + 1 / (60 + index + 1),
          });
        });
        candidates = [...fused.values()].sort((left, right) => right.score - left.score)
          .map((candidate) => ({ ...candidate, reason: `${candidate.reason}${contextReason(candidate.row)}` }));
      }
    }
    return candidateCount === undefined ? candidates : candidates.slice(0, candidateCount);
  }

  private searchKeywordRows(input: SearchFragmentsInput, limit: number): FragmentRow[] {
    const match = buildFtsQuery(input.query);
    if (!match) return [];
    const { filters, values } = this.searchFilters(input);
    const pageSize = Math.max(limit, 50);
    const statement = this.database.prepare(`
      SELECT f.id AS fragment_id, f.role, f.location, f.end_location, f.started_at, f.ended_at,
             f.turn_count, f.chunk_index, f.content_tokens, f.title AS fragment_title, f.body,
             s.id AS source_id, s.external_source_id, s.source_type, s.agent, s.source_path,
             s.project_path, s.original_session_id, s.content_fingerprint, s.source_updated_at, s.title AS source_title
      FROM fragment_search
      JOIN fragments f ON f.id = fragment_search.fragment_id
      JOIN sources s ON s.id = f.source_id
      WHERE fragment_search MATCH ? AND ${filters.join(" AND ")}
      ORDER BY CASE WHEN ? IS NOT NULL AND s.project_path = ? THEN 0 ELSE 1 END,
               bm25(fragment_search, 0.0, 5.0, 1.0), s.source_updated_at DESC, f.ordinal, f.id
      LIMIT ? OFFSET ?
    `);
    const rows: FragmentRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = statement.all(
        match, ...values, input.contextProjectPath ?? null, input.contextProjectPath ?? null, pageSize, offset,
      ) as FragmentRow[];
      rows.push(...page);
      if (page.length < pageSize || countDiverseSessionChunks(rows, fragmentIdentity) >= limit) return rows;
    }
  }

  private async searchSemanticRows(input: SearchFragmentsInput): Promise<Array<{ row: FragmentRow; score: number }>> {
    const embeddingProvider = this.embeddingProvider!;
    const query = await embeddingProvider.embedQuery(input.query);
    const { filters, values } = this.searchFilters(input);
    const rows = this.database.prepare(`
      SELECT f.id AS fragment_id, f.role, f.location, f.end_location, f.started_at, f.ended_at,
             f.turn_count, f.chunk_index, f.content_tokens, f.title AS fragment_title, f.body,
             s.id AS source_id, s.external_source_id, s.source_type, s.agent, s.source_path,
             s.project_path, s.original_session_id, s.content_fingerprint, s.source_updated_at, s.title AS source_title,
             e.embedding
      FROM fragment_embeddings e
      JOIN fragments f ON f.id = e.fragment_id
      JOIN sources s ON s.id = f.source_id
      WHERE e.model_id = ? AND s.embedding_state = 'indexed' AND ${filters.join(" AND ")}
    `).all(embeddingProvider.modelId, ...values) as FragmentRow[];
    return rows
      .map((row) => ({
        row,
        score: cosineSimilarity(query, decodeEmbedding(row.embedding!))
          + (input.contextProjectPath && row.project_path === input.contextProjectPath ? 0.05 : 0),
      }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => right.score - left.score);
  }

  private searchFilters(input: SearchFragmentsInput): { filters: string[]; values: unknown[] } {
    const filters = ["s.processing_state = 'indexed'", "s.disposition = 'selected'"];
    const values: unknown[] = [];
    if (input.sourceType) {
      filters.push("s.source_type = ?");
      values.push(input.sourceType);
    }
    if (input.agent) {
      filters.push("s.agent = ?");
      values.push(input.agent);
    }
    if (input.projectPath) {
      filters.push("s.project_path = ?");
      values.push(input.projectPath);
    }
    if (input.updatedAfter) {
      filters.push("s.source_updated_at >= ?");
      values.push(new Date(input.updatedAfter).toISOString());
    }
    if (input.updatedBefore) {
      filters.push("s.source_updated_at <= ?");
      values.push(new Date(input.updatedBefore).toISOString());
    }
    return { filters, values };
  }
}

export function mapFragmentSearchResult(row: FragmentRow, matchReason: string, query: string, score?: number): FragmentSearchResult {
  return {
    agent: row.agent,
    chunkIndex: row.chunk_index ?? undefined,
    contentFingerprint: row.content_fingerprint,
    contentTokenCount: row.content_tokens ?? undefined,
    endLocation: row.end_location ?? undefined,
    endedAt: row.ended_at ?? undefined,
    excerpt: buildSearchExcerpt(row.body, query),
    fragmentId: row.fragment_id,
    location: row.location,
    matchReason,
    originalSessionId: row.original_session_id ?? undefined,
    projectPath: row.project_path ?? undefined,
    role: row.role ?? undefined,
    score,
    sessionId: row.source_type === "session" ? row.external_source_id : undefined,
    sourceId: row.source_id,
    sourcePath: row.source_path,
    sourceType: row.source_type,
    startedAt: row.started_at ?? undefined,
    title: row.fragment_title ?? row.source_title ?? undefined,
    turnCount: row.turn_count ?? undefined,
    updatedAt: row.source_updated_at,
  };
}
