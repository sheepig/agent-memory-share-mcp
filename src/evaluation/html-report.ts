import fs from "node:fs/promises";

import { sessionReportHref } from "./session-report.js";
import { calculateQuality, judgedAt, relevanceForResult, relevanceThreshold } from "./metrics.js";
import type { NativeMetrics, StandardEvaluationResult, StandardRun } from "./standard-evaluation.js";
import type { EvaluationManifest, QueryCandidate } from "./types.js";

export interface BenchmarkSearchMetrics extends NativeMetrics {
  latencyMs: { p50: number; p95: number; p99: number };
  ndcgGain: string;
  queries: number;
  runsPerQuery: number;
}

interface BenchmarkDatasetSummary {
  agent: string;
  databaseBytes: number;
  databaseScanMs: number;
  datasetId: string;
  fragments: number;
  indexMs: number;
  peakRssBytes: number;
  searches: Record<string, BenchmarkSearchMetrics>;
  sessions: number;
}

export interface StaticEvaluationReportInput {
  benchmark: {
    allowUnjudgedResults?: boolean;
    embeddingModel: string | null;
    keywordQueryRuleVersion?: string;
    modes: readonly string[];
    queryRuns: number;
    querySplit: string;
  };
  candidates: readonly QueryCandidate[];
  datasets: readonly BenchmarkDatasetSummary[];
  finishedAt: string;
  inputHashes: { manifestSha256: string; qrelsSha256: string | null };
  manifest: EvaluationManifest;
  qrels: null | { accepted: number; rejected: number; total: number };
  rules: EvaluationManifest["rules"];
  runs: readonly StandardRun[];
  standardEvaluation: StandardEvaluationResult;
  sessionReportPrefix?: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)]!;
}

function location(start: string, end: string | undefined): string {
  return end && end !== start ? `${start}–${end}` : start;
}

function standardJudgedAt10(input: StaticEvaluationReportInput, datasetId: string, mode: string): string {
  const standardMode = input.standardEvaluation.datasets
    .find((dataset) => dataset.datasetId === datasetId)?.modes.find((candidate) => candidate.mode === mode);
  return standardMode?.irMeasures.status === "passed" ? percent(standardMode.irMeasures.judgedAt10) : "—";
}

function aggregateRows(input: StaticEvaluationReportInput): string {
  return input.datasets.flatMap((dataset) => Object.entries(dataset.searches).map(([mode, metrics]) => `
    <tr>
      <th><strong>${escapeHtml(dataset.datasetId)}</strong><span>${escapeHtml(mode)}</span></th>
      <td>${metrics.queries}</td>
      <td>${percent(metrics.recallAt5)}</td>
      <td>${percent(metrics.recallAt10)}</td>
      <td>${percent(metrics.recallAt20)}</td>
      <td>${percent(metrics.mrrAt10)}</td>
      <td>${percent(metrics.ndcgAt10)}</td>
      <td>${standardJudgedAt10(input, dataset.datasetId, mode)}</td>
      <td>${metrics.latencyMs.p95.toFixed(1)} ms</td>
    </tr>`)).join("");
}

function resultRows(run: StandardRun, candidate: QueryCandidate, prefix: string): string {
  return run.results.slice(0, 20).map((result, index) => {
    const relevance = relevanceForResult(result, candidate);
    const threshold = relevanceThreshold(candidate);
    const state = relevance === null ? "unjudged" : relevance >= threshold ? "relevant" : relevance > 0 ? "partial" : "not-relevant";
    const label = relevance === null ? "unjudged" : `rel ${relevance}`;
    const details = [
      result.chunkIndex !== undefined ? `chunk ${result.chunkIndex}` : undefined,
      result.contentTokenCount !== undefined ? `${result.contentTokenCount} tokens` : undefined,
      result.passageId ? `passage ${result.passageId.slice(0, 12)}` : undefined,
    ].filter((value): value is string => value !== undefined).join(" · ");
    return `
      <tr>
        <td class="rank">${index + 1}</td>
        <td><code>${escapeHtml(result.sessionId ?? result.sourceId)}</code></td>
        <td><code>${escapeHtml(location(result.location, result.endLocation))}</code>${details ? `<br><small>${escapeHtml(details)}</small>` : ""}</td>
        <td><span class="judgment ${state}">${label}</span></td>
        <td class="path" title="${escapeHtml(result.sourcePath)}"><a href="${sessionReportHref(candidate.datasetId, result.sessionId ?? result.sourceId, result.location, prefix)}">${escapeHtml(result.sourcePath)}</a></td>
      </tr>`;
  }).join("");
}

function queryBlock(candidate: QueryCandidate, runs: readonly StandardRun[], prefix: string): string {
  const candidateRuns = runs.filter((run) => run.candidateId === candidate.candidateId && run.datasetId === candidate.datasetId);
  const modes = candidateRuns.map((run, index) => {
    const at10 = calculateQuality(run.results, candidate, 10);
    const metrics = {
      judgedAt10: judgedAt(run.results, candidate, 10),
      latencyP50: percentile(run.latencyMs ?? [], 0.5),
      mrrAt10: at10.mrr,
      ndcgAt10: at10.ndcg,
      recallAt10: at10.recall,
      recallAt20: calculateQuality(run.results, candidate, 20).recall,
      recallAt5: calculateQuality(run.results, candidate, 5).recall,
    };
    return `
      <details class="mode"${index === 0 ? " open" : ""}>
        <summary>
          <strong>${escapeHtml(run.mode)}</strong>
          <span>R@10 ${percent(metrics.recallAt10)}</span>
          <span>MRR@10 ${percent(metrics.mrrAt10)}</span>
          <span>nDCG@10 ${percent(metrics.ndcgAt10)}</span>
          <span>Judged@10 ${percent(metrics.judgedAt10)}</span>
          <span>p50 ${metrics.latencyP50.toFixed(1)} ms</span>
        </summary>
        <div class="mode-metrics">
          <span>Recall@5 <strong>${percent(metrics.recallAt5)}</strong></span>
          <span>Recall@10 <strong>${percent(metrics.recallAt10)}</strong></span>
          <span>Recall@20 <strong>${percent(metrics.recallAt20)}</strong></span>
          <span>MRR@10 <strong>${percent(metrics.mrrAt10)}</strong></span>
          <span>nDCG@10 <strong>${percent(metrics.ndcgAt10)}</strong></span>
          <span>Judged@10 <strong>${percent(metrics.judgedAt10)}</strong></span>
        </div>
        <div class="ranking-wrap"><table class="ranking"><thead><tr><th>#</th><th>Result Session</th><th>Location</th><th>Judgment</th><th>Source path</th></tr></thead><tbody>${resultRows(run, candidate, prefix)}</tbody></table></div>
      </details>`;
  }).join("");
  return `
    <article class="query">
      <header><div><span class="query-type">${escapeHtml(candidate.queryType)}</span><h3>${escapeHtml(candidate.query)}</h3></div><code>${escapeHtml(candidate.candidateId.slice(0, 12))}</code></header>
      ${modes || '<p class="empty">No retrieval run was recorded for this query.</p>'}
    </article>`;
}

function sessionBlocks(input: StaticEvaluationReportInput): string {
  const accepted = input.candidates.filter((candidate) => candidate.review.status === "accepted" && candidate.queryQuality?.status !== "rejected");
  let opened = false;
  return input.manifest.datasets.flatMap((dataset) => dataset.sessions.map((session) => {
    const queries = accepted.filter((candidate) => candidate.datasetId === dataset.id
      && candidate.goldSpans.some((span) => span.sessionId === session.sourceId));
    const shouldOpen = !opened && queries.length > 0;
    if (shouldOpen) opened = true;
    const searchable = `${dataset.id} ${session.sourceId} ${session.title ?? ""} ${session.projectPath ?? ""}`.toLocaleLowerCase();
    return `
      <details class="session" data-session data-search="${escapeHtml(searchable)}"${shouldOpen ? " open" : ""}>
        <summary>
          <span class="session-state ${queries.length > 0 ? "covered" : "uncovered"}"></span>
          <span class="session-name"><strong>${escapeHtml(session.title ?? session.sourceId)}</strong><code>${escapeHtml(session.sourceId)}</code></span>
          <span>${escapeHtml(dataset.id)}</span>
          <span>${session.chunks.length} fragments</span>
          <span>${queries.length} queries</span>
        </summary>
        <div class="session-body">
          <dl class="session-meta">
            <div><dt>Source path</dt><dd><a href="${sessionReportHref(dataset.id, session.sourceId, undefined, input.sessionReportPrefix)}"><code>${escapeHtml(session.sourcePath)}</code></a></dd></div>
            <div><dt>Project</dt><dd><code>${escapeHtml(session.projectPath ?? "not supplied")}</code></dd></div>
            <div><dt>Size</dt><dd>${bytes(session.byteSize)}</dd></div>
            <div><dt>Updated</dt><dd>${escapeHtml(session.updatedAt)}</dd></div>
          </dl>
          ${queries.length > 0 ? queries.map((candidate) => queryBlock(candidate, input.runs, input.sessionReportPrefix ?? "")).join("") : '<p class="empty">This Session has no accepted query in the selected split.</p>'}
        </div>
      </details>`;
  })).join("");
}

export function renderEvaluationHtmlReport(input: StaticEvaluationReportInput): string {
  const totalSessions = input.manifest.datasets.reduce((sum, dataset) => sum + dataset.sessions.length, 0);
  const standardPassed = input.standardEvaluation.status === "passed";
  const emptyRunChecks = input.standardEvaluation.datasets.flatMap((dataset) => dataset.modes
    .filter((mode) => mode.trecEval.status === "skipped_empty_run")
    .map((mode) => `${dataset.datasetId}/${mode.mode}`));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Retrieval evaluation report</title>
  <style>
    .session-meta dd a{display:block;overflow:hidden;text-overflow:ellipsis}
    :root{color:#202124;background:#fbfbf8;font:14px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none}*{box-sizing:border-box}body{margin:0}code{font:12px/1.5 "SFMono-Regular",Consolas,monospace}.page{margin:auto;max-width:1440px;padding:44px 48px 72px}.masthead{border-bottom:3px solid #202124;display:grid;gap:24px;grid-template-columns:minmax(0,1fr) auto;padding-bottom:28px}.masthead h1{font-size:42px;letter-spacing:-.045em;line-height:1;margin:0 0 14px}.masthead p{color:#60615e;margin:0;max-width:70ch}.run-status{align-self:start;border:1px solid #b9bab4;display:flex;gap:22px;padding:12px 14px}.run-status div{display:grid;gap:2px}.run-status small,.meta-label{color:#73746f;font-size:10px}.run-status strong{font-size:13px}.passed{color:#2f6b4f}.not-configured{color:#a65a2e}.run-facts{display:grid;gap:1px;grid-template-columns:repeat(4,1fr);margin:22px 0 34px}.run-facts div{background:#eff0eb;padding:14px 16px}.run-facts strong{display:block;font-size:16px;margin-top:3px}.section-title{align-items:end;display:flex;justify-content:space-between;margin:34px 0 11px}.section-title h2{font-size:20px;margin:0}.section-title p{color:#73746f;font-size:12px;margin:0}.aggregate-wrap,.ranking-wrap{border:1px solid #d7d8d2;overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e2e3de;padding:11px 12px;text-align:left;white-space:nowrap}thead th{background:#f1f2ed;color:#5e5f5b;font-size:10px}tbody tr:last-child>*{border-bottom:0}.aggregate th strong,.aggregate th span{display:block}.aggregate th span{color:#777873;font-size:10px;font-weight:400;margin-top:2px}.session-tools{align-items:center;display:flex;gap:12px}.session-tools input{background:#fff;border:1px solid #bfc0ba;border-radius:0;font:inherit;padding:8px 10px;width:280px}.session-list{border-top:2px solid #202124}.session{border-bottom:1px solid #cfd0ca}.session>summary{align-items:center;cursor:pointer;display:grid;gap:14px;grid-template-columns:10px minmax(260px,1.5fr) 1fr 110px 90px;list-style:none;padding:15px 12px}.session>summary::-webkit-details-marker,.mode>summary::-webkit-details-marker{display:none}.session>summary:hover{background:#f3f4ef}.session-name{display:grid}.session-name strong{font-size:14px}.session-name code{color:#767772;font-size:10px}.session-state{border-radius:50%;height:8px;width:8px}.session-state.covered{background:#2f6b4f}.session-state.uncovered{background:#b8b9b4}.session-body{background:#fff;border-top:1px solid #d7d8d2;padding:18px 20px 24px}.session-meta{display:grid;gap:10px;grid-template-columns:2fr 2fr .5fr 1fr;margin:0 0 22px}.session-meta div{min-width:0}.session-meta dt{color:#797a75;font-size:10px}.session-meta dd{margin:3px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.query{border-top:1px solid #d7d8d2;padding:22px 0 2px}.query>header{align-items:start;display:flex;gap:20px;justify-content:space-between}.query h3{font-size:17px;line-height:1.4;margin:4px 0 15px;max-width:78ch}.query-type{color:#5f605c;font-size:10px}.query>header>code{color:#858681}.mode{border:1px solid #d7d8d2;margin:8px 0 12px}.mode>summary{align-items:center;background:#f7f7f3;cursor:pointer;display:flex;flex-wrap:wrap;gap:9px 20px;list-style:none;padding:10px 12px}.mode>summary strong{margin-right:auto}.mode>summary span{color:#5d5e5a;font-size:11px}.mode-metrics{display:grid;gap:1px;grid-template-columns:repeat(6,1fr)}.mode-metrics span{background:#f1f2ed;color:#6b6c67;font-size:10px;padding:9px 11px}.mode-metrics strong{color:#202124;display:block;font-size:12px;margin-top:2px}.ranking{font-size:11px}.ranking .rank{color:#777873;text-align:right;width:40px}.ranking .path{max-width:340px;overflow:hidden;text-overflow:ellipsis}.judgment{border:1px solid;padding:2px 6px}.judgment.relevant{border-color:#75a18d;color:#2f6b4f}.judgment.partial{border-color:#d49a75;color:#8b4d27}.judgment.not-relevant{border-color:#c9cac4;color:#73746f}.judgment.unjudged{border-color:#d7d8d2;color:#8a8b86}.empty{color:#777873;margin:12px 0}.hashes{border-top:1px solid #d7d8d2;display:grid;gap:8px;margin-top:34px;padding-top:16px}.hashes div{display:grid;gap:12px;grid-template-columns:140px minmax(0,1fr)}.hashes code{overflow-wrap:anywhere}@media(max-width:800px){.page{padding:28px 18px}.masthead{grid-template-columns:1fr}.run-status{justify-content:space-between}.run-facts{grid-template-columns:1fr 1fr}.session>summary{grid-template-columns:10px minmax(0,1fr) 70px}.session>summary>span:nth-child(3),.session>summary>span:nth-child(4){display:none}.session-meta{grid-template-columns:1fr}.mode-metrics{grid-template-columns:1fr 1fr 1fr}.session-tools{align-items:stretch;flex-direction:column}.session-tools input{width:100%}}@media print{.page{max-width:none;padding:20px}.session{break-inside:avoid}.session-tools{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style>
</head>
<body>
  <main class="page">
    <header class="masthead">
      <div><h1>Retrieval evaluation</h1><p>Static benchmark evidence for a frozen corpus and query split. Expand a Session to inspect its queries, per-mode measures, and ranked provenance.</p></div>
      <div class="run-status"><div><small>STANDARD CHECK</small><strong class="${standardPassed ? "passed" : "not-configured"}">${standardPassed ? emptyRunChecks.length > 0 ? "standard checks passed" : "trec_eval passed" : "not configured"}</strong></div><div><small>FINISHED</small><strong>${escapeHtml(input.finishedAt)}</strong></div></div>
    </header>
    ${input.benchmark.allowUnjudgedResults ? '<p><strong>Diagnostic run: Unjudged results are allowed.</strong> Existing pooled judgments are reused; unjudged passages contribute zero gain. Check Judged@10 before interpreting quality differences.</p>' : ""}
    <section class="run-facts">
      <div><span class="meta-label">QUERY SPLIT</span><strong>${escapeHtml(input.benchmark.querySplit)}</strong></div>
      <div><span class="meta-label">QUERIES</span><strong>${input.qrels?.accepted ?? input.candidates.length}</strong></div>
      <div><span class="meta-label">SESSIONS</span><strong>${totalSessions}</strong></div>
      <div><span class="meta-label">MODES</span><strong>${escapeHtml(input.benchmark.modes.join(" / "))}</strong></div>
    </section>
    <section><div class="section-title"><h2>Aggregate measures</h2><p>Validated native measures; Judged@10 is supplied by ir-measures when configured.</p></div><div class="aggregate-wrap"><table class="aggregate"><thead><tr><th>Dataset / mode</th><th>Queries</th><th>Recall@5</th><th>Recall@10</th><th>Recall@20</th><th>MRR@10</th><th>nDCG@10</th><th>Judged@10</th><th>p95</th></tr></thead><tbody>${aggregateRows(input)}</tbody></table></div></section>
    ${emptyRunChecks.length > 0 ? `<p>trec_eval skipped for empty result runs: ${escapeHtml(emptyRunChecks.join(", "))}. Their zero metrics were independently verified with ir-measures.</p>` : ""}
    <section><div class="section-title"><div><h2>Session detail</h2><p>Sessions without an accepted query remain visible as uncovered.</p></div><div class="session-tools"><label for="session-filter">Filter Session</label><input id="session-filter" type="search" placeholder="Session ID, title, project, dataset"></div></div><div class="session-list">${sessionBlocks(input)}</div></section>
    <footer class="hashes"><div><span>Manifest SHA-256</span><code>${escapeHtml(input.inputHashes.manifestSha256)}</code></div><div><span>Qrels SHA-256</span><code>${escapeHtml(input.inputHashes.qrelsSha256 ?? "not supplied")}</code></div><div><span>Rule versions</span><code>keyword query ${escapeHtml(input.benchmark.keywordQueryRuleVersion ?? "not recorded")}; index ${input.rules.indexRuleVersion}; sensitive ${input.rules.sensitiveContentRuleVersion}; app ${escapeHtml(input.rules.applicationVersion)}</code></div></footer>
  </main>
  <script>document.getElementById("session-filter").addEventListener("input",function(){const q=this.value.trim().toLocaleLowerCase();document.querySelectorAll("[data-session]").forEach(function(item){item.hidden=q!==""&&!item.dataset.search.includes(q)})})</script>
</body>
</html>`;
}

export async function writeEvaluationHtmlReport(file: string, input: StaticEvaluationReportInput): Promise<void> {
  await fs.writeFile(file, renderEvaluationHtmlReport(input), { mode: 0o600 });
}
