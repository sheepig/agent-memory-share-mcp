import fs from "node:fs/promises";
import path from "node:path";

import { validateCandidatesAgainstManifest } from "./benchmark.js";
import { openChunkVariantIndex, type IndexedPassage } from "./chunk-ablation-index.js";
import { readQueryCandidates, writeJsonFile } from "./files.js";
import { evaluationHash, querySetHash } from "./identity.js";
import { validateEvaluationManifest } from "./manifest-validation.js";
import { candidatePoolSchema, type CandidatePool, type EvaluationConfig, type EvaluationManifest } from "./types.js";

const POOL_DEPTH = 20;
type PoolResult = CandidatePool["queries"][number]["results"][number];

function lineNumber(location: string): number {
  const match = /^line:(\d+)$/u.exec(location);
  if (!match) throw new Error(`Chunk ablation requires JSONL line provenance: ${location}`);
  return Number(match[1]);
}

function pooledResult(passage: IndexedPassage, mode: PoolResult["modes"][number], variantId: string): PoolResult {
  return {
    ...(passage.chunkIndex !== undefined ? { chunkIndex: passage.chunkIndex } : {}),
    ...(passage.contentTokenCount !== undefined ? { contentTokenCount: passage.contentTokenCount } : {}),
    endLocation: passage.endLocation,
    location: passage.location,
    modes: [mode],
    passageId: passage.passageId,
    sessionId: passage.sessionId,
    sourcePath: passage.sourcePath,
    text: passage.body,
    variantIds: [variantId],
  };
}

function addPooledResult(results: Map<string, PoolResult>, passage: IndexedPassage, mode: PoolResult["modes"][number], variantId: string): void {
  const existing = results.get(passage.passageId);
  if (!existing) {
    results.set(passage.passageId, pooledResult(passage, mode, variantId));
    return;
  }
  if (!existing.modes.includes(mode)) existing.modes.push(mode);
  if (!existing.variantIds?.includes(variantId)) existing.variantIds?.push(variantId);
}

export async function buildChunkAblationPool(
  config: EvaluationConfig,
  manifest: EvaluationManifest,
  candidatesFile: string,
): Promise<{ outputFile: string; queries: number }> {
  const variants = config.chunkAblation?.variants;
  if (!variants) throw new Error("chunkAblation.variants is missing from the evaluation config.");
  await validateEvaluationManifest(config, manifest);
  const candidates = await readQueryCandidates(candidatesFile);
  validateCandidatesAgainstManifest(candidates, manifest);
  const activeCandidates = candidates.filter((candidate) => candidate.queryQuality?.status !== "rejected" && candidate.review.status !== "rejected");
  if (activeCandidates.length === 0) throw new Error("Chunk ablation has no active query candidates.");
  const pooled = new Map(activeCandidates.map((candidate) => [candidate.candidateId, new Map<string, PoolResult>()]));
  if (pooled.size !== activeCandidates.length) throw new Error("Chunk ablation query candidates contain duplicate IDs.");
  const memberships = new Map<string, Set<string>>();
  await fs.mkdir(config.outputDirectory, { recursive: true });
  const runDirectory = await fs.mkdtemp(path.join(config.outputDirectory, "ablation-pool-"));

  for (const variant of variants) {
    for (const dataset of manifest.datasets) {
      const index = await openChunkVariantIndex(config, dataset, variant, path.join(runDirectory, variant.id, dataset.id));
      try {
        const byFragmentId = new Map(index.passages.map((passage) => [passage.fragmentId, passage]));
        for (const passage of index.passages) {
          const key = `${dataset.id}\0${passage.passageId}`;
          const known = memberships.get(key) ?? new Set<string>();
          known.add(variant.id);
          memberships.set(key, known);
        }
        for (const candidate of activeCandidates.filter((value) => value.datasetId === dataset.id)) {
          const results = pooled.get(candidate.candidateId)!;
          for (const span of candidate.goldSpans) {
            const seeds = index.passages.filter((passage) => passage.sessionId === span.sessionId
              && lineNumber(passage.location) === span.startLine
              && lineNumber(passage.endLocation) === span.endLine);
            if (seeds.length === 0) throw new Error(`Chunk ablation seed turn is missing: ${candidate.candidateId}/${span.sessionId}:${span.startLine}-${span.endLine}`);
            seeds.forEach((passage) => addPooledResult(results, passage, "seed", variant.id));
          }
          for (const mode of config.benchmark.modes) {
            const response = await index.search(candidate.query, mode);
            for (const result of response.results.slice(0, POOL_DEPTH)) {
              const passage = byFragmentId.get(result.fragmentId);
              if (!passage) throw new Error(`Chunk ablation search returned unknown fragment: ${result.fragmentId}`);
              addPooledResult(results, passage, mode, variant.id);
            }
          }
        }
      } finally {
        index.close();
      }
    }
  }

  const pool = candidatePoolSchema.parse({
    chunkAblation: {
      manifestSha256: evaluationHash(manifest),
      queriesSha256: querySetHash(candidates),
      variants,
    },
    depth: POOL_DEPTH,
    generatedAt: new Date().toISOString(),
    modes: config.benchmark.modes,
    queries: activeCandidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      datasetId: candidate.datasetId,
      query: candidate.query,
      results: [...pooled.get(candidate.candidateId)!.values()].map((result) => ({
        ...result,
        variantIds: [...(memberships.get(`${candidate.datasetId}\0${result.passageId}`) ?? [])].sort(),
      })),
    })),
    schemaVersion: 1,
  } satisfies CandidatePool);
  const outputFile = path.join(runDirectory, "candidate-pool.json");
  await writeJsonFile(outputFile, pool);
  return { outputFile, queries: pool.queries.length };
}

export { runChunkAblation } from "./chunk-ablation-benchmark.js";
