import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { relevanceThreshold, type EvaluationSearchResult } from "./metrics.js";
import type { EvaluationConfig, QueryCandidate } from "./types.js";

const execFile = promisify(execFileCallback);

type SearchMode = string;

export interface StandardRun {
  candidateId: string;
  datasetId: string;
  latencyMs?: number[];
  mode: SearchMode;
  results: EvaluationSearchResult[];
}

export interface NativeMetrics {
  mrrAt10: number;
  ndcgAt10: number;
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
}

interface StandardEvaluationInput {
  candidates: readonly QueryCandidate[];
  nativeMetrics: ReadonlyMap<string, NativeMetrics>;
  outputDirectory: string;
  runs: readonly StandardRun[];
  tools?: EvaluationConfig["benchmark"]["standardTools"];
}

interface CommandResult {
  stdout: string;
}

export interface StandardEvaluationDependencies {
  runCommand?: (command: string, args: readonly string[]) => Promise<CommandResult>;
}

export interface StandardModeResult {
  artifacts: { binaryQrelsFile: string; qrelsFile: string; runFile: string; top10RunFile: string };
  irMeasures: { judgedAt10: number; maxAbsoluteDelta?: number; metrics?: NativeMetrics; status: "passed" } | { status: "not_configured" };
  mode: SearchMode;
  trecEval: {
    maxAbsoluteDelta: number;
    metrics: NativeMetrics;
    status: "passed";
  } | { status: "not_configured" | "skipped_empty_run" };
}

export interface StandardDatasetResult {
  datasetId: string;
  modes: StandardModeResult[];
}

export interface StandardEvaluationResult {
  datasets: StandardDatasetResult[];
  irMeasuresCommand: string | null;
  status: "not_configured" | "passed";
  trecEvalCommand: string | null;
}

function lineNumber(location: string | undefined): number {
  const match = /^line:(\d+)$/u.exec(location ?? "");
  if (!match) throw new Error(`TREC evidence has no JSONL line location: ${location ?? "missing"}`);
  return Number(match[1]);
}

export function trecDocumentId(
  datasetId: string,
  sessionId: string,
  startLine: number,
  endLine: number,
  chunkIndex?: number,
  passageId?: string,
): string {
  const digest = createHash("sha256")
    .update(passageId === undefined
      ? `${datasetId}\0${sessionId}\0${startLine}\0${endLine}\0${chunkIndex ?? "legacy"}`
      : `${datasetId}\0passage\0${passageId}`)
    .digest("hex");
  return `${datasetId}-${digest.slice(0, 32)}`;
}

function usesChunkIdentity(candidate: QueryCandidate): boolean {
  const units = candidate.review.judgments?.length ? candidate.review.judgments : candidate.goldSpans;
  return units.some((unit) => unit.chunkIndex !== undefined);
}

function usesPassageIdentity(candidate: QueryCandidate): boolean {
  const units = candidate.review.judgments?.length ? candidate.review.judgments : candidate.goldSpans;
  return units.some((unit) => unit.passageId !== undefined);
}

function qrelsFor(datasetId: string, candidates: readonly QueryCandidate[], binary: boolean): string {
  const lines: string[] = [];
  for (const candidate of candidates) {
    const judgments = candidate.review.judgments;
    if (judgments && judgments.length > 0) {
      for (const judgment of judgments) {
        const relevance = binary ? Number(judgment.relevance >= relevanceThreshold(candidate)) : judgment.relevance;
        lines.push(`${candidate.candidateId} 0 ${trecDocumentId(datasetId, judgment.sessionId, judgment.startLine, judgment.endLine, judgment.chunkIndex, judgment.passageId)} ${relevance}`);
      }
      continue;
    }
    for (const span of candidate.goldSpans) {
      lines.push(`${candidate.candidateId} 0 ${trecDocumentId(datasetId, span.sessionId, span.startLine, span.endLine, span.chunkIndex, span.passageId)} 1`);
    }
  }
  return `${[...new Set(lines)].sort().join("\n")}\n`;
}

function runLines(
  datasetId: string,
  mode: SearchMode,
  runs: readonly StandardRun[],
  candidates: readonly QueryCandidate[],
  limit: number,
): string {
  const lines: string[] = [];
  const candidatesById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const run of runs.filter((value) => value.datasetId === datasetId && value.mode === mode)) {
    const candidate = candidatesById.get(run.candidateId);
    if (!candidate) throw new Error(`TREC run references unknown candidate: ${run.candidateId}`);
    const includeChunkIndex = usesChunkIdentity(candidate);
    const includePassageId = usesPassageIdentity(candidate);
    const seen = new Set<string>();
    let rank = 0;
    for (const result of run.results) {
      if (!result.sessionId) throw new Error(`TREC Session result has no session ID: ${result.fragmentId}`);
      const startLine = lineNumber(result.location);
      const endLine = lineNumber(result.endLocation ?? result.location);
      if (includePassageId && !result.passageId) throw new Error(`TREC ablation result has no passage ID: ${result.fragmentId}`);
      const documentId = trecDocumentId(
        datasetId,
        result.sessionId,
        startLine,
        endLine,
        includeChunkIndex ? result.chunkIndex : undefined,
        includePassageId ? result.passageId : undefined,
      );
      if (seen.has(documentId)) continue;
      seen.add(documentId);
      rank += 1;
      if (rank > limit) break;
      lines.push(`${run.candidateId} Q0 ${documentId} ${rank} ${limit - rank + 1} agent-memory-${mode}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function writeText(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, { mode: 0o600 });
}

function parsedMetric(output: string, name: string): number {
  for (const line of output.split("\n")) {
    const [metric, topic, rawValue] = line.trim().split(/\s+/u);
    if (metric === name && (topic === "all" || rawValue === undefined)) {
      const value = Number(rawValue ?? topic);
      if (Number.isFinite(value)) return value;
    }
  }
  throw new Error(`Standard evaluation output did not contain ${name}.`);
}

function checkedDelta(native: NativeMetrics, standard: NativeMetrics): number {
  const deltas = (Object.keys(standard) as Array<keyof NativeMetrics>).map((key) => Math.abs(native[key] - standard[key]));
  const maximum = Math.max(...deltas);
  if (maximum > 0.0001) throw new Error(`Standard evaluation metrics differ from native metrics by ${maximum}.`);
  return maximum;
}

async function defaultRunCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  try {
    const result = await execFile(command, [...args], { maxBuffer: 4 * 1024 * 1024 });
    return { stdout: result.stdout };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`Standard evaluation command is unavailable: ${command}`);
    throw error;
  }
}

async function verifyMode(
  datasetId: string,
  mode: SearchMode,
  candidates: readonly QueryCandidate[],
  runs: readonly StandardRun[],
  native: NativeMetrics,
  outputDirectory: string,
  tools: EvaluationConfig["benchmark"]["standardTools"],
  runCommand: (command: string, args: readonly string[]) => Promise<CommandResult>,
): Promise<StandardModeResult> {
  const datasetDirectory = path.join(outputDirectory, "trec", datasetId);
  const qrelsFile = path.join(datasetDirectory, "qrels.txt");
  const binaryQrelsFile = path.join(datasetDirectory, "qrels-binary.txt");
  const runFile = path.join(datasetDirectory, `run-${mode}.txt`);
  const top10RunFile = path.join(datasetDirectory, `run-${mode}-top10.txt`);
  await Promise.all([
    writeText(qrelsFile, qrelsFor(datasetId, candidates, false)),
    writeText(binaryQrelsFile, qrelsFor(datasetId, candidates, true)),
    writeText(runFile, runLines(datasetId, mode, runs, candidates, 20)),
    writeText(top10RunFile, runLines(datasetId, mode, runs, candidates, 10)),
  ]);
  const artifacts = { binaryQrelsFile, qrelsFile, runFile, top10RunFile };
  if (!tools) return { artifacts, irMeasures: { status: "not_configured" }, mode, trecEval: { status: "not_configured" } };
  const missingPooledJudgments = candidates.filter((candidate) => !candidate.review.judgments?.length);
  if (missingPooledJudgments.length > 0) {
    throw new Error(`Standard evaluation requires pooled judgments for every query: ${missingPooledJudgments.map((candidate) => candidate.candidateId).join(", ")}`);
  }

  const hasResults = runs.some((run) => run.datasetId === datasetId && run.mode === mode && run.results.length > 0);
  if (!hasResults) {
    // trec_eval cannot read a wholly empty run. Keep it empty and verify its zeros with ir-measures.
    const [binary, graded] = await Promise.all([
      runCommand(tools.irMeasuresCommand, [binaryQrelsFile, runFile, "R@5", "R@10", "R@20", "RR@10"]),
      runCommand(tools.irMeasuresCommand, [qrelsFile, runFile, "nDCG@10", "Judged@10"]),
    ]);
    const standard: NativeMetrics = {
      recallAt5: parsedMetric(binary.stdout, "R@5"),
      recallAt10: parsedMetric(binary.stdout, "R@10"),
      recallAt20: parsedMetric(binary.stdout, "R@20"),
      mrrAt10: parsedMetric(binary.stdout, "RR@10"),
      ndcgAt10: parsedMetric(graded.stdout, "nDCG@10"),
    };
    return {
      artifacts, mode,
      trecEval: { status: "skipped_empty_run" },
      irMeasures: {
        judgedAt10: parsedMetric(graded.stdout, "Judged@10"),
        maxAbsoluteDelta: checkedDelta(native, standard), metrics: standard, status: "passed",
      },
    };
  }

  const [recall, ndcg, reciprocalRank, judged] = await Promise.all([
    runCommand(tools.trecEvalCommand, ["-c", "-m", "recall.5,10,20", binaryQrelsFile, runFile]),
    runCommand(tools.trecEvalCommand, ["-c", "-m", "ndcg_cut.10", qrelsFile, runFile]),
    runCommand(tools.trecEvalCommand, ["-c", "-m", "recip_rank", binaryQrelsFile, top10RunFile]),
    runCommand(tools.irMeasuresCommand, [qrelsFile, runFile, "Judged@10"]),
  ]);
  const standard: NativeMetrics = {
    mrrAt10: parsedMetric(reciprocalRank.stdout, "recip_rank"),
    ndcgAt10: parsedMetric(ndcg.stdout, "ndcg_cut_10"),
    recallAt5: parsedMetric(recall.stdout, "recall_5"),
    recallAt10: parsedMetric(recall.stdout, "recall_10"),
    recallAt20: parsedMetric(recall.stdout, "recall_20"),
  };
  return {
    artifacts,
    irMeasures: { judgedAt10: parsedMetric(judged.stdout, "Judged@10"), status: "passed" },
    mode,
    trecEval: { maxAbsoluteDelta: checkedDelta(native, standard), metrics: standard, status: "passed" },
  };
}

export async function runStandardEvaluation(
  input: StandardEvaluationInput,
  dependencies: StandardEvaluationDependencies = {},
): Promise<StandardEvaluationResult> {
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const acceptedCandidates = input.candidates.filter((candidate) => candidate.review.status === "accepted"
    && candidate.queryQuality?.status !== "rejected");
  const datasetIds = [...new Set(acceptedCandidates.map((candidate) => candidate.datasetId))].sort();
  const datasets: StandardDatasetResult[] = [];
  for (const datasetId of datasetIds) {
    const candidates = acceptedCandidates.filter((candidate) => candidate.datasetId === datasetId);
    const modes: StandardModeResult[] = [];
    for (const mode of [...new Set(input.runs.filter((run) => run.datasetId === datasetId).map((run) => run.mode))]) {
      const native = input.nativeMetrics.get(`${datasetId}\0${mode}`);
      if (!native) throw new Error(`Native metrics are missing for ${datasetId}/${mode}.`);
      modes.push(await verifyMode(datasetId, mode, candidates, input.runs, native, input.outputDirectory, input.tools, runCommand));
    }
    datasets.push({ datasetId, modes });
  }
  return {
    datasets,
    irMeasuresCommand: input.tools?.irMeasuresCommand ?? null,
    status: input.tools ? "passed" : "not_configured",
    trecEvalCommand: input.tools?.trecEvalCommand ?? null,
  };
}
