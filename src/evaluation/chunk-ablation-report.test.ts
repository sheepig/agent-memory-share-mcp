// @vitest-environment jsdom
import { sessionReportHref } from "./session-report.js";
import { describe, expect, it } from "vitest";

import { renderChunkAblationHtmlReport, type ChunkAblationReport, type ChunkAblationVariantReport } from "./chunk-ablation-report.js";

function variant(id: string, recall: number, duplicateRate: number): ChunkAblationVariantReport {
  const quality = { hit: 1, pooledTurnRecall: recall, sameTurnDuplicateRate: duplicateRate };
  const turnMetrics = { at5: quality, at10: quality, at20: quality };
  const chunkMetrics = { mrrAt10: 1, ndcgAt10: 0.5, recallAt5: 0.5, recallAt10: 0.5, recallAt20: 0.5 };
  const standardEvaluation = { datasets: [], irMeasuresCommand: null, trecEvalCommand: null, status: "not_configured" as const };
  return {
    id, maxContentTokens: 1024, overlapContentTokens: 64, reportFile: `${id}/report.json`, htmlReportFile: `${id}/report.html`, standardEvaluation,
    datasets: [{
      agent: "codex", datasetId: "dataset", avgContentTokens: 500, p95ContentTokens: 1000,
      databaseBytes: 1024, databaseScanMs: 1, fragments: 4, indexMs: 2, peakRssBytes: 1024,
      relevantJudgedPassages: 3, sessions: 1, splitTurns: 1,
      scan: { failed: 0, indexed: 1, memories: 0, sessions: 1, unavailable: 0 },
      searches: { keyword: { ...chunkMetrics, latencyMs: { p50: 1, p95: 2, p99: 3 }, ndcgGain: "linear_graded_0_3_trec_eval", queries: 1, runsPerQuery: 1, turnMetrics } },
      queries: [{
        candidateId: "query", query: "How does <script>unsafe()</script> work?", mode: "keyword",
        chunkMetrics, latencyMs: { p50: 1, p95: 2, p99: 3 }, turnMetrics,
        ranking: [{
          rank: 1, sessionId: "session", location: "line:1", endLocation: "line:2", chunkIndex: 0,
          passageId: "passage", relevance: 3, sourcePath: '/synthetic/<img src=x onerror="unsafe()">.jsonl',
        }],
      }],
    }],
  };
}

function report(): ChunkAblationReport {
  return {
    schemaVersion: 1, baselineVariantId: "baseline", finishedAt: new Date(0).toISOString(), modes: ["keyword"], querySplit: "test",
    inputHashes: { manifestSha256: "manifest", poolSha256: "pool", qrelsSha256: "qrels" },
    qrels: { accepted: 1, rejected: 0, total: 1, reviewers: { fixture: 1 } },
    pooledTurnReferences: [{
      candidateId: "query", datasetId: "dataset", relevanceThreshold: 2,
      relevantTurns: [{ sessionId: "session", location: "line:1", endLocation: "line:2" }, { sessionId: "session", location: "line:3", endLocation: "line:4" }],
    }],
    // Baseline selection must follow the recorded ID, regardless of array order.
    variants: [variant("improved", 1, 0.25), variant("baseline", 0.5, 0.5)],
  };
}

describe("chunk ablation comparison report", () => {
  it("shows per-query metrics and signed deltas against the recorded baseline", () => {
    document.documentElement.innerHTML = renderChunkAblationHtmlReport(report());
    const query = document.querySelector('details[data-query="query"][data-dataset="dataset"]')!;
    expect(query.textContent).toContain("Fixed relevant pooled turns: 2");
    const improved = query.querySelector('table.query-comparison tr[data-variant="improved"]')!;
    const cells = improved.querySelectorAll("td");
    expect(cells).toHaveLength(9);
    expect(cells[2]?.textContent).toContain("10: 100.0% +50.0 pp");
    expect(cells[3]?.textContent).toContain("10: 100.0% +0.0 pp");
    expect(cells[4]?.textContent).toContain("10: 25.0% -25.0 pp");
    expect(query.querySelectorAll("details.ranking")).toHaveLength(2);
    expect(query.textContent).toContain("3 (relevant)");
    expect(query.textContent).toContain("line:1–line:2");
    expect(query.querySelector("li a")?.getAttribute("href")).toBe(sessionReportHref("dataset", "session", "line:1"));
    expect(query.querySelector("details.ranking a")?.getAttribute("href")).toBe(sessionReportHref("dataset", "session", "line:1"));
    for (const table of document.querySelectorAll("table")) {
      const columns = table.querySelectorAll("thead th").length;
      for (const row of table.querySelectorAll("tbody tr")) expect(row.querySelectorAll("td").length).toBe(columns);
    }
  });

  it("escapes query and source metadata and keeps the report self-contained", () => {
    document.documentElement.innerHTML = renderChunkAblationHtmlReport(report());
    expect(document.querySelectorAll("script,img,iframe,link")).toHaveLength(0);
    expect(document.body.textContent).toContain("<script>unsafe()</script>");
    expect(document.body.textContent).toContain('/synthetic/<img src=x onerror="unsafe()">.jsonl');
    expect(document.body.textContent).toContain("not exhaustive corpus recall");
  });
});
