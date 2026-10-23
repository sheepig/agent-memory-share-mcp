import { relevanceForResult, relevanceThreshold, type EvaluationSearchResult } from "./metrics.js";
import type { QueryCandidate } from "./types.js";

interface TurnLocation {
  endLocation: string;
  location: string;
  sessionId: string;
}

export interface PooledTurnReference {
  candidateId: string;
  datasetId: string;
  relevanceThreshold: number;
  relevantTurns: TurnLocation[];
}

export interface PooledTurnMetrics {
  hit: number;
  pooledTurnRecall: number;
  sameTurnDuplicateRate: number;
}

export interface PooledTurnMetricsAtCutoffs {
  at5: PooledTurnMetrics;
  at10: PooledTurnMetrics;
  at20: PooledTurnMetrics;
}

function turnKey(datasetId: string, turn: TurnLocation): string {
  return JSON.stringify([datasetId, turn.sessionId, turn.location, turn.endLocation]);
}

// Build once from the fully judged union, before projecting qrels into individual variants.
export function buildPooledTurnReference(candidate: QueryCandidate): PooledTurnReference {
  const threshold = relevanceThreshold(candidate);
  const turns = new Map<string, TurnLocation>();
  for (const judgment of candidate.review.judgments ?? []) {
    if (judgment.relevance < threshold) continue;
    const turn = { sessionId: judgment.sessionId, location: `line:${judgment.startLine}`, endLocation: `line:${judgment.endLine}` };
    turns.set(turnKey(candidate.datasetId, turn), turn);
  }
  return {
    candidateId: candidate.candidateId,
    datasetId: candidate.datasetId,
    relevanceThreshold: threshold,
    relevantTurns: [...turns.values()],
  };
}

export function calculatePooledTurnMetrics(
  results: readonly EvaluationSearchResult[],
  candidate: QueryCandidate,
  reference: PooledTurnReference,
  limit: number,
): PooledTurnMetrics {
  const top = results.slice(0, limit);
  const relevant = new Set(reference.relevantTurns.map((turn) => turnKey(reference.datasetId, turn)));
  const seen = new Set<string>();
  const matched = new Set<string>();
  for (const result of top) {
    const key = turnKey(candidate.datasetId, {
      sessionId: result.sessionId!, location: result.location, endLocation: result.endLocation ?? result.location,
    });
    seen.add(key);
    const relevance = relevanceForResult(result, candidate);
    if (relevance !== null && relevance >= reference.relevanceThreshold && relevant.has(key)) matched.add(key);
  }
  return {
    hit: Number(matched.size > 0),
    pooledTurnRecall: relevant.size > 0 ? matched.size / relevant.size : 0,
    sameTurnDuplicateRate: top.length > 0 ? (top.length - seen.size) / top.length : 0,
  };
}
