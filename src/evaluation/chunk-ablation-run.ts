import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { INDEX_RULE_VERSION } from "../application/source-service.js";
import { DEFAULT_EMBEDDING_MODEL } from "../search/embedding.js";
import { SENSITIVE_CONTENT_RULE_VERSION } from "../security/sensitive-content.js";
import { APP_VERSION } from "../version.js";
import { buildChunkAblationPool, runChunkAblation } from "./chunk-ablation.js";
import { readCandidatePool, readEvaluationManifest, readQueryCandidates, writeJsonFile } from "./files.js";
import { materializeSweChat } from "./hugging-face.js";
import { evaluationHash } from "./identity.js";
import { reviewQrelsWithLlm, QREL_REVIEW_PROMPT_VERSION } from "./llm-review.js";
import { validateEvaluationManifest } from "./manifest-validation.js";
import { generateQueryCandidates, queryGenerationProtocolHash } from "./query-generation.js";
import { QREL_REVIEW_INSTRUCTIONS } from "./review-prompt.js";
import { scanEvaluation } from "./scanner.js";
import type { EvaluationConfig } from "./types.js";

const stateSchema = z.object({
  binding: z.string().length(64),
  fetched: z.boolean().optional(),
  manifestSha256: z.string().length(64).optional(),
  queriesSha256: z.string().length(64).optional(),
  pool: z.object({ outputFile: z.string(), sha256: z.string().length(64) }).optional(),
  qrelsSha256: z.string().length(64).optional(),
  report: z.object({ htmlReportFile: z.string(), outputFile: z.string() }).optional(),
  stage: z.string(),
  status: z.enum(["running", "failed", "complete"]),
});

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonical(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await canonical(path.dirname(file)), path.basename(file));
  }
}

async function preflight(config: EvaluationConfig): Promise<void> {
  if (!config.chunkAblation || !config.queryGeneration || !config.qrelReview) throw new Error("The run command requires chunkAblation, queryGeneration and qrelReview.");
  for (const id of config.queryGeneration.datasetIds) {
    if (!config.qrelReview.datasetIds.includes(id)) throw new Error(`Query dataset ${id} is not allowed for relevance review.`);
  }
  const writable = await Promise.all([config.outputDirectory, ...(config.benchmark.embeddingCacheDirectory ? [config.benchmark.embeddingCacheDirectory] : [])].map(canonical));
  for (const dataset of config.datasets) {
    for (const root of dataset.type === "local" ? dataset.roots : [dataset.root]) {
      const source = await canonical(root);
      if (writable.some((directory) => contains(source, directory) || contains(directory, source))) throw new Error("Evaluation output/model directories must be separate from Session source directories.");
    }
  }
  for (const model of [config.queryGeneration, config.qrelReview]) {
    if (model.transport === "codex") {
      const home = config.codex?.homeDirectory ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
      try { await fs.access(path.join(home, "auth.json")); }
      catch { throw new Error("Codex file login is missing. Log in on this machine or configure codex.homeDirectory."); }
    } else {
      const key = model.apiKeyFile ? (await fs.readFile(model.apiKeyFile, "utf8")).trim() : process.env[model.apiKeyEnv]?.trim();
      if (!key) throw new Error(`Missing model credential: configure apiKeyFile or ${model.apiKeyEnv}.`);
    }
  }
}

export async function runChunkAblationWorkflow(
  config: EvaluationConfig,
  options: { allowExternalModel: boolean; onProgress?: (stage: string) => void },
): Promise<{ htmlReportFile: string; outputFile: string; stateFile: string; queries: number; judgments: number }> {
  if (!options.allowExternalModel) throw new Error("This workflow sends redacted Session evidence to the configured models. Pass --allow-external-model to authorize the datasetIds allow-lists in this config.");
  await preflight(config);
  const root = config.outputDirectory;
  const stateFile = path.join(root, "ablation-run.json");
  const manifestFile = path.join(root, "manifest.json");
  const candidatesFile = path.join(root, "query-candidates.jsonl");
  const qrelsFile = path.join(root, "llm-reviewed-qrels.jsonl");
  const binding = evaluationHash({
    config, workflowVersion: 1, applicationVersion: APP_VERSION, indexRuleVersion: INDEX_RULE_VERSION,
    sensitiveContentRuleVersion: SENSITIVE_CONTENT_RULE_VERSION, embeddingModel: DEFAULT_EMBEDDING_MODEL,
    queryProtocol: queryGenerationProtocolHash(), reviewPromptVersion: QREL_REVIEW_PROMPT_VERSION, reviewInstructions: QREL_REVIEW_INSTRUCTIONS,
  });
  let state: z.infer<typeof stateSchema> = { binding, stage: "fetch", status: "running" };
  try {
    state = stateSchema.parse(JSON.parse(await fs.readFile(stateFile, "utf8")));
    if (state.binding !== binding) throw new Error("Dataset, model, paths, rules or evaluation settings changed. Use a new outputDirectory; existing frozen artifacts were preserved.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const file of [manifestFile, candidatesFile, qrelsFile]) {
      try { await fs.access(file); }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue; throw missing; }
      throw new Error("This outputDirectory contains evaluation artifacts without a matching run checkpoint. Use a new directory.");
    }
  }
  async function checkpoint(stage: string): Promise<void> {
    state.stage = stage;
    state.status = "running";
    await writeJsonFile(stateFile, state);
    options.onProgress?.(stage);
  }
  function localArtifact(file: string): void {
    if (!path.isAbsolute(file) || !contains(root, file)) throw new Error("Run checkpoint references an artifact outside outputDirectory.");
  }
  try {
    await writeJsonFile(path.join(root, "run-config.json"), config);
    await writeJsonFile(path.join(root, "disclosure-authorization.json"), {
      explicitCliAuthorization: true,
      queryDatasetIds: config.queryGeneration!.datasetIds,
      reviewDatasetIds: config.qrelReview!.datasetIds,
      scoreType: "silver qrels; model error is not automatically treated as a failed run",
    });
    await checkpoint("fetch");
    if (!state.fetched) {
      for (const dataset of config.datasets) if (dataset.type === "swe-chat") await materializeSweChat(dataset);
      state.fetched = true;
    }
    await checkpoint("scan");
    const manifest = state.manifestSha256 ? await readEvaluationManifest(manifestFile) : (await scanEvaluation(config, manifestFile)).manifest;
    if (state.manifestSha256 && state.manifestSha256 !== evaluationHash(manifest)) throw new Error("Frozen manifest changed.");
    await validateEvaluationManifest(config, manifest);
    state.manifestSha256 = evaluationHash(manifest);
    await checkpoint("queries");
    if (!state.queriesSha256) await generateQueryCandidates(config, manifest, candidatesFile);
    const candidates = await readQueryCandidates(candidatesFile);
    if (state.queriesSha256 && state.queriesSha256 !== evaluationHash(candidates)) throw new Error("Frozen queries changed.");
    state.queriesSha256 = evaluationHash(candidates);
    if (!candidates.some((candidate) => candidate.queryQuality?.status !== "rejected" && candidate.split === config.benchmark.querySplit)) {
      throw new Error(`No accepted queries in the configured ${config.benchmark.querySplit} split. No fallback split was used. Use a new output directory and adjust query count/split settings.`);
    }
    await checkpoint("pool");
    if (!state.pool) {
      const result = await buildChunkAblationPool(config, manifest, candidatesFile);
      state.pool = { outputFile: result.outputFile, sha256: evaluationHash(await readCandidatePool(result.outputFile)) };
    }
    localArtifact(state.pool.outputFile);
    const pool = await readCandidatePool(state.pool.outputFile);
    if (evaluationHash(pool) !== state.pool.sha256) throw new Error("Frozen candidate pool changed.");
    await checkpoint("review");
    if (!state.qrelsSha256) await reviewQrelsWithLlm(config, candidatesFile, state.pool.outputFile, QREL_REVIEW_INSTRUCTIONS, qrelsFile);
    const qrels = await readQueryCandidates(qrelsFile);
    if (state.qrelsSha256 && state.qrelsSha256 !== evaluationHash(qrels)) throw new Error("Frozen silver qrels changed.");
    state.qrelsSha256 = evaluationHash(qrels);
    await checkpoint("benchmark");
    if (!state.report) {
      const result = await runChunkAblation(config, manifest, state.pool.outputFile, qrelsFile);
      state.report = { htmlReportFile: result.htmlReportFile, outputFile: result.outputFile };
    }
    localArtifact(state.report.outputFile);
    localArtifact(state.report.htmlReportFile);
    await fs.access(state.report.outputFile);
    await fs.access(state.report.htmlReportFile);
    state.status = "complete";
    await writeJsonFile(stateFile, state);
    return { ...state.report, stateFile, queries: pool.queries.length, judgments: pool.queries.reduce((sum, query) => sum + query.results.length, 0) };
  } catch (error) {
    state.status = "failed";
    await writeJsonFile(stateFile, state);
    throw error;
  }
}
