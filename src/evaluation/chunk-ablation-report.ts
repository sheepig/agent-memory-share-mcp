import fs from "node:fs/promises";

import { sessionReportHref } from "./session-report.js";

import type { SourceScanResult } from "../application/source-service.js";
import type { PooledTurnMetrics, PooledTurnMetricsAtCutoffs, PooledTurnReference } from "./chunk-ablation-metrics.js";
import type { BenchmarkSearchMetrics } from "./html-report.js";
import type { NativeMetrics, StandardEvaluationResult } from "./standard-evaluation.js";

export interface ChunkAblationSearchMetrics extends BenchmarkSearchMetrics {
  turnMetrics: PooledTurnMetricsAtCutoffs;
}

export interface ChunkAblationQueryReport {
  candidateId: string;
  chunkMetrics: NativeMetrics;
  latencyMs: { p50: number; p95: number; p99: number };
  mode: string;
  query: string;
  ranking: Array<{
    chunkIndex?: number;
    endLocation: string;
    location: string;
    passageId: string;
    rank: number;
    relevance: number | null;
    sessionId: string;
    sourcePath: string;
  }>;
  turnMetrics: PooledTurnMetricsAtCutoffs;
}

export interface ChunkAblationDatasetReport {
  agent: string;
  avgContentTokens: number;
  databaseBytes: number;
  databaseScanMs: number;
  datasetId: string;
  fragments: number;
  indexMs: number;
  peakRssBytes: number;
  p95ContentTokens: number;
  relevantJudgedPassages: number;
  queries: ChunkAblationQueryReport[];
  scan: SourceScanResult;
  searches: Record<string, ChunkAblationSearchMetrics>;
  sessions: number;
  splitTurns: number;
}

export interface ChunkAblationVariantReport {
  datasets: ChunkAblationDatasetReport[];
  htmlReportFile: string;
  id: string;
  maxContentTokens: number;
  overlapContentTokens: number;
  reportFile: string;
  standardEvaluation: StandardEvaluationResult;
}

export interface ChunkAblationReport {
  allowUnjudgedResults?: boolean;
  baselineVariantId: string;
  finishedAt: string;
  inputHashes: { manifestSha256: string; poolSha256: string; qrelsSha256: string };
  keywordQueryRuleVersion?: string;
  modes: string[];
  pooledTurnReferences: PooledTurnReference[];
  qrels: { accepted: number; rejected: number; reviewers: Record<string, number>; total: number };
  querySplit: string;
  schemaVersion: 1;
  variants: ChunkAblationVariantReport[];
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function delta(value: number, baseline: number): string {
  const points = (value - baseline) * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

function turnMetricCells(metrics: PooledTurnMetricsAtCutoffs, baseline: PooledTurnMetricsAtCutoffs): string {
  return (["pooledTurnRecall", "hit", "sameTurnDuplicateRate"] as Array<keyof PooledTurnMetrics>).map((name) => `<td>${
    ([5, 10, 20] as const).map((k) => {
      const cutoff = `at${k}` as keyof PooledTurnMetricsAtCutoffs;
      return `<div class="cutoff">${k}: ${percentage(metrics[cutoff][name])} <small>${delta(metrics[cutoff][name], baseline[cutoff][name])}</small></div>`;
    }).join("")
  }</td>`).join("");
}

function queryComparisons(report: ChunkAblationReport, baseline: ChunkAblationVariantReport): string {
  return report.pooledTurnReferences.map((reference) => {
    const baseQueries = baseline.datasets.find((dataset) => dataset.datasetId === reference.datasetId)?.queries
      .filter((query) => query.candidateId === reference.candidateId) ?? [];
    const rows: string[] = [];
    const rankings: string[] = [];
    for (const variant of report.variants) {
      const queries = variant.datasets.find((dataset) => dataset.datasetId === reference.datasetId)?.queries
        .filter((query) => query.candidateId === reference.candidateId) ?? [];
      for (const query of queries) {
        const base = baseQueries.find((value) => value.mode === query.mode);
        if (!base) throw new Error(`Ablation baseline is missing query ${reference.candidateId}/${query.mode}.`);
        rows.push(`<tr data-variant="${escapeHtml(variant.id)}" data-mode="${escapeHtml(query.mode)}">
          <td>${escapeHtml(variant.id)}</td><td>${escapeHtml(query.mode)}</td>
          ${turnMetricCells(query.turnMetrics, base.turnMetrics)}
          <td>${percentage(query.chunkMetrics.recallAt10)}<small>${delta(query.chunkMetrics.recallAt10, base.chunkMetrics.recallAt10)}</small></td>
          <td>${percentage(query.chunkMetrics.mrrAt10)}<small>${delta(query.chunkMetrics.mrrAt10, base.chunkMetrics.mrrAt10)}</small></td>
          <td>${percentage(query.chunkMetrics.ndcgAt10)}<small>${delta(query.chunkMetrics.ndcgAt10, base.chunkMetrics.ndcgAt10)}</small></td>
          <td>${query.latencyMs.p50.toFixed(1)} ms</td>
        </tr>`);
        const rankedRows = query.ranking.map((result) => `<tr>
          <td>${result.rank}</td><td>${escapeHtml(result.sessionId)}</td>
          <td>${escapeHtml(result.location)}–${escapeHtml(result.endLocation)}<small>chunk ${result.chunkIndex ?? "—"}</small></td>
          <td>${result.relevance ?? "unjudged"}${result.relevance !== null && result.relevance >= reference.relevanceThreshold ? " (relevant)" : ""}</td>
          <td><code>${escapeHtml(result.passageId)}</code></td><td><a href="${sessionReportHref(reference.datasetId, result.sessionId, result.location)}">${escapeHtml(result.sourcePath)}</a></td>
        </tr>`).join("");
        rankings.push(`<details class="ranking"><summary>${escapeHtml(variant.id)} / ${escapeHtml(query.mode)} · ${query.ranking.length} results</summary>
          <div class="table"><table><thead><tr><th>Rank</th><th>Session</th><th>Turn location / chunk</th><th>Relevance</th><th>Passage ID</th><th>Source path</th></tr></thead><tbody>${rankedRows || '<tr><td colspan="6">No results</td></tr>'}</tbody></table></div></details>`);
      }
    }
    const turns = reference.relevantTurns.map((turn) => `<li><a href="${sessionReportHref(reference.datasetId, turn.sessionId, turn.location)}"><code>${escapeHtml(turn.sessionId)} · ${escapeHtml(turn.location)}–${escapeHtml(turn.endLocation)}</code></a></li>`).join("");
    return `<details class="query" id="query-${escapeHtml(reference.candidateId)}" data-query="${escapeHtml(reference.candidateId)}" data-dataset="${escapeHtml(reference.datasetId)}">
      <summary>${escapeHtml(baseQueries[0]?.query ?? reference.candidateId)} <small>${escapeHtml(reference.datasetId)} / ${escapeHtml(reference.candidateId)}</small></summary>
      <p>Fixed relevant pooled turns: ${reference.relevantTurns.length}. Passage relevance threshold: ${reference.relevanceThreshold}. All deltas compare with ${escapeHtml(baseline.id)}.</p>
      <ul>${turns}</ul>
      <div class="table"><table class="query-comparison"><thead><tr><th>Variant</th><th>Mode</th><th>Pooled Turn Recall@K</th><th>Hit@K</th><th>Same-turn duplicate rate@K ↓</th><th>Chunk Recall@10</th><th>MRR@10</th><th>Chunk nDCG@10</th><th>p50 latency</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
      ${rankings.join("")}
    </details>`;
  }).join("\n");
}

export function renderChunkAblationHtmlReport(report: ChunkAblationReport): string {
  const baseline = report.variants.find((variant) => variant.id === report.baselineVariantId);
  if (!baseline) throw new Error(`Ablation baseline is missing: ${report.baselineVariantId}.`);
  const baselineMetrics = new Map(baseline.datasets.flatMap((dataset) => Object.entries(dataset.searches).map(([mode, metrics]) => [
    `${dataset.datasetId}\0${mode}`,
    metrics,
  ] as const)));
  const rows = report.variants.flatMap((variant) => variant.datasets.flatMap((dataset) => Object.entries(dataset.searches).map(([mode, metrics]) => {
    const reference = baselineMetrics.get(`${dataset.datasetId}\0${mode}`);
    if (!reference) throw new Error(`Ablation baseline is missing ${dataset.datasetId}/${mode}.`);
    return `<tr>
      <td><a href="${escapeHtml(`${variant.id}/report.html`)}">${escapeHtml(variant.id)}</a></td>
      <td>${escapeHtml(dataset.datasetId)}</td><td>${escapeHtml(mode)}</td>
      <td>${variant.maxContentTokens} / ${variant.overlapContentTokens}</td>
      <td>${metrics.queries}</td><td>${dataset.fragments}</td><td>${dataset.splitTurns}</td>
      <td>${dataset.avgContentTokens.toFixed(0)} / ${dataset.p95ContentTokens.toFixed(0)}</td><td>${dataset.relevantJudgedPassages}</td>
      ${turnMetricCells(metrics.turnMetrics, reference.turnMetrics)}
      <td>${percentage(metrics.recallAt10)} <small>${delta(metrics.recallAt10, reference.recallAt10)}</small></td>
      <td>${percentage(metrics.mrrAt10)} <small>${delta(metrics.mrrAt10, reference.mrrAt10)}</small></td>
      <td>${percentage(metrics.ndcgAt10)} <small>${delta(metrics.ndcgAt10, reference.ndcgAt10)}</small></td>
      <td>${metrics.latencyMs.p95.toFixed(1)} ms</td><td>${dataset.indexMs.toFixed(1)} ms</td>
      <td>${(dataset.databaseBytes / 1024 / 1024).toFixed(2)} MiB</td>
    </tr>`;
  }))).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chunk parameter ablation</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#202124;background:#fafaf7;margin:0;padding:36px}main{max-width:1500px;margin:auto}h1{font-size:30px;margin:0 0 8px}p{color:#565852;max-width:100ch}table{border-collapse:collapse;width:100%;background:#fff}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left;white-space:nowrap}th{background:#eceee9;font-size:12px}small{display:block;color:#666}.cutoff small{display:inline;margin-left:6px}a{color:#245a47}code{overflow-wrap:anywhere}.table{overflow-x:auto;border:1px solid #ddd}.query{margin:18px 0;border:1px solid #ddd;padding:16px}.query>summary{font-size:17px;cursor:pointer}.query:target{border:2px solid #245a47}.ranking{margin-top:12px}.ranking summary{cursor:pointer;padding:8px}footer{margin-top:24px;border-top:1px solid #ddd;padding-top:14px}@media print{body{padding:12px}}</style></head>
<body><main><h1>Chunk parameter ablation</h1>
${report.allowUnjudgedResults ? '<p><strong>Diagnostic run: Unjudged results are allowed.</strong> Existing pooled judgments are reused. Unjudged passages stay marked unjudged and contribute zero gain to reported metrics. Inspect Judged@10 in each variant report; these scores do not establish relevance for newly retrieved passages.</p>' : ""}
<p>Baseline: ${escapeHtml(report.baselineVariantId)}. All variants use the same frozen Sessions and query split (${escapeHtml(report.querySplit)}). Relevance was judged once for the union of pooled passages. Pooled Turn Recall uses the same relevant-turn denominator for every variant and measures coverage of this judged union, not exhaustive corpus recall. Only passages meeting the relevance threshold contribute a hit.</p>
<p>K = 5, 10, 20 in each metric cell. Hit@K indicates at least one relevant passage. Same-turn duplicate rate counts repeated turn positions among the actual returned top-K results (lower is better). Aggregate scores are query means. Chunk Recall and nDCG remain auxiliary metrics: their relevant-passage sets and denominators can differ across variants.</p>
<p>Reviewed queries: ${report.qrels.accepted} accepted, ${report.qrels.rejected} rejected. Reviewers: ${escapeHtml(Object.entries(report.qrels.reviewers).map(([name, count]) => `${name} (${count})`).join(", "))}.</p>
<div class="table"><table><thead><tr><th>Variant</th><th>Dataset</th><th>Mode</th><th>Size / overlap</th><th>Queries</th><th>Fragments</th><th>Split turns</th><th>Avg / p95 tokens</th><th>Relevant judged passages</th><th>Pooled Turn Recall@K</th><th>Hit@K</th><th>Same-turn duplicate rate@K ↓</th><th>Chunk Recall@10</th><th>MRR@10</th><th>Chunk nDCG@10</th><th>p95 latency</th><th>Index time</th><th>SQLite</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Per-query comparison</h2>
<p>Each query retains the same relevant pooled turns across variants. Expand a query to compare values and percentage-point deltas, then inspect ranked passage judgments and original source locations.</p>
${queryComparisons(report, baseline)}
<footer><p>Finished ${escapeHtml(report.finishedAt)}. Detailed Session and query rankings are in each variant report. Reports omit Session body text.</p>
<p>Keyword query rule: ${escapeHtml(report.keywordQueryRuleVersion ?? "not recorded")}.</p>
<p>Manifest SHA-256 <code>${escapeHtml(report.inputHashes.manifestSha256)}</code><br>Pool SHA-256 <code>${escapeHtml(report.inputHashes.poolSha256)}</code><br>Qrels SHA-256 <code>${escapeHtml(report.inputHashes.qrelsSha256)}</code></p></footer>
</main></body></html>`;
}

export async function writeChunkAblationHtmlReport(file: string, report: ChunkAblationReport): Promise<void> {
  await fs.writeFile(file, renderChunkAblationHtmlReport(report), { mode: 0o600 });
}
