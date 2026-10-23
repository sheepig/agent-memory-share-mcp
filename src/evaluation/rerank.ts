import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { createSourceService } from "../application/source-service.js";
import { DEFAULT_EMBEDDING_MODEL, LocalEmbeddingProvider } from "../search/embedding.js";
import { mapFragmentSearchResult } from "../search/fragment-search.js";
import { LocalRerankerProvider, type RerankerProvider } from "../search/reranker.js";
import { diversifySessionChunks } from "../search/session-diversity.js";
import { KEYWORD_QUERY_RULE_VERSION } from "../search/tokens.js";
import { openDatabase } from "../storage/database.js";
import { ManifestSessionAdapter, qrelsSummary, validateCandidatesAgainstManifest, validateReviewedCandidates } from "./benchmark.js";
import { readCandidatePool, readQueryCandidates, writeJsonFile } from "./files.js";
import { writeEvaluationHtmlReport, type BenchmarkSearchMetrics } from "./html-report.js";
import { evaluationHash, passageIdFor, querySetHash } from "./identity.js";
import { validateEvaluationManifest } from "./manifest-validation.js";
import { calculateQuality, relevanceForResult, relevanceThreshold, type EvaluationSearchResult } from "./metrics.js";
import { sessionReportHref } from "./session-report.js";
import { runStandardEvaluation, type NativeMetrics, type StandardRun } from "./standard-evaluation.js";
import { candidatePoolSchema, type CandidatePool, type EvaluationConfig, type EvaluationManifest, type QueryCandidate } from "./types.js";

const hash = z.string().length(64);
const resultSchema = z.object({
  agent: z.string(), chunkIndex: z.number().int().nonnegative().optional(), contentFingerprint: z.string(),
  contentTokenCount: z.number().int().nonnegative().optional(), endLocation: z.string().optional(),
  endedAt: z.string().optional(), excerpt: z.literal(""), fragmentId: z.string(), location: z.string(),
  matchReason: z.string(), originalSessionId: z.string().optional(), passageId: hash,
  projectPath: z.string().optional(), role: z.enum(["assistant", "user"]).optional(), score: z.number().optional(),
  sessionId: z.string(), sourceId: z.string(), sourcePath: z.string(), sourceType: z.literal("session"),
  startedAt: z.string().optional(), title: z.string().optional(), turnCount: z.number().optional(), updatedAt: z.string(),
}).strict();
const summarySchema = z.object({
  databaseBytes: z.number(), databaseScanMs: z.number(), fragments: z.number(), indexMs: z.number(), sessions: z.number(),
});
const retrievalSchema = z.object({
  schemaVersion: z.literal(1), manifestSha256: hash, queriesSha256: hash, poolSha256: hash,
  keywordQueryRuleVersion: z.string().min(1),
  candidateCounts: z.array(z.number().int().positive()).min(1), queryRuns: z.number().int().positive(),
  queryWarmupRuns: z.number().int().nonnegative(),
  datasets: z.array(z.object({ datasetId: z.string(), summary: summarySchema })),
  queries: z.array(z.object({
    candidateId: z.string(), datasetId: z.string(), query: z.string(),
    latencyMs: z.array(z.number().nonnegative()).min(1), candidates: z.array(resultSchema),
    currentLatencyMs: z.array(z.number().nonnegative()).min(1), currentResults: z.array(resultSchema),
  })),
}).strict();
const checkpointSchema = z.object({
  binding: z.string(), modelId: z.string(), scores: z.array(z.number()),
  latencyMs: z.array(z.number().nonnegative()), peakRssBytes: z.number().nonnegative(),
}).strict();

type RerankConfig = EvaluationConfig;
type PoolResult = CandidatePool["queries"][number]["results"][number];
type Scorer = RerankerProvider & { dispose?(): Promise<void> };

function options(config: RerankConfig) {
  if (!config.reranker) throw new Error("Reranker evaluation configuration is required.");
  return config.reranker;
}

function progress(stage: string, fields: Record<string, unknown> = {}) {
  process.stderr.write(`${JSON.stringify({ stage, ...fields })}\n`);
}

function line(location: string): number {
  const match = /^line:(\d+)$/u.exec(location);
  if (!match) throw new Error(`Invalid passage line location: ${location}`);
  return Number(match[1]);
}

function selectedQueries(config: RerankConfig, candidates: QueryCandidate[]): QueryCandidate[] {
  const selected = candidates.filter((candidate) => (candidate.split ?? "test") === config.benchmark.querySplit
    && candidate.queryQuality?.status === "accepted" && candidate.review.status !== "rejected");
  const limited = selected.slice(0, options(config).queryLimit ?? selected.length);
  if (!limited.length) throw new Error("Reranker evaluation has no accepted-quality queries for this split.");
  if (new Set(limited.map((candidate) => candidate.candidateId)).size !== limited.length) throw new Error("Duplicate reranker query IDs.");
  return limited;
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)] ?? 0;
}

/** Prefix first, then score and diversify, so both runs have identical retrieval opportunities. */
export function rankRerankCandidates(candidates: readonly EvaluationSearchResult[], depth: number, scores?: readonly number[]): EvaluationSearchResult[] {
  const ranked = candidates.slice(0, depth).map((result, index) => ({ ...result,
    ...(scores ? { score: scores[index], matchReason: `${result.matchReason} + local cross-encoder` } : {}),
  }));
  if (scores) ranked.sort((a, b) => b.score! - a.score!);
  return diversifySessionChunks(ranked, (result) => result, 20);
}

/** Every recorded sample is a real model invocation; only complete checkpoints are resumed. */
export async function scoreRerankCheckpoint(file: string, provider: Scorer, input: {
  binding: string; passages: readonly string[]; query: string; runs: number;
}): Promise<z.infer<typeof checkpointSchema>> {
  try {
    const existing = checkpointSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    if (existing.binding !== input.binding || existing.modelId !== provider.modelId
      || existing.scores.length !== input.passages.length || existing.latencyMs.length !== input.runs) {
      throw new Error("Reranker checkpoint does not match frozen inputs or model.");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let scores: number[] = [];
  const latencyMs: number[] = [];
  for (let run = 0; run < input.runs; run += 1) {
    const started = performance.now();
    scores = await provider.score(input.query, input.passages);
    latencyMs.push(performance.now() - started);
    if (scores.length !== input.passages.length || scores.some((score) => !Number.isFinite(score))) {
      throw new Error("Reranker returned invalid scores.");
    }
  }
  const checkpoint = checkpointSchema.parse({ binding: input.binding, modelId: provider.modelId, scores, latencyMs,
    peakRssBytes: process.resourceUsage().maxRSS * 1024 });
  await writeJsonFile(file, checkpoint);
  return checkpoint;
}

export function rerankIndexDirectory(config: EvaluationConfig, manifest: EvaluationManifest): string {
  return path.join(config.outputDirectory, `rerank-index-${evaluationHash({ manifest, embeddingModel: DEFAULT_EMBEDDING_MODEL })}`);
}

export async function buildRerankPool(config: RerankConfig, manifest: EvaluationManifest, candidatesFile: string) {
  await validateEvaluationManifest(config, manifest);
  const selected = selectedQueries(config, await readQueryCandidates(candidatesFile));
  validateCandidatesAgainstManifest(selected, manifest);
  const settings = options(config);
  const depth = Math.max(...settings.candidateCounts);
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(config.outputDirectory, "rerank-pool-"));
  const queries: CandidatePool["queries"] = [];
  const retrievalQueries: z.infer<typeof retrievalSchema>["queries"] = [];
  const datasets: z.infer<typeof retrievalSchema>["datasets"] = [];
  for (const dataset of manifest.datasets) {
    const datasetQueries = selected.filter((candidate) => candidate.datasetId === dataset.id);
    if (!datasetQueries.length) continue;
    const dataDirectory = path.join(rerankIndexDirectory(config, manifest), dataset.id);
    const database = openDatabase(dataDirectory);
    const embeddingProvider = new LocalEmbeddingProvider(config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache"));
    const adapter = new ManifestSessionAdapter(dataset, embeddingProvider);
    const service = createSourceService(database, {
      adapters: { memories: [], sessions: [adapter] }, contentTokenCounter: embeddingProvider, embeddingProvider, homeDirectory: "",
    });
    try {
      const cachedFragments = (database.prepare("SELECT count(*) AS count FROM fragments").get() as { count: number }).count;
      const cachedEmbeddings = (database.prepare("SELECT count(*) AS count FROM fragment_embeddings").get() as { count: number }).count;
      progress("rerank_pool_index_open", { datasetId: dataset.id, cachedFragments, cachedEmbeddings });
      let started = performance.now();
      await service.scanSources();
      const databaseScanMs = performance.now() - started;
      const sessions = [];
      for (let offset = 0; ; offset += 200) {
        const page = await service.listSessions({ agent: dataset.agent, limit: 200, offset });
        sessions.push(...page.sessions);
        if (sessions.length >= page.total) break;
      }
      started = performance.now();
      for (const [index, session] of sessions.entries()) {
        await service.indexSession(session.candidateId);
        progress("rerank_pool_index_session", { datasetId: dataset.id, completed: index + 1, total: sessions.length });
      }
      const indexMs = performance.now() - started;
      const passages = database.prepare(`SELECT f.id AS fragmentId, f.body AS text, f.chunk_index AS chunkIndex,
        f.content_tokens AS contentTokenCount, f.location, f.end_location AS endLocation,
        s.external_source_id AS sessionId, s.source_path AS sourcePath
        FROM fragments f JOIN sources s ON s.id=f.source_id
        WHERE s.disposition='selected' AND s.processing_state='indexed'`).all() as Array<{
          fragmentId: string; text: string; chunkIndex: number | null; contentTokenCount: number | null;
          location: string; endLocation: string | null; sessionId: string; sourcePath: string;
        }>;
      const allPassages: PoolResult[] = passages.map((passage) => ({
        ...passage, chunkIndex: passage.chunkIndex ?? undefined, contentTokenCount: passage.contentTokenCount ?? undefined,
        endLocation: passage.endLocation ?? passage.location, modes: ["hybrid"],
        passageId: passageIdFor(dataset.id, passage.sessionId, passage.location, passage.endLocation ?? passage.location, passage.text),
      }));
      const byFragment = new Map(allPassages.map((passage) => [passage.fragmentId, passage]));
      for (const candidate of datasetQueries) {
        const input = { agent: dataset.agent, limit: 20, mode: "hybrid" as const, query: candidate.query, sourceType: "session" as const };
        for (let run = 0; run < config.benchmark.queryWarmupRuns; run += 1) await service.searchCandidates(input, depth);
        let retrieved: Awaited<ReturnType<typeof service.searchCandidates>> = [];
        const latencyMs: number[] = [];
        for (let run = 0; run < config.benchmark.queryRuns; run += 1) {
          started = performance.now();
          retrieved = await service.searchCandidates(input, depth);
          latencyMs.push(performance.now() - started);
        }
        const pooled = new Map<string, PoolResult>();
        const ranked = retrieved.map(({ row, score, reason }) => {
          const passage = byFragment.get(row.fragment_id);
          if (!passage || passage.text !== row.body) throw new Error("Retrieved candidate differs from indexed passage.");
          pooled.set(passage.passageId!, { ...passage });
          return resultSchema.parse({ ...mapFragmentSearchResult(row, reason, "", score), excerpt: "", passageId: passage.passageId });
        });
        for (let run = 0; run < config.benchmark.queryWarmupRuns; run += 1) await service.searchFragments(input);
        let currentResults: z.infer<typeof resultSchema>[] = [];
        const currentLatencyMs: number[] = [];
        for (let run = 0; run < config.benchmark.queryRuns; run += 1) {
          started = performance.now();
          const response = await service.searchFragments(input);
          currentLatencyMs.push(performance.now() - started);
          currentResults = response.results.map((result) => {
            const passage = byFragment.get(result.fragmentId);
            if (!passage) throw new Error("Current hybrid result has no indexed passage.");
            pooled.set(passage.passageId!, { ...passage });
            return resultSchema.parse({ ...result, excerpt: "", passageId: passage.passageId });
          });
        }
        for (const span of candidate.goldSpans) {
          const matching = allPassages.filter((passage) => passage.sessionId === span.sessionId
            && line(passage.location) <= span.endLine && line(passage.endLocation ?? passage.location) >= span.startLine
            && (span.chunkIndex === undefined || span.chunkIndex === passage.chunkIndex));
          if (!matching.length) throw new Error(`Seed span has no indexed passage: ${candidate.candidateId}`);
          for (const passage of matching) {
            const prior = pooled.get(passage.passageId!);
            pooled.set(passage.passageId!, { ...passage, modes: prior ? ["hybrid", "seed"] : ["seed"] });
          }
        }
        queries.push({ candidateId: candidate.candidateId, datasetId: dataset.id, query: candidate.query, results: [...pooled.values()] });
        retrievalQueries.push({ candidateId: candidate.candidateId, datasetId: dataset.id, query: candidate.query,
          latencyMs, candidates: ranked, currentLatencyMs, currentResults });
        progress("rerank_pool_query", { candidateId: candidate.candidateId, candidates: ranked.length });
      }
      database.pragma("wal_checkpoint(TRUNCATE)");
      datasets.push({ datasetId: dataset.id, summary: {
        databaseBytes: (await fs.stat(path.join(dataDirectory, "agent-memory.sqlite"))).size,
        databaseScanMs, fragments: passages.length, indexMs, sessions: sessions.length,
      } });
    } finally {
      database.close();
    }
  }
  const pool = candidatePoolSchema.parse({ schemaVersion: 1, generatedAt: new Date().toISOString(), depth, modes: ["hybrid"], queries });
  const outputFile = path.join(directory, "candidate-pool.json");
  const retrievalFile = path.join(directory, "retrieval.json");
  await writeJsonFile(outputFile, pool);
  await writeJsonFile(retrievalFile, retrievalSchema.parse({
    schemaVersion: 1, manifestSha256: evaluationHash(manifest), queriesSha256: querySetHash(selected), poolSha256: evaluationHash(pool),
    keywordQueryRuleVersion: KEYWORD_QUERY_RULE_VERSION,
    candidateCounts: settings.candidateCounts, queryRuns: config.benchmark.queryRuns,
    queryWarmupRuns: config.benchmark.queryWarmupRuns, datasets, queries: retrievalQueries,
  }));
  return { outputFile, retrievalFile, queries: selected.length };
}

function metrics(runs: StandardRun[], candidates: readonly QueryCandidate[], queryRuns: number): BenchmarkSearchMetrics {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const quality = (cutoff: number) => runs.map((run) => calculateQuality(run.results, byId.get(run.candidateId)!, cutoff));
  const latencies = runs.flatMap((run) => run.latencyMs ?? []);
  return {
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
    recallAt5: average(quality(5).map((value) => value.recall)), recallAt10: average(quality(10).map((value) => value.recall)),
    recallAt20: average(quality(20).map((value) => value.recall)), mrrAt10: average(quality(10).map((value) => value.mrr)),
    ndcgAt10: average(quality(10).map((value) => value.ndcg)), ndcgGain: "linear_graded_0_3_trec_eval", queries: runs.length, runsPerQuery: queryRuns,
  };
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function runRerankBenchmark(
  config: RerankConfig, manifest: EvaluationManifest, poolFile: string, qrelsFile: string, retrievalFile: string,
  dependencies: { provider?: Scorer } = {},
) {
  await validateEvaluationManifest(config, manifest);
  const settings = options(config);
  const [pool, allCandidates, retrieval] = await Promise.all([
    readCandidatePool(poolFile), readQueryCandidates(qrelsFile),
    fs.readFile(retrievalFile, "utf8").then((raw) => retrievalSchema.parse(JSON.parse(raw))),
  ]);
  const candidatesById = new Map(allCandidates.map((candidate) => [candidate.candidateId, candidate]));
  if (candidatesById.size !== allCandidates.length) throw new Error("Duplicate reranker qrels IDs.");
  const frozenIds = new Set(pool.queries.map((query) => query.candidateId));
  let selected = allCandidates.filter((candidate) => frozenIds.has(candidate.candidateId)).map((candidate) => {
    if (candidate.queryQuality?.status !== "accepted" || (candidate.split ?? "test") !== config.benchmark.querySplit) {
      throw new Error("Frozen pool query has no matching accepted-quality qrels.");
    }
    return candidate;
  });
  validateReviewedCandidates(selected);
  validateCandidatesAgainstManifest(selected, manifest);
  if (retrieval.manifestSha256 !== evaluationHash(manifest) || retrieval.poolSha256 !== evaluationHash(pool)
    || retrieval.queriesSha256 !== querySetHash(selected)
    || retrieval.keywordQueryRuleVersion !== KEYWORD_QUERY_RULE_VERSION
    || JSON.stringify(settings.candidateCounts) !== JSON.stringify(retrieval.candidateCounts)
    || retrieval.queryRuns !== config.benchmark.queryRuns || retrieval.queryWarmupRuns !== config.benchmark.queryWarmupRuns
    || pool.depth !== Math.max(...settings.candidateCounts) || pool.modes.join() !== "hybrid") {
    throw new Error("Frozen reranker retrieval does not match manifest, queries, pool or config.");
  }
  const poolById = new Map(pool.queries.map((query) => [query.candidateId, query]));
  const retrievalById = new Map(retrieval.queries.map((query) => [query.candidateId, query]));
  if (poolById.size !== selected.length || retrievalById.size !== selected.length
    || poolById.size !== pool.queries.length || retrievalById.size !== retrieval.queries.length) throw new Error("Frozen query sets differ or contain duplicates.");
  const sessions = new Map(manifest.datasets.flatMap((dataset) => dataset.sessions.map((session) => [`${dataset.id}\0${session.sourceId}`, session])));
  for (const candidate of selected) {
    const pooled = poolById.get(candidate.candidateId);
    const retrieved = retrievalById.get(candidate.candidateId);
    if (!pooled || !retrieved || pooled.query !== candidate.query || retrieved.query !== candidate.query
      || pooled.datasetId !== candidate.datasetId || retrieved.datasetId !== candidate.datasetId) throw new Error("Frozen query identity mismatch.");
    const scope = candidate.review.scope;
    if (!scope || scope.type !== "pooled" || scope.depth !== pool.depth || scope.poolGeneratedAt !== pool.generatedAt
      || scope.modes.join() !== pool.modes.join() || (scope.poolSha256 && scope.poolSha256 !== evaluationHash(pool))) {
      throw new Error(`Qrels scope does not match reranker pool: ${candidate.candidateId}`);
    }
    const passages = new Map(pooled.results.map((passage) => [passage.passageId, passage]));
    if (passages.size !== pooled.results.length) throw new Error("Duplicate pool passage IDs.");
    const judgments = candidate.review.judgments;
    if (!judgments || judgments.length !== passages.size || new Set(judgments.map((judgment) => judgment.passageId)).size !== passages.size) {
      throw new Error("Reranker requires complete judgments for every pooled passage.");
    }
    const hasRelevantPassage = judgments.some((judgment) => judgment.relevance >= relevanceThreshold(candidate));
    if ((candidate.review.status === "accepted") !== hasRelevantPassage) throw new Error("Qrels acceptance disagrees with passage judgments.");
    for (const passage of pooled.results) {
      const session = sessions.get(`${candidate.datasetId}\0${passage.sessionId}`);
      const judgment = judgments.find((value) => value.passageId === passage.passageId);
      if (!session || session.sourcePath !== passage.sourcePath || !passage.passageId
        || passage.passageId !== passageIdFor(candidate.datasetId, passage.sessionId, passage.location, passage.endLocation ?? passage.location, passage.text)
        || !judgment || judgment.sessionId !== passage.sessionId || judgment.startLine !== line(passage.location)
        || judgment.endLine !== line(passage.endLocation ?? passage.location) || judgment.chunkIndex !== passage.chunkIndex) {
        throw new Error("Reranker pool provenance or judgment mismatch.");
      }
    }
    if (retrieved.candidates.length > pool.depth || retrieved.currentResults.length > 20
      || retrieved.latencyMs.length !== config.benchmark.queryRuns || retrieved.currentLatencyMs.length !== config.benchmark.queryRuns) {
      throw new Error("Invalid frozen retrieval depth or timing samples.");
    }
    for (const ranking of [retrieved.candidates, retrieved.currentResults]) {
      const seen = new Set<string>();
      for (const result of ranking) {
        const passage = passages.get(result.passageId);
        if (!passage || seen.has(result.passageId) || passage.sessionId !== result.sessionId || passage.fragmentId !== result.fragmentId
          || passage.sourcePath !== result.sourcePath || passage.location !== result.location
          || (passage.endLocation ?? passage.location) !== (result.endLocation ?? result.location)
          || passage.chunkIndex !== result.chunkIndex || relevanceForResult(result, candidate) === null) {
          throw new Error("Frozen retrieval candidate does not match judged pool passage.");
        }
        seen.add(result.passageId);
      }
    }
  }
  const frozenQueriesSha256 = querySetHash(selected);
  const zeroRelevantQueriesExcluded = selected.filter((candidate) => candidate.review.status === "rejected").length;
  selected = selected.filter((candidate) => candidate.review.status === "accepted");
  if (!selected.length) throw new Error("Reranker pool has no accepted query with relevant judgments.");
  const provider = dependencies.provider ?? new LocalRerankerProvider(settings.cacheDirectory);
  const inputHashes = { manifestSha256: evaluationHash(manifest), poolSha256: evaluationHash(pool),
    qrelsSha256: evaluationHash(allCandidates), retrievalSha256: evaluationHash(retrieval), queriesSha256: frozenQueriesSha256 };
  const binding = evaluationHash({ inputHashes, modelId: provider.modelId, runs: config.benchmark.queryRuns });
  const directory = path.join(path.dirname(retrievalFile), `benchmark-${binding.slice(0, 16)}`);
  await fs.mkdir(directory, { recursive: true });
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 25);
  const standardRuns: StandardRun[] = [];
  let coldLoadMs = 0;
  try {
    const started = performance.now();
    await provider.score("Reranker startup warmup", ["Synthetic startup document."]);
    coldLoadMs = performance.now() - started;
    for (const candidate of selected) {
      const retrieved = retrievalById.get(candidate.candidateId)!;
      const byId = new Map(poolById.get(candidate.candidateId)!.results.map((passage) => [passage.passageId, passage]));
      const checkpoint = await scoreRerankCheckpoint(path.join(directory, "checkpoints", `${evaluationHash(candidate.candidateId)}.json`), provider, {
        binding: evaluationHash({ binding, candidateId: candidate.candidateId }), query: candidate.query,
        passages: retrieved.candidates.map((result) => byId.get(result.passageId)!.text), runs: config.benchmark.queryRuns,
      });
      peakRssBytes = Math.max(peakRssBytes, checkpoint.peakRssBytes);
      standardRuns.push({ candidateId: candidate.candidateId, datasetId: candidate.datasetId, mode: "hybrid-current",
        latencyMs: retrieved.currentLatencyMs, results: retrieved.currentResults });
      for (const depth of settings.candidateCounts) {
        standardRuns.push({ candidateId: candidate.candidateId, datasetId: candidate.datasetId, mode: `baseline-${depth}`,
          latencyMs: retrieved.latencyMs, results: rankRerankCandidates(retrieved.candidates, depth) });
        standardRuns.push({ candidateId: candidate.candidateId, datasetId: candidate.datasetId, mode: `rerank-${depth}`,
          latencyMs: checkpoint.latencyMs.map((latency, index) => latency + retrieved.latencyMs[index]!),
          results: rankRerankCandidates(retrieved.candidates, depth, checkpoint.scores) });
      }
      progress("rerank_query_complete", { candidateId: candidate.candidateId, candidates: retrieved.candidates.length, p95Ms: percentile(checkpoint.latencyMs, 0.95) });
    }
  } finally {
    clearInterval(sampler);
    await provider.dispose?.();
  }
  const modes = ["hybrid-current", ...settings.candidateCounts.flatMap((depth) => [`baseline-${depth}`, `rerank-${depth}`])];
  const datasets = retrieval.datasets.map((dataset) => ({
    ...dataset.summary, datasetId: dataset.datasetId, agent: manifest.datasets.find((value) => value.id === dataset.datasetId)!.agent,
    peakRssBytes, searches: Object.fromEntries(modes.map((mode) => [mode, metrics(standardRuns.filter((run) => run.datasetId === dataset.datasetId && run.mode === mode), selected, config.benchmark.queryRuns)])),
  }));
  const nativeMetrics = new Map<string, NativeMetrics>(datasets.flatMap((dataset) => Object.entries(dataset.searches).map(([mode, values]) => [`${dataset.datasetId}\0${mode}`, values] as const)));
  const standardEvaluation = await runStandardEvaluation({ candidates: selected, nativeMetrics, outputDirectory: directory, runs: standardRuns, tools: config.benchmark.standardTools });
  const paired = settings.candidateCounts.map((depth) => {
    let improved = 0; let tied = 0; let worse = 0;
    const differences = selected.map((candidate) => {
      const before = standardRuns.find((run) => run.candidateId === candidate.candidateId && run.mode === `baseline-${depth}`)!;
      const after = standardRuns.find((run) => run.candidateId === candidate.candidateId && run.mode === `rerank-${depth}`)!;
      const current = standardRuns.find((run) => run.candidateId === candidate.candidateId && run.mode === "hybrid-current")!;
      const difference = calculateQuality(after.results, candidate, 10).ndcg - calculateQuality(before.results, candidate, 10).ndcg;
      if (difference > 1e-12) improved += 1; else if (difference < -1e-12) worse += 1; else tied += 1;
      return { candidateId: candidate.candidateId, ndcgAt10Delta: difference,
        ndcgAt10DeltaFromCurrent: calculateQuality(after.results, candidate, 10).ndcg - calculateQuality(current.results, candidate, 10).ndcg,
        pooledCandidateRecall: calculateQuality(retrievalById.get(candidate.candidateId)!.candidates, candidate, depth).recall };
    });
    return { depth, improved, tied, worse, meanNdcgAt10Delta: average(differences.map((value) => value.ndcgAt10Delta)),
      meanNdcgAt10DeltaFromCurrent: average(differences.map((value) => value.ndcgAt10DeltaFromCurrent)),
      meanPooledCandidateRecall: average(differences.map((value) => value.pooledCandidateRecall)), differences };
  });
  const finishedAt = new Date().toISOString();
  const benchmark = { embeddingModel: DEFAULT_EMBEDDING_MODEL, keywordQueryRuleVersion: KEYWORD_QUERY_RULE_VERSION,
    modes, queryRuns: config.benchmark.queryRuns, querySplit: config.benchmark.querySplit };
  const evaluatedById = new Map(selected.map((candidate) => [candidate.candidateId, candidate]));
  const queryMetrics = standardRuns.map((run) => ({
    candidateId: run.candidateId, datasetId: run.datasetId, mode: run.mode,
    at5: calculateQuality(run.results, evaluatedById.get(run.candidateId)!, 5),
    at10: calculateQuality(run.results, evaluatedById.get(run.candidateId)!, 10),
    at20: calculateQuality(run.results, evaluatedById.get(run.candidateId)!, 20),
  }));
  const report = { schemaVersion: 1, evidence: "LLM silver qrels on frozen split; diagnostic comparison, not production quality evidence", modelId: provider.modelId,
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.availableParallelism(), totalMemoryBytes: os.totalmem() },
    inputHashes, coldLoadMs, peakRssBytes, zeroRelevantQueriesExcluded,
    latencyScope: `Real inference at maximum depth ${Math.max(...settings.candidateCounts)}; pointwise scores shared by depth prefixes; total latency is retrieval plus scoring`,
    candidateRecallScope: "Candidate Recall@N uses pooled relevant passages; it is not exhaustive corpus recall.",
    comparisonScope: "baseline-N and rerank-N use the same frozen candidate prefix; hybrid-current is the separately measured production hybrid reference without that prefix cap.",
    benchmark, datasets, paired, queryMetrics, runs: standardRuns, standardEvaluation, finishedAt };
  const outputFile = path.join(directory, "report.json");
  const htmlReportFile = path.join(directory, "report.html");
  await writeJsonFile(outputFile, report);
  await writeEvaluationHtmlReport(htmlReportFile, { benchmark, candidates: selected, datasets, finishedAt, inputHashes,
    manifest, qrels: qrelsSummary(selected), rules: manifest.rules, runs: standardRuns, standardEvaluation });
  const html = await fs.readFile(htmlReportFile, "utf8");
  await fs.writeFile(htmlReportFile, html.replace('<section class="run-facts">', `<p><strong>${escapeHtml(report.evidence)}</strong></p><p>Model: ${escapeHtml(provider.modelId)}. Cold load and warmup: ${coldLoadMs.toFixed(1)} ms; peak RSS: ${peakRssBytes} bytes.</p><p>${escapeHtml(report.latencyScope)}</p><p>${escapeHtml(report.comparisonScope)}</p><p>${escapeHtml(report.candidateRecallScope)}</p><details><summary>Input hashes and paired query differences</summary><pre>${escapeHtml(JSON.stringify({ inputHashes, paired }, null, 2))}</pre></details><section class="run-facts">`), { mode: 0o600 });
  await fs.mkdir(path.join(directory, "sessions"), { recursive: true });
  for (const dataset of manifest.datasets) for (const session of dataset.sessions) {
    const locations = [...new Set(standardRuns.filter((run) => run.datasetId === dataset.id).flatMap((run) => run.results.filter((result) => result.sessionId === session.sourceId).map((result) => result.location)))];
    await fs.writeFile(path.join(directory, sessionReportHref(dataset.id, session.sourceId)), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Session provenance</title><a href="../report.html">Benchmark queries, metrics and rankings</a><h1>Session provenance</h1><p>${escapeHtml(dataset.id)} / ${escapeHtml(session.sourceId)}</p><p>Source: ${escapeHtml(session.sourcePath)}</p><p>SHA-256: ${escapeHtml(session.contentFingerprint)}</p>${locations.map((location) => `<p id="${escapeHtml(location.replace(":", "-"))}">${escapeHtml(location)}</p>`).join("")}</html>`, { mode: 0o600 });
  }
  return { htmlReportFile, outputFile, report };
}
