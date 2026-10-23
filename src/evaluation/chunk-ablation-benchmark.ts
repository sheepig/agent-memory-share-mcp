import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_EMBEDDING_MODEL, LocalContentTokenizer } from "../search/embedding.js";
import { qrelsSummary, validateReviewedCandidates } from "./benchmark.js";
import { openChunkVariantIndex, type IndexedPassage } from "./chunk-ablation-index.js";
import {
  buildPooledTurnReference,
  calculatePooledTurnMetrics,
  type PooledTurnMetricsAtCutoffs,
  type PooledTurnReference,
} from "./chunk-ablation-metrics.js";
import {
  writeChunkAblationHtmlReport,
  type ChunkAblationDatasetReport,
  type ChunkAblationReport,
  type ChunkAblationQueryReport,
  type ChunkAblationSearchMetrics,
  type ChunkAblationVariantReport,
} from "./chunk-ablation-report.js";
import { readCandidatePool, readQueryCandidates, writeJsonFile } from "./files.js";
import { writeEvaluationHtmlReport } from "./html-report.js";
import { evaluationHash, passageIdFor, querySetHash } from "./identity.js";
import { KEYWORD_QUERY_RULE_VERSION } from "../search/tokens.js";
import { writeSessionReportPages } from "./session-report.js";
import { validateEvaluationManifest } from "./manifest-validation.js";
import { calculateQuality, relevanceForResult, relevanceThreshold, type EvaluationSearchResult } from "./metrics.js";
import { runStandardEvaluation, type NativeMetrics, type StandardRun } from "./standard-evaluation.js";
import type { CandidatePool, ChunkVariant, EvaluationConfig, EvaluationManifest, EvaluationManifestDataset, QueryCandidate } from "./types.js";

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)]!;
}

function lineNumber(location: string): number {
  const match = /^line:(\d+)$/u.exec(location);
  if (!match) throw new Error(`Chunk ablation requires JSONL line provenance: ${location}`);
  return Number(match[1]);
}

function activeCandidate(candidate: QueryCandidate): boolean {
  return candidate.queryQuality?.status !== "rejected" && candidate.review.status !== "pending";
}

function validateAblationReview(
  config: EvaluationConfig,
  manifest: EvaluationManifest,
  pool: CandidatePool,
  candidates: readonly QueryCandidate[],
): void {
  if (!config.chunkAblation || !pool.chunkAblation) throw new Error("Chunk ablation config and pool metadata are required.");
  if (pool.chunkAblation.manifestSha256 !== evaluationHash(manifest)) throw new Error("Chunk ablation pool does not match the manifest. Rebuild the pool.");
  if (pool.chunkAblation.queriesSha256 !== querySetHash(candidates)) throw new Error("Chunk ablation qrels query set does not match the pool.");
  if (JSON.stringify(pool.chunkAblation.variants) !== JSON.stringify(config.chunkAblation.variants)
    || JSON.stringify(pool.modes) !== JSON.stringify(config.benchmark.modes)) {
    throw new Error("Chunk ablation pool variants or search modes do not match the config. Rebuild the pool.");
  }
  validateReviewedCandidates(candidates);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (candidatesById.size !== candidates.length) throw new Error("Chunk ablation qrels contain duplicate candidate IDs.");
  const sessions = new Map(manifest.datasets.flatMap((dataset) => dataset.sessions.map((session) => [
    `${dataset.id}\0${session.sourceId}`,
    session.sourcePath,
  ] as const)));
  const poolHash = evaluationHash(pool);
  for (const query of pool.queries) {
    const candidate = candidatesById.get(query.candidateId);
    if (!candidate || candidate.datasetId !== query.datasetId || candidate.query !== query.query || !activeCandidate(candidate)) {
      throw new Error(`Chunk ablation pool has no matching reviewed query: ${query.candidateId}`);
    }
    const judgments = candidate.review.judgments;
    if (!judgments || judgments.length !== query.results.length) {
      throw new Error(`Chunk ablation qrels do not cover every pooled passage: ${query.candidateId}`);
    }
    if (typeof candidate.review.reviewer === "object" && candidate.review.reviewer.type === "llm"
      && candidate.review.scope?.poolSha256 !== poolHash) {
      throw new Error(`Chunk ablation LLM qrels do not match the reviewed pool: ${query.candidateId}`);
    }
    const resultsById = new Map(query.results.map((result) => [result.passageId, result]));
    for (const result of query.results) {
      const expectedPath = sessions.get(`${query.datasetId}\0${result.sessionId}`);
      if (!result.passageId || !expectedPath || expectedPath !== result.sourcePath
        || result.passageId !== passageIdFor(query.datasetId, result.sessionId, result.location, result.endLocation ?? result.location, result.text)) {
        throw new Error(`Chunk ablation pool has invalid passage provenance: ${query.candidateId}`);
      }
    }
    const seen = new Set<string>();
    for (const judgment of judgments) {
      const result = resultsById.get(judgment.passageId);
      if (!judgment.passageId || !result || seen.has(judgment.passageId)
        || judgment.sessionId !== result.sessionId
        || judgment.startLine !== lineNumber(result.location)
        || judgment.endLine !== lineNumber(result.endLocation ?? result.location)) {
        throw new Error(`Chunk ablation qrels contain an unknown or duplicate passage: ${query.candidateId}`);
      }
      seen.add(judgment.passageId);
    }
    const positive = judgments.some((judgment) => judgment.relevance >= relevanceThreshold(candidate));
    if ((candidate.review.status === "accepted") !== positive) {
      throw new Error(`Chunk ablation qrels acceptance disagrees with passage judgments: ${query.candidateId}`);
    }
  }
  const pooledIds = new Set(pool.queries.map((query) => query.candidateId));
  if (candidates.some((candidate) => activeCandidate(candidate) && !pooledIds.has(candidate.candidateId))) {
    throw new Error("Chunk ablation pool is missing a reviewed query.");
  }
}

function projectCandidates(
  candidates: readonly QueryCandidate[],
  pool: CandidatePool,
  datasetId: string,
  variantId: string,
  split: EvaluationConfig["benchmark"]["querySplit"],
): QueryCandidate[] {
  const poolById = new Map(pool.queries.map((query) => [query.candidateId, query]));
  return candidates.filter((candidate) => candidate.datasetId === datasetId
    && (candidate.split ?? "test") === split
    && candidate.queryQuality?.status !== "rejected"
    && candidate.review.status === "accepted").map((candidate) => {
    const query = poolById.get(candidate.candidateId);
    if (!query) throw new Error(`Chunk ablation pool is missing query: ${candidate.candidateId}`);
    const ids = new Set(query.results.filter((result) => result.variantIds?.includes(variantId)).map((result) => result.passageId));
    const judgments = candidate.review.judgments!.filter((judgment) => ids.has(judgment.passageId));
    if (judgments.length !== ids.size) throw new Error(`Chunk ablation qrels are incomplete for ${variantId}/${candidate.candidateId}.`);
    return { ...candidate, review: { ...candidate.review, judgments } };
  });
}

function variantManifestDataset(dataset: EvaluationManifestDataset, passages: readonly IndexedPassage[]): EvaluationManifestDataset {
  const bySession = new Map<string, IndexedPassage[]>();
  for (const passage of passages) {
    const known = bySession.get(passage.sessionId) ?? [];
    known.push(passage);
    bySession.set(passage.sessionId, known);
  }
  return {
    ...dataset,
    sessions: dataset.sessions.map((session) => ({
      ...session,
      chunks: (bySession.get(session.sourceId) ?? []).map((passage, ordinal) => {
        const origin = session.chunks.find((chunk) => chunk.location === passage.location
          && (chunk.endLocation ?? chunk.location) === passage.endLocation);
        return {
          characters: [...passage.body].length,
          ...(passage.chunkIndex !== undefined ? { chunkIndex: passage.chunkIndex } : {}),
          ...(passage.contentTokenCount !== undefined ? { contentTokenCount: passage.contentTokenCount } : {}),
          endLocation: passage.endLocation,
          ...(origin?.endNativeEventId ? { endNativeEventId: origin.endNativeEventId } : {}),
          ...(origin?.endedAt ? { endedAt: origin.endedAt } : {}),
          location: passage.location,
          ...(origin?.nativeEventId ? { nativeEventId: origin.nativeEventId } : {}),
          ordinal,
          ...(origin?.startedAt ? { startedAt: origin.startedAt } : {}),
          turnCount: 1,
        };
      }),
    })),
  };
}

async function benchmarkVariantDataset(
  config: EvaluationConfig,
  dataset: EvaluationManifestDataset,
  variant: ChunkVariant,
  directory: string,
  candidates: readonly QueryCandidate[],
  pool: CandidatePool,
  turnReferences: ReadonlyMap<string, PooledTurnReference>,
): Promise<{ dataset: ChunkAblationDatasetReport; manifestDataset: EvaluationManifestDataset; runs: StandardRun[] }> {
  const dataDirectory = path.join(directory, dataset.id);
  const index = await openChunkVariantIndex(config, dataset, variant, dataDirectory);
  try {
    const byFragmentId = new Map(index.passages.map((passage) => [passage.fragmentId, passage]));
    const passageIds = new Set(index.passages.map((passage) => passage.passageId));
    const poolQueries = pool.queries.filter((query) => query.datasetId === dataset.id);
    for (const query of poolQueries) {
      for (const result of query.results.filter((result) => result.variantIds?.includes(variant.id))) {
        if (!passageIds.has(result.passageId!)) throw new Error(`Chunk ablation index differs from pooled variant ${variant.id}: ${result.passageId}`);
      }
    }
    const projected = projectCandidates(candidates, pool, dataset.id, variant.id, config.benchmark.querySplit);
    const pooledByCandidate = new Map(poolQueries.map((query) => [query.candidateId, query]));
    const searches: Record<string, ChunkAblationSearchMetrics> = {};
    const queries: ChunkAblationQueryReport[] = [];
    const runs: StandardRun[] = [];
    for (const mode of config.benchmark.modes) {
      const latencies: number[] = [];
      const recall5: number[] = [];
      const recall10: number[] = [];
      const recall20: number[] = [];
      const mrr10: number[] = [];
      const ndcg10: number[] = [];
      for (const candidate of projected) {
        for (let count = 0; count < config.benchmark.queryWarmupRuns; count += 1) await index.search(candidate.query, mode);
        let results: EvaluationSearchResult[] = [];
        const queryLatencies: number[] = [];
        for (let count = 0; count < config.benchmark.queryRuns; count += 1) {
          const started = performance.now();
          const response = await index.search(candidate.query, mode);
          const latency = performance.now() - started;
          latencies.push(latency);
          queryLatencies.push(latency);
          results = response.results.map((result) => {
            const passage = byFragmentId.get(result.fragmentId);
            if (!passage) throw new Error(`Chunk ablation search returned unknown fragment: ${result.fragmentId}`);
            return { ...result, passageId: passage.passageId };
          });
        }
        const pooledIds = new Set(pooledByCandidate.get(candidate.candidateId)?.results
          .filter((result) => result.variantIds?.includes(variant.id)).map((result) => result.passageId));
        if (!config.benchmark.allowUnjudgedResults && results.some((result) => !pooledIds.has(result.passageId))) {
          throw new Error(`Chunk ablation search returned an unjudged passage for ${variant.id}/${candidate.candidateId}. Rebuild the pool.`);
        }
        runs.push({ candidateId: candidate.candidateId, datasetId: dataset.id, latencyMs: queryLatencies, mode, results });
        recall5.push(calculateQuality(results, candidate, 5).recall);
        const at10 = calculateQuality(results, candidate, 10);
        recall10.push(at10.recall);
        mrr10.push(at10.mrr);
        ndcg10.push(at10.ndcg);
        recall20.push(calculateQuality(results, candidate, 20).recall);
        const reference = turnReferences.get(candidate.candidateId)!;
        queries.push({
          candidateId: candidate.candidateId,
          query: candidate.query,
          mode,
          chunkMetrics: {
            recallAt5: recall5.at(-1)!, recallAt10: at10.recall, recallAt20: recall20.at(-1)!,
            mrrAt10: at10.mrr, ndcgAt10: at10.ndcg,
          },
          latencyMs: { p50: percentile(queryLatencies, 0.5), p95: percentile(queryLatencies, 0.95), p99: percentile(queryLatencies, 0.99) },
          turnMetrics: {
            at5: calculatePooledTurnMetrics(results, candidate, reference, 5),
            at10: calculatePooledTurnMetrics(results, candidate, reference, 10),
            at20: calculatePooledTurnMetrics(results, candidate, reference, 20),
          },
          ranking: results.map((result, index) => ({
            rank: index + 1, sessionId: result.sessionId!, sourcePath: result.sourcePath,
            location: result.location, endLocation: result.endLocation ?? result.location,
            passageId: result.passageId!, relevance: relevanceForResult(result, candidate),
            ...(result.chunkIndex !== undefined ? { chunkIndex: result.chunkIndex } : {}),
          })),
        });
      }
      const modeQueries = queries.filter((query) => query.mode === mode);
      const summarize = (cutoff: keyof PooledTurnMetricsAtCutoffs) => ({
        hit: average(modeQueries.map((query) => query.turnMetrics[cutoff].hit)),
        pooledTurnRecall: average(modeQueries.map((query) => query.turnMetrics[cutoff].pooledTurnRecall)),
        sameTurnDuplicateRate: average(modeQueries.map((query) => query.turnMetrics[cutoff].sameTurnDuplicateRate)),
      });
      searches[mode] = {
        latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
        mrrAt10: average(mrr10),
        ndcgGain: "linear_graded_0_3_trec_eval",
        ndcgAt10: average(ndcg10),
        queries: projected.length,
        recallAt5: average(recall5),
        recallAt10: average(recall10),
        recallAt20: average(recall20),
        runsPerQuery: config.benchmark.queryRuns,
        turnMetrics: { at5: summarize("at5"), at10: summarize("at10"), at20: summarize("at20") },
      };
    }
    index.database.pragma("wal_checkpoint(TRUNCATE)");
    const databaseBytes = (await fs.stat(path.join(dataDirectory, "agent-memory.sqlite"))).size;
    const tokenCounts = index.passages.map((passage) => passage.contentTokenCount ?? 0);
    const turnCounts = new Map<string, number>();
    for (const passage of index.passages) {
      const key = `${passage.sessionId}\0${passage.location}\0${passage.endLocation}`;
      turnCounts.set(key, (turnCounts.get(key) ?? 0) + 1);
    }
    return {
      dataset: {
        agent: dataset.agent,
        avgContentTokens: average(tokenCounts),
        databaseBytes,
        databaseScanMs: index.summary.databaseScanMs,
        datasetId: dataset.id,
        fragments: index.summary.fragments,
        indexMs: index.summary.indexMs,
        peakRssBytes: index.peakRssBytes(),
        p95ContentTokens: percentile(tokenCounts, 0.95),
        relevantJudgedPassages: projected.reduce((sum, candidate) => sum + candidate.review.judgments!.filter((judgment) => judgment.relevance >= relevanceThreshold(candidate)).length, 0),
        queries,
        scan: index.scan,
        searches,
        sessions: index.summary.sessions,
        splitTurns: [...turnCounts.values()].filter((count) => count > 1).length,
      },
      manifestDataset: variantManifestDataset(dataset, index.passages),
      runs,
    };
  } finally {
    index.close();
  }
}

export async function runChunkAblation(
  config: EvaluationConfig,
  manifest: EvaluationManifest,
  poolFile: string,
  qrelsFile: string,
): Promise<{ htmlReportFile: string; outputFile: string; report: ChunkAblationReport }> {
  await validateEvaluationManifest(config, manifest);
  const [pool, candidates] = await Promise.all([readCandidatePool(poolFile), readQueryCandidates(qrelsFile)]);
  validateAblationReview(config, manifest, pool, candidates);
  const selected = candidates.filter((candidate) => (candidate.split ?? "test") === config.benchmark.querySplit);
  if (!selected.some((candidate) => candidate.review.status === "accepted" && candidate.queryQuality?.status !== "rejected")) {
    throw new Error(`Chunk ablation qrels contain no accepted ${config.benchmark.querySplit} queries.`);
  }
  const hashes = {
    manifestSha256: evaluationHash(manifest),
    poolSha256: evaluationHash(pool),
    qrelsSha256: evaluationHash(selected),
  };
  const pooledTurnReferences = selected
    .filter((candidate) => candidate.review.status === "accepted" && candidate.queryQuality?.status !== "rejected")
    .map(buildPooledTurnReference);
  const turnReferences = new Map(pooledTurnReferences.map((reference) => [reference.candidateId, reference]));
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const runDirectory = await fs.mkdtemp(path.join(config.outputDirectory, "ablation-benchmark-"));
  await writeSessionReportPages(runDirectory, manifest, new LocalContentTokenizer(config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache")));
  const variants: ChunkAblationVariantReport[] = [];
  for (const variant of config.chunkAblation!.variants) {
    const variantDirectory = path.join(runDirectory, variant.id);
    const benchmarked = [];
    for (const dataset of manifest.datasets) {
      benchmarked.push(await benchmarkVariantDataset(config, dataset, variant, variantDirectory, selected, pool, turnReferences));
    }
    const datasets = benchmarked.map((value) => value.dataset);
    const runs = benchmarked.flatMap((value) => value.runs);
    const nativeMetrics = new Map<string, NativeMetrics>();
    for (const dataset of datasets) {
      for (const [mode, metrics] of Object.entries(dataset.searches)) {
        const { mrrAt10, ndcgAt10, recallAt5, recallAt10, recallAt20 } = metrics;
        nativeMetrics.set(`${dataset.datasetId}\0${mode}`, { mrrAt10, ndcgAt10, recallAt5, recallAt10, recallAt20 });
      }
    }
    const projected = manifest.datasets.flatMap((dataset) => projectCandidates(selected, pool, dataset.id, variant.id, config.benchmark.querySplit));
    const standardEvaluation = await runStandardEvaluation({
      candidates: projected,
      nativeMetrics,
      outputDirectory: variantDirectory,
      runs,
      tools: config.benchmark.standardTools,
    });
    const reportFile = path.join(variantDirectory, "report.json");
    const htmlReportFile = path.join(variantDirectory, "report.html");
    const benchmark = {
      allowUnjudgedResults: config.benchmark.allowUnjudgedResults ?? false,
      keywordQueryRuleVersion: KEYWORD_QUERY_RULE_VERSION,
      embeddingModel: config.benchmark.modes.some((mode) => mode !== "keyword") ? DEFAULT_EMBEDDING_MODEL : null,
      modes: config.benchmark.modes,
      queryRuns: config.benchmark.queryRuns,
      querySplit: config.benchmark.querySplit,
    };
    await writeJsonFile(reportFile, {
      benchmark: { ...benchmark, chunkOptions: { maxContentTokens: variant.maxContentTokens, overlapContentTokens: variant.overlapContentTokens } },
      datasets,
      inputHashes: hashes,
      pooledTurnReferences,
      qrels: qrelsSummary(selected),
      rules: manifest.rules,
      schemaVersion: 1,
      standardEvaluation,
      variantId: variant.id,
    });
    await writeEvaluationHtmlReport(htmlReportFile, {
      sessionReportPrefix: "../",
      benchmark,
      candidates: projected,
      datasets,
      finishedAt: new Date().toISOString(),
      inputHashes: { manifestSha256: hashes.manifestSha256, qrelsSha256: hashes.qrelsSha256 },
      manifest: { ...manifest, datasets: benchmarked.map((value) => value.manifestDataset) },
      qrels: {
        accepted: projected.length,
        rejected: selected.filter((candidate) => candidate.review.status === "rejected").length,
        total: selected.length,
      },
      rules: manifest.rules,
      runs,
      standardEvaluation,
    });
    variants.push({ ...variant, datasets, htmlReportFile, reportFile, standardEvaluation });
  }
  const report: ChunkAblationReport = {
    allowUnjudgedResults: config.benchmark.allowUnjudgedResults ?? false,
    baselineVariantId: variants[0]!.id,
    keywordQueryRuleVersion: KEYWORD_QUERY_RULE_VERSION,
    finishedAt: new Date().toISOString(),
    inputHashes: hashes,
    modes: config.benchmark.modes,
    pooledTurnReferences,
    qrels: qrelsSummary(selected),
    querySplit: config.benchmark.querySplit,
    schemaVersion: 1,
    variants,
  };
  const outputFile = path.join(runDirectory, "report.json");
  const htmlReportFile = path.join(runDirectory, "report.html");
  await writeJsonFile(outputFile, report);
  await writeChunkAblationHtmlReport(htmlReportFile, report);
  return { htmlReportFile, outputFile, report };
}
