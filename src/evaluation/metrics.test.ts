import { describe, expect, it } from "vitest";

import type { FragmentSearchResult } from "../domain/source.js";
import { calculateQuality, relevanceForResult } from "./metrics.js";
import type { QueryCandidate } from "./types.js";

function result(chunkIndex: number): FragmentSearchResult {
  return {
    agent: "codex",
    chunkIndex,
    contentFingerprint: "fingerprint",
    endLocation: "line:2",
    excerpt: "Sibling chunk",
    fragmentId: `fragment-${chunkIndex}`,
    location: "line:1",
    matchReason: "keyword",
    sessionId: "session",
    sourceId: "source",
    sourcePath: "/sessions/session.jsonl",
    sourceType: "session",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

describe("evaluation metrics", () => {
  it("uses passage identity when two variants reuse a chunk index for different text", () => {
    const candidate: QueryCandidate = {
      answer: "Relevant answer",
      candidateId: "candidate",
      datasetId: "dataset",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ chunkIndex: 0, endLine: 2, passageId: "relevant-passage", sessionId: "session", startLine: 1 }],
      query: "Which variant contains the answer?",
      queryType: "implementation",
      rationale: "The variants have different text at chunk zero.",
      review: {
        completeness: "complete",
        judgments: [
          { chunkIndex: 0, endLine: 2, passageId: "relevant-passage", reason: "Direct answer.", relevance: 3, sessionId: "session", startLine: 1 },
          { chunkIndex: 0, endLine: 2, passageId: "other-passage", reason: "Wrong text.", relevance: 0, sessionId: "session", startLine: 1 },
        ],
        reviewer: "fixture",
        status: "accepted",
      },
    };
    const wrong = { ...result(0), passageId: "other-passage" };
    const right = { ...result(0), passageId: "relevant-passage" };

    expect(relevanceForResult(wrong, candidate)).toBe(0);
    expect(calculateQuality([wrong], candidate, 10)).toEqual({ mrr: 0, ndcg: 0, recall: 0 });
    expect(calculateQuality([right], candidate, 10)).toEqual({ mrr: 1, ndcg: 1, recall: 1 });
  });

  it("does not transfer relevance between sibling chunks from one turn", () => {
    const candidate: QueryCandidate = {
      answer: "Relevant answer",
      candidateId: "candidate",
      datasetId: "dataset",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ chunkIndex: 0, endLine: 2, sessionId: "session", startLine: 1 }],
      query: "Which sibling contains the answer?",
      queryType: "implementation",
      rationale: "Only the first child chunk answers the query.",
      review: {
        completeness: "complete",
        judgments: [
          { chunkIndex: 0, endLine: 2, reason: "Direct answer.", relevance: 3, sessionId: "session", startLine: 1 },
          { chunkIndex: 1, endLine: 2, reason: "Wrong sibling.", relevance: 0, sessionId: "session", startLine: 1 },
        ],
        reviewer: {
          model: "fixture",
          promptVersion: 1,
          provider: "fixture",
          relevanceThreshold: 2,
          reportedModels: ["fixture"],
          type: "llm",
        },
        status: "accepted",
      },
    };

    expect(relevanceForResult(result(1), candidate)).toBe(0);
    expect(calculateQuality([result(1)], candidate, 10)).toEqual({ mrr: 0, ndcg: 0, recall: 0 });
    expect(calculateQuality([result(0)], candidate, 10)).toEqual({ mrr: 1, ndcg: 1, recall: 1 });
  });
});
