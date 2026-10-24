import { setImmediate } from "node:timers/promises";

import type { SearchFragmentsInput } from "../application/source-service.js";
import type { AppDatabase } from "../storage/database.js";
import type { FragmentRow } from "./fragment-row.js";
import { buildFtsQuery } from "./tokens.js";

export type FragmentReference = Omit<FragmentRow, "body">;
export type KeywordReference = FragmentReference & { keyword_rank: number };

function turnKey(row: FragmentReference): string {
  return row.source_type === "memory" ? row.fragment_id
    : `${row.source_id}\0${row.location}\0${row.end_location ?? row.location}`;
}

export async function searchKeywordRows(database: AppDatabase, input: SearchFragmentsInput, options: {
  filters: string[];
  values: unknown[];
  limit: number;
  diversify: boolean;
  keepIds?: ReadonlySet<string>;
}): Promise<KeywordReference[]> {
  const match = buildFtsQuery(input.query);
  if (!match) return [];
  const { filters, values, limit, diversify, keepIds } = options;
  const pageSize = Math.max(limit, 50);
  const statement = database.prepare(`
    SELECT f.id AS fragment_id, f.role, f.location, f.end_location, f.started_at, f.ended_at,
           f.turn_count, f.chunk_index, f.content_tokens, f.content_hash, f.title AS fragment_title,
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
  const retained = new Map<string, KeywordReference>();
  const turns = new Set<string>();
  for (let offset = 0; ; offset += pageSize) {
    const page = statement.all(match, ...values, input.contextProjectPath ?? null,
      input.contextProjectPath ?? null, pageSize, offset) as FragmentReference[];
    for (const [index, row] of page.entries()) {
      const rank = offset + index;
      let leader = false;
      if (diversify && turns.size < limit) {
        const key = turnKey(row);
        if (!turns.has(key)) { turns.add(key); leader = true; }
      }
      if (rank < limit || leader || keepIds?.has(row.fragment_id)) {
        retained.set(row.fragment_id, { ...row, keyword_rank: rank });
      }
    }
    // Keep the existing page boundary for hybrid's keyword window and its RRF
    // ranks, even when most rows belong to the same Session turn.
    if (page.length < pageSize || !diversify || turns.size >= limit) return [...retained.values()];
    await setImmediate();
  }
}
