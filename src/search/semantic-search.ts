import { setImmediate } from "node:timers/promises";

import type { SearchFragmentsInput } from "../application/source-service.js";
import type { AppDatabase } from "../storage/database.js";
import { cosineSimilarity, decodeEmbedding, type EmbeddingProvider } from "./embedding.js";
import type { FragmentRow } from "./fragment-row.js";

const VECTOR_BATCH_SIZE = 128;

interface VectorRow {
  content_hash: string;
  content_fingerprint: string;
  embedding: Buffer;
  end_location: string | null;
  fragment_id: string;
  input_hash: string | null;
  location: string;
  project_path: string | null;
  source_id: string;
  source_type: "memory" | "session";
  vector_id: number;
}

type ScoredVector = Omit<VectorRow, "embedding"> & { score: number };

function compare(left: ScoredVector, right: ScoredVector): number {
  return right.score - left.score || left.vector_id - right.vector_id;
}

function turnKey(row: ScoredVector): string {
  return row.source_type === "memory" ? row.fragment_id
    : `${row.source_id}\0${row.location}\0${row.end_location ?? row.location}`;
}

function retainBest(rows: ScoredVector[], row: ScoredVector, limit: number): void {
  if (rows.length === limit && compare(row, rows[rows.length - 1]!) >= 0) return;
  const index = rows.findIndex((existing) => compare(row, existing) < 0);
  rows.splice(index < 0 ? rows.length : index, 0, row);
  if (rows.length > limit) rows.pop();
}

export async function searchSemanticRows(database: AppDatabase, input: SearchFragmentsInput, options: {
  embeddingProvider: EmbeddingProvider;
  filters: string[];
  values: unknown[];
  limit: number;
  diversify: boolean;
}): Promise<Array<{ row: FragmentRow; score: number }>> {
  const { embeddingProvider, filters, values, limit, diversify } = options;
  const query = await embeddingProvider.embedQuery(input.query);
  // Bound the scan to the embeddings present when it starts. Keyset paging also
  // avoids skipping the next page if a source is removed while we yield.
  const last = database.prepare("SELECT max(rowid) AS id FROM fragment_embeddings").get() as { id: number | null };
  if (last.id === null) return [];
  const statement = database.prepare(`
    SELECT e.rowid AS vector_id, e.fragment_id, e.embedding, e.input_hash,
           f.content_hash, f.location, f.end_location,
           s.id AS source_id, s.source_type, s.project_path, s.content_fingerprint
    FROM fragment_embeddings e
    JOIN fragments f ON f.id = e.fragment_id
    JOIN sources s ON s.id = f.source_id
    WHERE e.model_id = ? AND e.rowid > ? AND e.rowid <= ?
      AND s.embedding_state = 'indexed' AND ${filters.join(" AND ")}
    ORDER BY e.rowid LIMIT ?
  `);
  const best: ScoredVector[] = [];
  const turns: ScoredVector[] = [];
  let cursor = 0;
  for (;;) {
    const page = statement.all(embeddingProvider.modelId, cursor, last.id, ...values, VECTOR_BATCH_SIZE) as VectorRow[];
    for (const { embedding, ...row } of page) {
      cursor = row.vector_id;
      const score = cosineSimilarity(query, decodeEmbedding(embedding))
        + (input.contextProjectPath && row.project_path === input.contextProjectPath ? 0.05 : 0);
      if (!Number.isFinite(score)) continue;
      const candidate = { ...row, score };
      retainBest(best, candidate, limit);
      if (diversify) {
        const key = turnKey(candidate);
        const previous = turns.findIndex((existing) => turnKey(existing) === key);
        if (previous >= 0) {
          if (compare(candidate, turns[previous]!) >= 0) continue;
          turns.splice(previous, 1);
        }
        retainBest(turns, candidate, limit);
      }
    }
    if (page.length < VECTOR_BATCH_SIZE) break;
    await setImmediate();
  }
  // Top raw chunks fill any spare slots; top turn leaders preserve diversity
  // even when a single turn has more chunks than the candidate depth.
  const selected = [...new Map([...best, ...turns].map((row) => [row.fragment_id, row])).values()].sort(compare);
  const read = database.prepare(`
    SELECT f.id AS fragment_id, f.role, f.location, f.end_location, f.started_at, f.ended_at,
           f.turn_count, f.chunk_index, f.content_tokens, f.content_hash, f.title AS fragment_title, f.body,
           s.id AS source_id, s.external_source_id, s.source_type, s.agent, s.source_path,
           s.project_path, s.original_session_id, s.content_fingerprint, s.source_updated_at, s.title AS source_title
    FROM fragments f JOIN sources s ON s.id = f.source_id
    JOIN fragment_embeddings e ON e.fragment_id = f.id
    WHERE f.id = ? AND f.content_hash = ? AND s.content_fingerprint = ?
      AND e.model_id = ? AND e.input_hash IS ? AND e.rowid = ?
      AND s.embedding_state = 'indexed' AND ${filters.join(" AND ")}
  `);
  return selected.flatMap((candidate) => {
    const row = read.get(candidate.fragment_id, candidate.content_hash, candidate.content_fingerprint,
      embeddingProvider.modelId, candidate.input_hash, candidate.vector_id, ...values) as FragmentRow | undefined;
    return row ? [{ row, score: candidate.score }] : [];
  });
}
