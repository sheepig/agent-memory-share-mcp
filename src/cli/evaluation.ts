import path from "node:path";

import { InvalidArgumentError, type Command } from "commander";

import { buildChunkAblationPool, runChunkAblation } from "../evaluation/chunk-ablation.js";
import { runBenchmark, validateReviewedCandidates } from "../evaluation/benchmark.js";
import { readEvaluationConfig, readEvaluationManifest, readQueryCandidates } from "../evaluation/files.js";
import { materializeSweChat } from "../evaluation/hugging-face.js";
import { startHumanReviewServer } from "../evaluation/human-review.js";
import { generateQueryCandidates } from "../evaluation/query-generation.js";
import { reviewQrelsWithLlm } from "../evaluation/llm-review.js";
import { buildCandidatePool } from "../evaluation/pool.js";
import { QREL_REVIEW_INSTRUCTIONS } from "../evaluation/review-prompt.js";
import { scanEvaluation } from "../evaluation/scanner.js";
import { buildRerankPool, runRerankBenchmark } from "../evaluation/rerank.js";

type Emit = (value: unknown, json: boolean) => void;

function jsonMode(command: Command): boolean {
  return command.optsWithGlobals<{ json?: boolean }>().json ?? false;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new InvalidArgumentError("value must be a positive integer");
  return parsed;
}

export function registerEvaluationCommands(program: Command, emit: Emit): void {
  const evaluation = program.command("eval").description("Run reproducible retrieval evaluation locally or on a cloud server.");

  evaluation.command("fetch")
    .requiredOption("--config <path>", "evaluation config JSON")
    .description("Materialize configured remote datasets without scanning or indexing them.")
    .action(async (options: { config: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const datasets = [];
      for (const dataset of config.datasets) {
        if (dataset.type === "swe-chat") datasets.push({ id: dataset.id, ...await materializeSweChat(dataset) });
      }
      emit({ datasets }, jsonMode(command));
    });

  evaluation.command("scan")
    .requiredOption("--config <path>", "evaluation config JSON")
    .option("--output <path>", "manifest output path")
    .description("Scan explicit roots and write a manifest containing only eligible sessions.")
    .action(async (options: { config: string; output?: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const result = await scanEvaluation(config, options.output ? path.resolve(options.output) : undefined);
      emit({
        datasets: result.manifest.datasets.map((dataset) => ({
          diagnostics: dataset.diagnostics,
          eligibleSessions: dataset.eligibleSessions,
          id: dataset.id,
          sourceBytes: dataset.sourceBytes,
          sourceFilesVisited: dataset.sourceFilesVisited,
        })),
        outputFile: result.outputFile,
      }, jsonMode(command));
    });

  evaluation.command("generate-queries")
    .requiredOption("--config <path>", "evaluation config JSON")
    .requiredOption("--manifest <path>", "eligible-session manifest")
    .option("--output <path>", "JSONL candidate output path")
    .description("Use an OpenAI-compatible LLM to generate pending query and qrels candidates.")
    .action(async (options: { config: string; manifest: string; output?: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const manifest = await readEvaluationManifest(path.resolve(options.manifest));
      const result = await generateQueryCandidates(config, manifest, options.output ? path.resolve(options.output) : undefined);
      emit({
        acceptedQueries: result.candidates.filter((candidate) => candidate.queryQuality?.status !== "rejected").length,
        candidates: result.candidates.length,
        outputFile: result.outputFile,
        rejectedQueries: result.candidates.filter((candidate) => candidate.queryQuality?.status === "rejected").length,
        reviewStatus: "pending",
      }, jsonMode(command));
    });

  evaluation.command("validate-qrels")
    .requiredOption("--qrels <path>", "reviewed query candidate JSONL")
    .description("Require every generated candidate to have a terminal, complete review decision.")
    .action(async (options: { qrels: string }, command) => {
      const candidates = await readQueryCandidates(path.resolve(options.qrels));
      validateReviewedCandidates(candidates);
      emit({
        accepted: candidates.filter((candidate) => candidate.review.status === "accepted").length,
        rejected: candidates.filter((candidate) => candidate.review.status === "rejected").length,
        total: candidates.length,
      }, jsonMode(command));
    });

  evaluation.command("pool")
    .requiredOption("--config <path>", "evaluation config JSON")
    .requiredOption("--manifest <path>", "eligible-session manifest")
    .requiredOption("--candidates <path>", "generated query candidate JSONL")
    .description("Build pooled retrieval candidates for human or LLM completeness review.")
    .action(async (options: { candidates: string; config: string; manifest: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const manifest = await readEvaluationManifest(path.resolve(options.manifest));
      emit(await buildCandidatePool(config, manifest, path.resolve(options.candidates)), jsonMode(command));
    });

  evaluation.command("review-qrels")
    .requiredOption("--config <path>", "evaluation config JSON")
    .requiredOption("--candidates <path>", "generated query candidate JSONL")
    .requiredOption("--pool <path>", "pooled retrieval candidate JSON")
    .option("--output <path>", "LLM-reviewed qrels JSONL output path")
    .description("Use a configured OpenAI-compatible LLM to review every pooled query and Session chunk.")
    .action(async (options: { candidates: string; config: string; output?: string; pool: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const result = await reviewQrelsWithLlm(
        config,
        path.resolve(options.candidates),
        path.resolve(options.pool),
        QREL_REVIEW_INSTRUCTIONS,
        options.output ? path.resolve(options.output) : undefined,
      );
      emit(result, jsonMode(command));
    });

  evaluation.command("review-ui")
    .requiredOption("--qrels <path>", "LLM-reviewed qrels JSONL")
    .requiredOption("--pool <path>", "pooled retrieval candidate JSON")
    .requiredOption("--reviewer <name>", "human reviewer name")
    .option("--limit <count>", "number of query-by-chunk cases", positiveInteger, 50)
    .option("--output <path>", "human audit JSONL output path")
    .option("--port <port>", "loopback review UI port", positiveInteger, 43_111)
    .description("Run a separate loopback UI for blind human review of LLM qrels.")
    .action(async (options: { limit: number; output?: string; pool: string; port: number; qrels: string; reviewer: string }, command) => {
      const qrelsFile = path.resolve(options.qrels);
      const result = await startHumanReviewServer({
        limit: options.limit,
        outputFile: options.output ? path.resolve(options.output) : path.join(path.dirname(qrelsFile), "human-audit.jsonl"),
        poolFile: path.resolve(options.pool),
        port: options.port,
        qrelsFile,
        reviewer: options.reviewer,
      });
      emit({ completed: result.completed, outputFile: result.outputFile, total: result.total, url: result.url }, jsonMode(command));
    });

  evaluation.command("benchmark")
    .requiredOption("--config <path>", "evaluation config JSON")
    .requiredOption("--manifest <path>", "eligible-session manifest")
    .option("--qrels <path>", "reviewed query candidate JSONL")
    .description("Index the fixed manifest and measure indexing, search latency, and retrieval quality.")
    .action(async (options: { config: string; manifest: string; qrels?: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const manifest = await readEvaluationManifest(path.resolve(options.manifest));
      const result = await runBenchmark(config, manifest, options.qrels ? path.resolve(options.qrels) : undefined);
      emit({ htmlReportFile: result.htmlReportFile, outputFile: result.outputFile, report: result.report }, jsonMode(command));
    });

  const rerank = evaluation.command("rerank").description("Compare hybrid ranking with a local cross-encoder on frozen candidates.");

  rerank.command("pool")
    .requiredOption("--config <path>", "evaluation config with reranker settings")
    .requiredOption("--manifest <path>", "eligible-session manifest")
    .requiredOption("--candidates <path>", "fixed query candidate JSONL")
    .description("Freeze hybrid candidates and build a complete reranking judgment pool.")
    .action(async (options: { candidates: string; config: string; manifest: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const manifest = await readEvaluationManifest(path.resolve(options.manifest));
      emit(await buildRerankPool(config, manifest, path.resolve(options.candidates)), jsonMode(command));
    });

  rerank.command("benchmark")
    .requiredOption("--config <path>", "evaluation config with reranker settings")
    .requiredOption("--manifest <path>", "eligible-session manifest")
    .requiredOption("--pool <path>", "frozen reranker judgment pool")
    .requiredOption("--retrieval <path>", "frozen hybrid candidate artifact")
    .requiredOption("--qrels <path>", "complete reviewed qrels for the pool")
    .description("Measure paired ranking quality and real local reranker inference latency.")
    .action(async (options: { config: string; manifest: string; pool: string; qrels: string; retrieval: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const manifest = await readEvaluationManifest(path.resolve(options.manifest));
      emit(await runRerankBenchmark(config, manifest, path.resolve(options.pool), path.resolve(options.qrels), path.resolve(options.retrieval)), jsonMode(command));
    });

  const ablation = evaluation.command("ablate-chunks").description("Compare Session chunk sizes and overlaps against one reviewed passage pool.");

  ablation.command("pool")
    .requiredOption("--config <path>", "evaluation config with chunkAblation.variants")
    .requiredOption("--manifest <path>", "eligible-session manifest")
    .requiredOption("--candidates <path>", "fixed generated query candidate JSONL")
    .description("Index each chunk variant and pool its retrieved and seed-turn passages for one review.")
    .action(async (options: { candidates: string; config: string; manifest: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const manifest = await readEvaluationManifest(path.resolve(options.manifest));
      emit(await buildChunkAblationPool(config, manifest, path.resolve(options.candidates)), jsonMode(command));
    });

  ablation.command("benchmark")
    .requiredOption("--config <path>", "evaluation config with chunkAblation.variants")
    .requiredOption("--manifest <path>", "eligible-session manifest")
    .requiredOption("--pool <path>", "unified chunk ablation candidate pool")
    .requiredOption("--qrels <path>", "reviewed qrels for the unified pool")
    .description("Benchmark each variant using only its own passages from the shared reviewed pool.")
    .action(async (options: { config: string; manifest: string; pool: string; qrels: string }, command) => {
      const config = await readEvaluationConfig(path.resolve(options.config));
      const manifest = await readEvaluationManifest(path.resolve(options.manifest));
      const result = await runChunkAblation(config, manifest, path.resolve(options.pool), path.resolve(options.qrels));
      emit(result, jsonMode(command));
    });
}
