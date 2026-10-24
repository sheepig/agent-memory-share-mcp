import type { SearchFragmentsInput } from "../application/source-service.js";
import type { FragmentSearchResult } from "../domain/source.js";
import type { AppDatabase } from "../storage/database.js";
import { buildSearchExcerpt } from "./excerpt.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { FragmentRow } from "./fragment-row.js";
import { normalizeSearchText } from "./normalize.js";
import type { RerankerProvider } from "./reranker.js";
import { diversifySessionChunks } from "./session-diversity.js";
import { searchKeywordRows, type FragmentReference } from "./keyword-search.js";
import { searchSemanticRows } from "./semantic-search.js";

export interface FragmentSearchCandidate {
  reason: string;
  row: FragmentRow;
  score?: number;
}

function fragmentIdentity(row: FragmentReference) {
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
    candidates = this.availableCandidates(input, candidates);
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
    const semanticRows = mode === "keyword" ? [] : await searchSemanticRows(this.database, input, {
      embeddingProvider: this.embeddingProvider!,
      ...this.searchFilters(input),
      limit: mode === "semantic" ? candidateCount ?? input.limit : candidateLimit,
      diversify: mode === "semantic" && candidateCount === undefined,
    });
    const keywordRows = mode === "semantic" ? [] : await searchKeywordRows(this.database, input, {
      ...this.searchFilters(input),
      limit: mode === "keyword" ? candidateCount ?? input.limit : candidateLimit,
      diversify: mode === "hybrid" || candidateCount === undefined,
      keepIds: new Set(semanticRows.map(({ row }) => row.fragment_id)),
    });
    const contextReason = (row: FragmentReference) => input.contextProjectPath === row.project_path ? " + project context" : "";
    let candidates: Array<{ reason: string; row: FragmentReference; score?: number }>;
    if (mode === "keyword") {
      const normalizedQuery = normalizeSearchText(input.query);
      candidates = keywordRows.map((row) => ({
        row,
        reason: `${normalizeSearchText(row.fragment_title ?? "").includes(normalizedQuery) ? "title match" : "body match"}${contextReason(row)}`,
      }));
    } else {
      if (mode === "semantic") {
        candidates = semanticRows.map(({ row, score }) => ({ row, score, reason: `semantic similarity${contextReason(row)}` }));
      } else {
        const fused = new Map<string, { reason: string; row: FragmentReference; score: number }>();
        keywordRows.forEach((row) => {
          fused.set(row.fragment_id, { reason: "keyword match", row, score: 1 / (60 + row.keyword_rank + 1) });
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
    const selected = candidateCount === undefined
      ? diversifySessionChunks(candidates, (candidate) => fragmentIdentity(candidate.row), input.limit)
      : candidates.slice(0, candidateCount);
    return this.readCandidates(input, selected);
  }

  private readCandidates(input: SearchFragmentsInput, candidates: Array<{
    reason: string; row: FragmentReference; score?: number;
  }>): FragmentSearchCandidate[] {
    const { filters, values } = this.searchFilters(input);
    const statement = this.database.prepare(`
      SELECT f.id AS fragment_id, f.role, f.location, f.end_location, f.started_at, f.ended_at,
             f.turn_count, f.chunk_index, f.content_tokens, f.content_hash, f.title AS fragment_title, f.body,
             s.id AS source_id, s.external_source_id, s.source_type, s.agent, s.source_path,
             s.project_path, s.original_session_id, s.content_fingerprint, s.source_updated_at, s.title AS source_title
      FROM fragments f JOIN sources s ON s.id = f.source_id
      WHERE f.id = ? AND f.content_hash = ? AND s.content_fingerprint = ? AND ${filters.join(" AND ")}
    `);
    return candidates.flatMap((candidate) => {
      const row = statement.get(candidate.row.fragment_id, candidate.row.content_hash,
        candidate.row.content_fingerprint, ...values) as FragmentRow | undefined;
      return row ? [{ ...candidate, row }] : [];
    });
  }

  private availableCandidates(input: SearchFragmentsInput, candidates: FragmentSearchCandidate[]): FragmentSearchCandidate[] {
    const { filters, values } = this.searchFilters(input);
    const statement = this.database.prepare(`
      SELECT 1 FROM fragments f JOIN sources s ON s.id = f.source_id
      WHERE f.id = ? AND f.content_hash = ? AND s.content_fingerprint = ?
        AND ${input.mode === "semantic" ? "s.embedding_state = 'indexed' AND" : ""} ${filters.join(" AND ")}
    `);
    return candidates.filter(({ row }) => statement.get(row.fragment_id, row.content_hash, row.content_fingerprint, ...values));
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
    if (input.excludeAgent) {
      filters.push("s.agent <> ?");
      values.push(input.excludeAgent);
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
