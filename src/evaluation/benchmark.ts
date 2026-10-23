import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import type { FragmentSearchResult, SourceReference } from "../domain/source.js";
import { createSourceService } from "../application/source-service.js";
import { DEFAULT_EMBEDDING_MODEL, LocalContentTokenizer, LocalEmbeddingProvider } from "../search/embedding.js";
import { ClaudeSessionAdapter, CodexSessionAdapter } from "../sources/desktop-sources.js";
import type { SessionSourceAdapter } from "../sources/source-adapter.js";
import type { ContentTokenCounter, SessionChunkOptions } from "../sources/session-turns.js";
import { openDatabase } from "../storage/database.js";
import { readQueryCandidates, writeJsonFile } from "./files.js";
import { writeEvaluationHtmlReport, type BenchmarkSearchMetrics } from "./html-report.js";
import { KEYWORD_QUERY_RULE_VERSION } from "../search/tokens.js";
import { writeSessionReportPages } from "./session-report.js";
import { validateEvaluationManifest } from "./manifest-validation.js";
import { calculateQuality } from "./metrics.js";
import {
  runStandardEvaluation,
  type NativeMetrics,
  type StandardRun,
} from "./standard-evaluation.js";
import type {
  EvaluationConfig,
  EvaluationManifest,
  EvaluationManifestDataset,
  QueryCandidate,
} from "./types.js";

export class ManifestSessionAdapter implements SessionSourceAdapter {
  readonly agent: string;
  readonly key: string;
  private readonly delegate: SessionSourceAdapter;

  constructor(private readonly dataset: EvaluationManifestDataset, contentTokenCounter: ContentTokenCounter, chunkOptions?: SessionChunkOptions) {
    this.agent = dataset.agent;
    this.key = `evaluation:${dataset.id}:${dataset.agent}`;
    this.delegate = dataset.agent === "codex"
      ? new CodexSessionAdapter("", contentTokenCounter, undefined, chunkOptions)
      : new ClaudeSessionAdapter("", contentTokenCounter, undefined, chunkOptions);
  }

  async *discover(): AsyncIterable<SourceReference> {
    for (const session of this.dataset.sessions) {
      yield {
        agent: this.agent,
        contentFingerprint: session.contentFingerprint,
        projectPath: session.projectPath,
        sourceId: session.sourceId,
        sourcePath: session.sourcePath,
        sourceType: "session",
        title: session.title,
        updatedAt: new Date(session.updatedAt),
      };
    }
  }

  extract(source: SourceReference) {
    return this.delegate.extract(source);
  }

  readConversation(source: SourceReference) {
    return this.delegate.readConversation(source);
  }
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)]!;
}

export function qrelsSummary(candidates: readonly QueryCandidate[]) {
  const reviewers: Record<string, number> = {};
  for (const candidate of candidates) {
    const reviewer = candidate.review.reviewer;
    const key = typeof reviewer === "string"
      ? "human:legacy"
      : reviewer?.type === "llm"
        ? `llm:${reviewer.provider}:${reviewer.model}`
        : reviewer?.type === "human"
          ? "human"
          : "unspecified";
    reviewers[key] = (reviewers[key] ?? 0) + 1;
  }
  return {
    accepted: candidates.filter((candidate) => candidate.review.status === "accepted").length,
    rejected: candidates.filter((candidate) => candidate.review.status === "rejected").length,
    reviewers,
    total: candidates.length,
  };
}

export function validateReviewedCandidates(candidates: readonly QueryCandidate[]): void {
  const pending = candidates.filter((candidate) => candidate.review.status === "pending");
  const incomplete = candidates.filter((candidate) => candidate.review.status !== "pending" && candidate.review.completeness !== "complete");
  if (pending.length > 0 || incomplete.length > 0) {
    throw new Error(`Qrels require complete review: ${pending.length} pending, ${incomplete.length} terminal but incomplete.`);
  }
}

function candidateSplit(candidate: QueryCandidate): "dev" | "validation" | "test" {
  return candidate.split ?? "test";
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateCandidatesAgainstManifest(candidates: readonly QueryCandidate[], manifest: EvaluationManifest): void {
  const sessionsByDataset = new Map(manifest.datasets.map((dataset) => [dataset.id, new Map(
    dataset.sessions.map((session) => [session.sourceId, session]),
  )]));
  for (const candidate of candidates) {
    const sessions = sessionsByDataset.get(candidate.datasetId);
    if (!sessions) throw new Error(`Qrels reference unknown dataset: ${candidate.datasetId}`);
    const units = [...candidate.goldSpans, ...(candidate.review.judgments ?? [])];
    for (const unit of units) {
      const session = sessions.get(unit.sessionId);
      if (!session) throw new Error(`Qrels reference unknown Session ${unit.sessionId} in ${candidate.datasetId}.`);
      const matchingChunks = session.chunks.filter((chunk) => {
        const start = /^line:(\d+)$/u.exec(chunk.location);
        const end = /^line:(\d+)$/u.exec(chunk.endLocation ?? chunk.location);
        return start && end
          && Number(start[1]) === unit.startLine
          && Number(end[1]) === unit.endLine
          && (unit.chunkIndex === undefined || unit.chunkIndex === chunk.chunkIndex);
      });
      if (matchingChunks.length === 0) {
        throw new Error(`Qrels reference unknown chunk ${unit.sessionId}:${unit.startLine}-${unit.endLine}:${unit.chunkIndex ?? "legacy"}.`);
      }
      if (unit.chunkIndex === undefined && matchingChunks.length > 1) {
        throw new Error(`Qrels reference an ambiguous legacy span ${unit.sessionId}:${unit.startLine}-${unit.endLine}; add chunkIndex.`);
      }
    }
  }
}

async function benchmarkDataset(
  config: EvaluationConfig,
  dataset: EvaluationManifestDataset,
  runDirectory: string,
  candidates: readonly QueryCandidate[],
) {
  const dataDirectory = path.join(runDirectory, dataset.id);
  const requiresEmbeddings = config.benchmark.modes.some((mode) => mode !== "keyword");
  const embeddingProvider = requiresEmbeddings
    ? new LocalEmbeddingProvider(config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache"))
    : undefined;
  const contentTokenCounter = embeddingProvider
    ?? new LocalContentTokenizer(config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache"));
  const database = openDatabase(dataDirectory);
  const adapter = new ManifestSessionAdapter(dataset, contentTokenCounter);
  const service = createSourceService(database, {
    adapters: { memories: [], sessions: [adapter] },
    contentTokenCounter,
    embeddingProvider,
    homeDirectory: "",
  });
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 25);
  try {
    const scanStarted = performance.now();
    const scan = await service.scanSources();
    const databaseScanMs = performance.now() - scanStarted;
    const sessions = [];
    for (let offset = 0; ; offset += 200) {
      const page = await service.listSessions({ agent: dataset.agent, limit: 200, offset });
      sessions.push(...page.sessions);
      if (sessions.length >= page.total) break;
    }
    const indexStarted = performance.now();
    let fragments = 0;
    for (const session of sessions) {
      const indexed = await service.indexSession(session.candidateId);
      fragments += indexed.fragmentCount;
    }
    const indexMs = performance.now() - indexStarted;
    const datasetCandidates = candidates.filter((candidate) => candidate.datasetId === dataset.id
      && candidateSplit(candidate) === config.benchmark.querySplit
      && candidate.queryQuality?.status !== "rejected"
      && candidate.review.status === "accepted");
    const searches: Record<string, BenchmarkSearchMetrics> = {};
    const standardRuns: StandardRun[] = [];
    for (const mode of config.benchmark.modes) {
      const latencies: number[] = [];
      const recall5: number[] = [];
      const recall10: number[] = [];
      const recall20: number[] = [];
      const mrr10: number[] = [];
      const ndcg10: number[] = [];
      for (const candidate of datasetCandidates) {
        for (let index = 0; index < config.benchmark.queryWarmupRuns; index += 1) {
          await service.searchFragments({ agent: dataset.agent, limit: 20, mode, query: candidate.query, sourceType: "session" });
        }
        let finalResults: FragmentSearchResult[] = [];
        const queryLatencies: number[] = [];
        for (let index = 0; index < config.benchmark.queryRuns; index += 1) {
          const started = performance.now();
          finalResults = (await service.searchFragments({ agent: dataset.agent, limit: 20, mode, query: candidate.query, sourceType: "session" })).results;
          const latency = performance.now() - started;
          latencies.push(latency);
          queryLatencies.push(latency);
        }
        standardRuns.push({ candidateId: candidate.candidateId, datasetId: dataset.id, latencyMs: queryLatencies, mode, results: finalResults });
        recall5.push(calculateQuality(finalResults, candidate, 5).recall);
        const at10 = calculateQuality(finalResults, candidate, 10);
        recall10.push(at10.recall);
        mrr10.push(at10.mrr);
        ndcg10.push(at10.ndcg);
        recall20.push(calculateQuality(finalResults, candidate, 20).recall);
      }
      searches[mode] = {
        latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
        mrrAt10: average(mrr10),
        ndcgGain: "linear_graded_0_3_trec_eval",
        ndcgAt10: average(ndcg10),
        queries: datasetCandidates.length,
        recallAt5: average(recall5),
        recallAt10: average(recall10),
        recallAt20: average(recall20),
        runsPerQuery: config.benchmark.queryRuns,
      };
    }
    database.pragma("wal_checkpoint(TRUNCATE)");
    const databaseBytes = (await fs.stat(path.join(dataDirectory, "agent-memory.sqlite"))).size;
    return { report: {
      agent: dataset.agent,
      databaseBytes,
      databaseScanMs,
      datasetId: dataset.id,
      fragments,
      indexMs,
      peakRssBytes,
      scan,
      searches,
      sessions: sessions.length,
    }, standardRuns };
  } finally {
    clearInterval(sampler);
    database.close();
  }
}

export async function runBenchmark(
  config: EvaluationConfig,
  manifest: EvaluationManifest,
  qrelsFile?: string,
): Promise<{ htmlReportFile: string; outputFile: string; report: Record<string, unknown> }> {
  await validateEvaluationManifest(config, manifest);
  const candidates = qrelsFile ? await readQueryCandidates(qrelsFile) : [];
  if (qrelsFile) {
    validateReviewedCandidates(candidates);
    validateCandidatesAgainstManifest(candidates, manifest);
  }
  const selectedCandidates = candidates.filter((candidate) => candidateSplit(candidate) === config.benchmark.querySplit);
  if (qrelsFile && selectedCandidates.every((candidate) => candidate.review.status !== "accepted" || candidate.queryQuality?.status === "rejected")) {
    throw new Error(`Qrels contain no accepted ${config.benchmark.querySplit} queries.`);
  }
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runDirectory = path.join(config.outputDirectory, `benchmark-${runId}`);
  const benchmarked = [];
  for (const dataset of manifest.datasets) benchmarked.push(await benchmarkDataset(config, dataset, runDirectory, selectedCandidates));
  const datasets = benchmarked.map((value) => value.report);
  const nativeMetrics = new Map<string, NativeMetrics>();
  for (const dataset of datasets) {
    for (const [mode, metrics] of Object.entries(dataset.searches)) {
      nativeMetrics.set(`${dataset.datasetId}\0${mode}`, metrics as NativeMetrics);
    }
  }
  const standardEvaluation = await runStandardEvaluation({
    candidates: selectedCandidates,
    nativeMetrics,
    outputDirectory: runDirectory,
    runs: benchmarked.flatMap((value) => value.standardRuns),
    tools: config.benchmark.standardTools,
  });
  const benchmark = {
      keywordQueryRuleVersion: KEYWORD_QUERY_RULE_VERSION,
      embeddingModel: config.benchmark.modes.some((mode) => mode !== "keyword") ? DEFAULT_EMBEDDING_MODEL : null,
      modes: config.benchmark.modes,
      querySplit: config.benchmark.querySplit,
      queryRuns: config.benchmark.queryRuns,
      queryWarmupRuns: config.benchmark.queryWarmupRuns,
  };
  const inputHashes = {
    manifestSha256: contentHash(manifest),
    qrelsSha256: qrelsFile ? contentHash(selectedCandidates) : null,
  };
  const qrels = qrelsFile ? qrelsSummary(selectedCandidates) : null;
  const finishedAt = new Date().toISOString();
  const report = {
    benchmark,
    datasets,
    finishedAt,
    manifestGeneratedAt: manifest.generatedAt,
    inputHashes,
    qrels,
    qrelsFile,
    rules: manifest.rules,
    schemaVersion: 1,
    standardEvaluation,
  };
  const outputFile = path.join(runDirectory, "report.json");
  const htmlReportFile = path.join(runDirectory, "report.html");
  await writeJsonFile(outputFile, report);
  await writeSessionReportPages(runDirectory, manifest, new LocalContentTokenizer(config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache")));
  await writeEvaluationHtmlReport(htmlReportFile, {
    benchmark,
    candidates: selectedCandidates,
    datasets,
    finishedAt,
    inputHashes,
    manifest,
    qrels,
    rules: manifest.rules,
    runs: benchmarked.flatMap((value) => value.standardRuns),
    standardEvaluation,
  });
  return { htmlReportFile, outputFile, report };
}
