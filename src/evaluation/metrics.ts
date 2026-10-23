import type { FragmentSearchResult } from "../domain/source.js";
import type { QueryCandidate } from "./types.js";

interface JudgmentUnit {
  chunkIndex?: number;
  endLine: number;
  passageId?: string;
  relevance: number;
  sessionId: string;
  startLine: number;
}

export type EvaluationSearchResult = FragmentSearchResult & { passageId?: string };

export interface EvaluationQuality {
  mrr: number;
  ndcg: number;
  recall: number;
}

function lineNumber(location: string | undefined): number | undefined {
  const match = /^line:(\d+)$/u.exec(location ?? "");
  return match ? Number(match[1]) : undefined;
}

export function relevanceThreshold(candidate: QueryCandidate): number {
  const reviewer = candidate.review.reviewer;
  return typeof reviewer === "object" && reviewer.type === "llm" ? reviewer.relevanceThreshold : 1;
}

function judgmentUnits(candidate: QueryCandidate): JudgmentUnit[] {
  if (candidate.review.judgments && candidate.review.judgments.length > 0) return candidate.review.judgments;
  return candidate.goldSpans.map((span) => ({ ...span, relevance: 1 }));
}

function matchingIndexes(result: EvaluationSearchResult, units: readonly JudgmentUnit[]): number[] {
  const start = lineNumber(result.location);
  const end = lineNumber(result.endLocation) ?? start;
  if (!result.sessionId || !start || !end) return [];
  return units.flatMap((unit, index) => {
    const matches = unit.passageId !== undefined
      ? unit.passageId === result.passageId && unit.sessionId === result.sessionId
      : unit.sessionId === result.sessionId
        && (unit.chunkIndex === undefined || unit.chunkIndex === result.chunkIndex)
        && start <= unit.endLine
        && end >= unit.startLine;
    return matches ? [index] : [];
  });
}

export function relevanceForResult(result: EvaluationSearchResult, candidate: QueryCandidate): number | null {
  const units = judgmentUnits(candidate);
  const matches = matchingIndexes(result, units);
  if (matches.length === 0) return null;
  return Math.max(...matches.map((index) => units[index]?.relevance ?? 0));
}

export function judgedAt(results: readonly EvaluationSearchResult[], candidate: QueryCandidate, limit: number): number {
  if (limit <= 0) return 0;
  return results.slice(0, limit).filter((result) => relevanceForResult(result, candidate) !== null).length / limit;
}

export function calculateQuality(
  results: readonly EvaluationSearchResult[],
  candidate: QueryCandidate,
  limit: number,
): EvaluationQuality {
  const allUnits = judgmentUnits(candidate);
  const gradedUnits = allUnits.filter((unit) => unit.relevance > 0);
  const relevantUnits = allUnits.filter((unit) => unit.relevance >= relevanceThreshold(candidate));
  const seenRelevant = new Set<number>();
  const seenGraded = new Set<number>();
  let dcg = 0;
  let first = 0;
  results.slice(0, limit).forEach((result, index) => {
    const relevantMatches = matchingIndexes(result, relevantUnits).filter((unitIndex) => !seenRelevant.has(unitIndex));
    relevantMatches.forEach((unitIndex) => seenRelevant.add(unitIndex));
    if (relevantMatches.length > 0 && first === 0) first = index + 1;
    const gradedMatches = matchingIndexes(result, gradedUnits).filter((unitIndex) => !seenGraded.has(unitIndex));
    if (gradedMatches.length === 0) return;
    gradedMatches.forEach((unitIndex) => seenGraded.add(unitIndex));
    const relevance = Math.max(...gradedMatches.map((unitIndex) => gradedUnits[unitIndex]?.relevance ?? 0));
    dcg += relevance / Math.log2(index + 2);
  });
  const ideal = gradedUnits.map((unit) => unit.relevance)
    .sort((left, right) => right - left)
    .slice(0, limit)
    .reduce((sum, relevance, index) => sum + relevance / Math.log2(index + 2), 0);
  return {
    mrr: first > 0 ? 1 / first : 0,
    ndcg: ideal > 0 ? dcg / ideal : 0,
    recall: relevantUnits.length > 0 ? seenRelevant.size / relevantUnits.length : 0,
  };
}
