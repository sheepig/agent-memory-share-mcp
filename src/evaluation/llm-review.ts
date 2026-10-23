import fs from "node:fs/promises";
import path from "node:path";

import OpenAI from "openai";
import { z } from "zod";

import { readCandidatePool, readQueryCandidates, writeQueryCandidates } from "./files.js";
import { evaluationHash } from "./identity.js";
import type { CandidatePool, EvaluationConfig, QueryCandidate } from "./types.js";

export const QREL_REVIEW_PROMPT_VERSION = 1;

const judgeResponseSchema = z.object({
  reason: z.string().min(1),
  relevance: z.number().int().min(0).max(3),
});

type PoolResult = CandidatePool["queries"][number]["results"][number];
type QrelReviewConfig = NonNullable<EvaluationConfig["qrelReview"]>;

interface ReviewDependencies {
  fetch?: typeof fetch;
}

function jsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  return JSON.parse(trimmed);
}

function lineNumber(location: string | undefined): number {
  const match = /^line:(\d+)$/u.exec(location ?? "");
  if (!match) throw new Error(`Pooled evidence has no JSONL line location: ${location ?? "missing"}`);
  return Number(match[1]);
}

async function apiKeyFor(config: QrelReviewConfig): Promise<string> {
  const apiKey = config.apiKeyFile
    ? (await fs.readFile(config.apiKeyFile, "utf8")).trim()
    : process.env[config.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`Missing qrels review API key. Set ${config.apiKeyEnv} or configure apiKeyFile.`);
  return apiKey;
}

async function concurrentMap<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function judgeResult(
  client: OpenAI,
  config: QrelReviewConfig,
  instructions: string,
  query: string,
  result: PoolResult,
): Promise<{ model: string; reason: string; relevance: number }> {
  const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    thinking: { type: "disabled" };
  } = {
    messages: [
      { content: instructions, role: "system" },
      {
        content: JSON.stringify({ passage: result.text, query }),
        role: "user",
      },
    ],
    model: config.model,
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0,
    thinking: { type: "disabled" },
  };
  for (let attempt = 0; ; attempt += 1) {
    const response = await client.chat.completions.create(request);
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error("LLM qrels review response did not contain message content.");
    try {
      const judgment = judgeResponseSchema.parse(jsonObject(content));
      return { ...judgment, model: response.model };
    } catch (error) {
      // Retry malformed model output without coercing or persisting invalid judgments.
      if (attempt >= 2 || !(error instanceof z.ZodError || error instanceof SyntaxError)) throw error;
    }
  }
}

function existingReviewMatches(candidate: QueryCandidate, config: QrelReviewConfig, pool: CandidatePool): boolean {
  const reviewer = candidate.review.reviewer;
  return candidate.review.completeness === "complete"
    && typeof reviewer === "object"
    && reviewer.type === "llm"
    && reviewer.model === config.model
    && reviewer.provider === config.provider
    && reviewer.promptVersion === QREL_REVIEW_PROMPT_VERSION
    && reviewer.relevanceThreshold === config.relevanceThreshold
    && candidate.review.scope?.type === "pooled"
    && candidate.review.scope.depth === pool.depth
    && candidate.review.scope.poolGeneratedAt === pool.generatedAt
    && (!pool.chunkAblation || candidate.review.scope.poolSha256 === evaluationHash(pool))
    && candidate.review.scope.modes.join("\0") === pool.modes.join("\0");
}

function goldSpan(result: PoolResult) {
  return {
    ...(result.chunkIndex !== undefined ? { chunkIndex: result.chunkIndex } : {}),
    endLine: lineNumber(result.endLocation ?? result.location),
    ...(result.endNativeEventId ? { endNativeEventId: result.endNativeEventId } : {}),
    ...(result.passageId ? { passageId: result.passageId } : {}),
    sessionId: result.sessionId,
    startLine: lineNumber(result.location),
    ...(result.nativeEventId ? { startNativeEventId: result.nativeEventId } : {}),
  };
}

export async function reviewQrelsWithLlm(
  config: EvaluationConfig,
  candidatesFile: string,
  poolFile: string,
  instructions: string,
  outputFile = path.join(config.outputDirectory, "llm-reviewed-qrels.jsonl"),
  dependencies: ReviewDependencies = {},
): Promise<{ accepted: number; outputFile: string; rejected: number; reviewed: number }> {
  if (!config.qrelReview) throw new Error("qrelReview is missing from the evaluation config.");
  const reviewConfig = config.qrelReview;
  const [candidates, pool] = await Promise.all([readQueryCandidates(candidatesFile), readCandidatePool(poolFile)]);
  const allowedDatasets = new Set(reviewConfig.datasetIds);
  const poolByCandidate = new Map(pool.queries.map((query) => [query.candidateId, query]));
  if (poolByCandidate.size !== pool.queries.length) throw new Error("Candidate pool contains duplicate candidate IDs.");
  pool.queries.forEach((query) => {
    if (!candidates.some((candidate) => candidate.candidateId === query.candidateId)) {
      throw new Error(`Candidate pool references unknown candidate: ${query.candidateId}`);
    }
  });

  let previous: QueryCandidate[] = [];
  try {
    previous = await readQueryCandidates(outputFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previousById = new Map(previous.map((candidate) => [candidate.candidateId, candidate]));
  const completed = new Map<string, QueryCandidate>();
  const apiKey = await apiKeyFor(reviewConfig);
  const client = new OpenAI({
    apiKey,
    baseURL: reviewConfig.baseUrl,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    maxRetries: 4,
    timeout: 120_000,
  });

  for (const candidate of candidates) {
    if (!allowedDatasets.has(candidate.datasetId)) {
      completed.set(candidate.candidateId, candidate);
      continue;
    }
    if (candidate.queryQuality?.status === "rejected") {
      completed.set(candidate.candidateId, candidate);
      continue;
    }
    const prior = previousById.get(candidate.candidateId);
    if (prior && prior.datasetId === candidate.datasetId && prior.query === candidate.query
      && existingReviewMatches(prior, reviewConfig, pool)) {
      completed.set(candidate.candidateId, prior);
      continue;
    }
    const pooled = poolByCandidate.get(candidate.candidateId);
    if (!pooled) throw new Error(`Candidate pool is missing candidate: ${candidate.candidateId}`);
    if (pooled.datasetId !== candidate.datasetId || pooled.query !== candidate.query) {
      throw new Error(`Candidate pool does not match query candidate: ${candidate.candidateId}`);
    }
    const judgments = await concurrentMap(pooled.results, reviewConfig.concurrency, async (result) => ({
      result,
      value: await judgeResult(client, reviewConfig, instructions, candidate.query, result),
    }));
    const relevant = judgments.filter(({ value }) => value.relevance >= reviewConfig.relevanceThreshold);
    const reportedModels = [...new Set(judgments.map(({ value }) => value.model))].sort();
    const reviewed: QueryCandidate = {
      ...candidate,
      goldSpans: relevant.length > 0 ? relevant.map(({ result }) => goldSpan(result)) : candidate.goldSpans,
      review: {
        completeness: "complete",
        judgments: judgments.map(({ result, value }) => ({
          ...(result.chunkIndex !== undefined ? { chunkIndex: result.chunkIndex } : {}),
          endLine: lineNumber(result.endLocation ?? result.location),
          ...(result.passageId ? { passageId: result.passageId } : {}),
          reason: value.reason,
          relevance: value.relevance,
          sessionId: result.sessionId,
          startLine: lineNumber(result.location),
        })),
        reviewedAt: new Date().toISOString(),
        reviewer: {
          model: reviewConfig.model,
          promptVersion: QREL_REVIEW_PROMPT_VERSION,
          provider: reviewConfig.provider,
          relevanceThreshold: reviewConfig.relevanceThreshold,
          reportedModels,
          type: "llm",
        },
        scope: {
          depth: pool.depth,
          modes: pool.modes,
          poolGeneratedAt: pool.generatedAt,
          ...(pool.chunkAblation ? { poolSha256: evaluationHash(pool) } : {}),
          type: "pooled",
        },
        status: relevant.length > 0 ? "accepted" : "rejected",
      },
    };
    completed.set(candidate.candidateId, reviewed);
    await writeQueryCandidates(outputFile, candidates.map((value) => completed.get(value.candidateId) ?? value));
  }

  const output = candidates.map((candidate) => completed.get(candidate.candidateId) ?? candidate);
  await writeQueryCandidates(outputFile, output);
  const reviewed = output.filter((candidate) => allowedDatasets.has(candidate.datasetId)
    && candidate.queryQuality?.status !== "rejected" && candidate.review.completeness === "complete");
  return {
    accepted: reviewed.filter((candidate) => candidate.review.status === "accepted").length,
    outputFile,
    rejected: reviewed.filter((candidate) => candidate.review.status === "rejected").length,
    reviewed: reviewed.length,
  };
}
