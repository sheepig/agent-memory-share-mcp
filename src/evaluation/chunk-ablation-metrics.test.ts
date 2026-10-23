import { describe, expect, it } from "vitest";

import { buildPooledTurnReference, calculatePooledTurnMetrics } from "./chunk-ablation-metrics.js";
import type { EvaluationSearchResult } from "./metrics.js";
import type { QueryCandidate } from "./types.js";

function candidate(): QueryCandidate {
  return {
    answer: "Synthetic evidence.", candidateId: "query", datasetId: "dataset",
    generatedBy: { model: "fixture", promptVersion: 1 },
    goldSpans: [{ sessionId: "session", startLine: 1, endLine: 2 }],
    query: "Where is the evidence?", queryType: "implementation", rationale: "Fixture query.",
    review: {
      completeness: "complete", status: "accepted",
      reviewer: { type: "llm", model: "fixture", provider: "fixture", promptVersion: 1, reportedModels: ["fixture"], relevanceThreshold: 2 },
      judgments: [
        { sessionId: "session", startLine: 1, endLine: 2, passageId: "a", chunkIndex: 0, relevance: 3, reason: "Relevant." },
        { sessionId: "session", startLine: 1, endLine: 2, passageId: "b", chunkIndex: 1, relevance: 2, reason: "Relevant sibling." },
        { sessionId: "session", startLine: 1, endLine: 2, passageId: "c", chunkIndex: 2, relevance: 0, reason: "Irrelevant sibling." },
        { sessionId: "session", startLine: 3, endLine: 4, passageId: "d", chunkIndex: 0, relevance: 3, reason: "Another relevant turn." },
        { sessionId: "session", startLine: 5, endLine: 6, passageId: "e", chunkIndex: 0, relevance: 1, reason: "Below threshold." },
      ],
    },
  };
}

function result(passageId: string, start = 1): EvaluationSearchResult {
  return {
    agent: "codex", contentFingerprint: "fixture", excerpt: "BODY MUST NOT ENTER REPORTS",
    fragmentId: passageId, passageId, location: `line:${start}`, endLocation: `line:${start + 1}`,
    matchReason: "semantic", sessionId: "session", sourceId: "session",
    sourcePath: "/synthetic/session.jsonl", sourceType: "session", updatedAt: new Date(0).toISOString(),
  };
}

describe("chunk ablation pooled turn metrics", () => {
  it("freezes a deduplicated reference from all variants' judgments at the relevance threshold", () => {
    expect(buildPooledTurnReference(candidate())).toEqual({
      candidateId: "query", datasetId: "dataset", relevanceThreshold: 2,
      relevantTurns: [
        { sessionId: "session", location: "line:1", endLocation: "line:2" },
        { sessionId: "session", location: "line:3", endLocation: "line:4" },
      ],
    });
  });

  it("keeps the union denominator even when a variant has no relevant passage for one turn", () => {
    const query = candidate();
    const reference = buildPooledTurnReference(query);
    const projected = { ...query, review: { ...query.review, judgments: query.review.judgments!.slice(0, 3) } };
    expect(calculatePooledTurnMetrics([result("a")], projected, reference, 10)).toEqual({
      pooledTurnRecall: 0.5, hit: 1, sameTurnDuplicateRate: 0,
    });
    expect(calculatePooledTurnMetrics([result("a"), result("b")], projected, reference, 10)).toEqual({
      pooledTurnRecall: 0.5, hit: 1, sameTurnDuplicateRate: 0.5,
    });
  });

  it("does not transfer relevance to irrelevant, below-threshold, or unjudged chunks", () => {
    const query = candidate();
    const reference = buildPooledTurnReference(query);
    for (const results of [[result("c")], [result("e", 5)], [result("unknown")]]) {
      expect(calculatePooledTurnMetrics(results, query, reference, 10)).toEqual({
        pooledTurnRecall: 0, hit: 0, sameTurnDuplicateRate: 0,
      });
    }
  });

  it("applies K before counting distinct turns and divides duplicates by actual returned results", () => {
    const query = candidate();
    const reference = buildPooledTurnReference(query);
    const results = [result("c"), result("a"), result("d", 3)];
    expect(calculatePooledTurnMetrics(results, query, reference, 1)).toEqual({ pooledTurnRecall: 0, hit: 0, sameTurnDuplicateRate: 0 });
    expect(calculatePooledTurnMetrics(results, query, reference, 2)).toEqual({ pooledTurnRecall: 0.5, hit: 1, sameTurnDuplicateRate: 0.5 });
    expect(calculatePooledTurnMetrics(results, query, reference, 10)).toEqual({ pooledTurnRecall: 1, hit: 1, sameTurnDuplicateRate: 1 / 3 });
    expect(calculatePooledTurnMetrics([], query, reference, 10)).toEqual({ pooledTurnRecall: 0, hit: 0, sameTurnDuplicateRate: 0 });
  });

  it("distinguishes sessions with the same line range", () => {
    const query = candidate();
    const results = [result("c"), { ...result("unknown"), sessionId: "other-session" }];
    expect(calculatePooledTurnMetrics(results, query, buildPooledTurnReference(query), 10).sameTurnDuplicateRate).toBe(0);
  });
});
