import { sessionReportHref } from "./session-report.js";
import { describe, expect, it } from "vitest";

import { renderEvaluationHtmlReport, type StaticEvaluationReportInput } from "./html-report.js";

function input(): StaticEvaluationReportInput {
  return {
    benchmark: { embeddingModel: null, modes: ["keyword"], queryRuns: 1, querySplit: "test" },
    candidates: [{
      answer: "An answer.",
      candidateId: "candidate-1",
      datasetId: "fixture",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ endLine: 4, sessionId: "session-1", startLine: 2 }],
      query: "How is <evidence> inspected?",
      queryType: "implementation",
      rationale: "The Session contains the evidence.",
      review: {
        completeness: "complete",
        judgments: [{ endLine: 4, reason: "Direct answer.", relevance: 3, sessionId: "session-1", startLine: 2 }],
        reviewer: { model: "fixture", promptVersion: 1, provider: "fixture", relevanceThreshold: 2, reportedModels: ["fixture"], type: "llm" },
        status: "accepted",
      },
      split: "test",
    }],
    datasets: [{
      agent: "codex",
      databaseBytes: 4096,
      databaseScanMs: 12,
      datasetId: "fixture",
      fragments: 1,
      indexMs: 24,
      peakRssBytes: 1024,
      searches: { keyword: { latencyMs: { p50: 2, p95: 2, p99: 2 }, mrrAt10: 1, ndcgAt10: 1, ndcgGain: "linear_graded_0_3_trec_eval", queries: 1, recallAt5: 1, recallAt10: 1, recallAt20: 1, runsPerQuery: 1 } },
      sessions: 1,
    }],
    finishedAt: "2026-10-20T00:00:00.000Z",
    inputHashes: { manifestSha256: "manifest-hash", qrelsSha256: "qrels-hash" },
    manifest: {
      datasets: [{
        agent: "codex",
        diagnostics: {},
        elapsedMs: 1,
        eligibleSessions: 1,
        id: "fixture",
        roots: ["/tmp/sessions"],
        sessions: [{
          byteSize: 128,
          chunks: [{ characters: 64, endLocation: "line:4", location: "line:2", ordinal: 0, turnCount: 1 }],
          contentFingerprint: "fingerprint",
          projectPath: "/workspace/project",
          relativePath: "session.jsonl",
          rootIndex: 0,
          sourceId: "session-1",
          sourcePath: "/tmp/sessions/session.jsonl",
          title: "Inspect evidence",
          updatedAt: "2026-10-20T00:00:00.000Z",
        }],
        sourceBytes: 128,
        sourceFilesVisited: 1,
        type: "local",
      }],
      generatedAt: "2026-10-20T00:00:00.000Z",
      rules: { applicationVersion: "0.1.0", indexRuleVersion: 1, sensitiveContentRuleVersion: 1 },
      schemaVersion: 1,
    },
    qrels: { accepted: 1, rejected: 0, total: 1 },
    rules: { applicationVersion: "0.1.0", indexRuleVersion: 1, sensitiveContentRuleVersion: 1 },
    runs: [{
      candidateId: "candidate-1",
      datasetId: "fixture",
      latencyMs: [2],
      mode: "keyword",
      results: [{
        agent: "codex",
        chunkIndex: 0,
        contentFingerprint: "fingerprint",
        contentTokenCount: 75,
        endLocation: "line:4",
        excerpt: "SECRET SESSION BODY",
        fragmentId: "fragment-1",
        location: "line:2",
        matchReason: "body match",
        passageId: "abcdef0123456789",
        sessionId: "session-1",
        sourceId: "session-1",
        sourcePath: "/tmp/sessions/session.jsonl",
        sourceType: "session",
        updatedAt: "2026-10-20T00:00:00.000Z",
      }],
    }],
    standardEvaluation: {
      datasets: [{ datasetId: "fixture", modes: [{
        artifacts: { binaryQrelsFile: "/tmp/qrels-binary.txt", qrelsFile: "/tmp/qrels.txt", runFile: "/tmp/run.txt", top10RunFile: "/tmp/run-top10.txt" },
        irMeasures: { judgedAt10: 0.1, status: "passed" },
        mode: "keyword",
        trecEval: { maxAbsoluteDelta: 0, metrics: { mrrAt10: 1, ndcgAt10: 1, recallAt5: 1, recallAt10: 1, recallAt20: 1 }, status: "passed" },
      }] }],
      irMeasuresCommand: "ir_measures",
      status: "passed",
      trecEvalCommand: "trec_eval",
    },
  };
}

describe("evaluation HTML report", () => {
  it("discloses empty-run checks without claiming trec_eval ran them", () => {
    const report = input();
    report.standardEvaluation.datasets[0]!.modes[0]!.trecEval = { status: "skipped_empty_run" };
    const html = renderEvaluationHtmlReport(report);
    expect(html).toContain("standard checks passed");
    expect(html).toContain("trec_eval skipped for empty result runs: fixture/keyword");
    expect(html).toContain("verified with ir-measures");
    expect(html).not.toContain("trec_eval passed");
  });

  it("renders aggregate and per-Session evidence without embedding Session body text", () => {
    const html = renderEvaluationHtmlReport(input());

    expect(html).toContain("Retrieval evaluation");
    expect(html).toContain("Inspect evidence");
    expect(html).toContain("session-1");
    expect(html).toContain("How is &lt;evidence&gt; inspected?");
    expect(html).toContain("rel 3");
    expect(html).toContain(`href="${sessionReportHref("fixture", "session-1", "line:2")}"`);
    const nested = input();
    nested.sessionReportPrefix = "../";
    expect(renderEvaluationHtmlReport(nested)).toContain(`href="${sessionReportHref("fixture", "session-1", "line:2", "../")}"`);
    expect(html).toContain("line:2–line:4");
    expect(html).toContain("chunk 0 · 75 tokens · passage abcdef012345");
    expect(html).toContain("trec_eval passed");
    expect(html).not.toContain("SECRET SESSION BODY");
    expect(html).not.toContain("<evidence>");
  });
});
