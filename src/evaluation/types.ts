import path from "node:path";

import { z } from "zod";

export const evaluationAgentSchema = z.enum(["codex", "claude-code"]);
export type EvaluationAgent = z.infer<typeof evaluationAgentSchema>;

const absolutePath = z.string().min(1).refine(path.isAbsolute, "path must be absolute");
const datasetId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u, "dataset id must use lowercase letters, digits, _ or -");
const commonDataset = {
  agent: evaluationAgentSchema,
  id: datasetId,
  maxEligibleSessions: z.number().int().positive().optional(),
};

export const localDatasetSchema = z.object({
  ...commonDataset,
  roots: z.array(absolutePath).min(1),
  type: z.literal("local"),
});

export const sweChatDatasetSchema = z.object({
  ...commonDataset,
  maxSourceFiles: z.number().int().positive().optional(),
  repository: z.string().min(1).default("SALT-NLP/SWE-chat"),
  revision: z.string().regex(/^[a-f0-9]{40}$/u, "revision must be a full commit hash"),
  root: absolutePath,
  tokenEnv: z.string().min(1).default("HF_TOKEN"),
  tokenFile: absolutePath.optional(),
  type: z.literal("swe-chat"),
});

export const evaluationDatasetSchema = z.discriminatedUnion("type", [localDatasetSchema, sweChatDatasetSchema]);
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;

export const searchModeSchema = z.enum(["keyword", "semantic", "hybrid"]);
export const evaluationSplitSchema = z.enum(["dev", "validation", "test"]);

const querySplitConfigSchema = z.object({
  groupBy: z.enum(["project", "session"]).default("project"),
  seed: z.string().min(1).default("evaluation-v1"),
  testPercent: z.number().int().min(1).max(98).default(20),
  validationPercent: z.number().int().min(1).max(98).default(20),
}).refine(
  (value) => value.testPercent + value.validationPercent < 100,
  "testPercent and validationPercent must leave at least one percent for dev",
);

export const chunkVariantSchema = z.object({
  id: datasetId,
  maxContentTokens: z.number().int().positive(),
  overlapContentTokens: z.number().int().nonnegative(),
}).refine(
  (variant) => variant.overlapContentTokens < variant.maxContentTokens,
  "chunk overlap must be smaller than chunk size",
);

export type ChunkVariant = z.infer<typeof chunkVariantSchema>;

const chunkAblationSchema = z.object({
  variants: z.array(chunkVariantSchema).min(2).superRefine((variants, context) => {
    const ids = new Set<string>();
    variants.forEach((variant, index) => {
      if (ids.has(variant.id)) context.addIssue({ code: "custom", message: `duplicate chunk variant id: ${variant.id}`, path: [index, "id"] });
      ids.add(variant.id);
    });
  }),
});

export const evaluationConfigSchema = z.object({
  benchmark: z.object({
    allowUnjudgedResults: z.boolean().optional(),
    embeddingCacheDirectory: absolutePath.optional(),
    modes: z.array(searchModeSchema).min(1).default(["keyword"]),
    querySplit: evaluationSplitSchema.default("test"),
    queryRuns: z.number().int().positive().default(3),
    queryWarmupRuns: z.number().int().nonnegative().default(1),
    standardTools: z.object({
      irMeasuresCommand: z.string().min(1).default("ir_measures"),
      trecEvalCommand: z.string().min(1).default("trec_eval"),
    }).optional(),
  }).default({ modes: ["keyword"], querySplit: "test", queryRuns: 3, queryWarmupRuns: 1 }),
  chunkAblation: chunkAblationSchema.optional(),
  datasets: z.array(evaluationDatasetSchema).min(1).superRefine((datasets, context) => {
    const ids = new Set<string>();
    datasets.forEach((dataset, index) => {
      if (ids.has(dataset.id)) {
        context.addIssue({ code: "custom", message: `duplicate dataset id: ${dataset.id}`, path: [index, "id"] });
      }
      ids.add(dataset.id);
    });
  }),
  outputDirectory: absolutePath,
  reranker: z.object({
    cacheDirectory: absolutePath,
    candidateCounts: z.array(z.number().int().min(20).max(200)).min(1).refine(
      (counts) => new Set(counts).size === counts.length,
      "reranker candidate counts must be unique",
    ),
    queryLimit: z.number().int().positive().optional(),
  }).optional(),
  qrelReview: z.object({
    apiKeyEnv: z.string().min(1).default("DEEPSEEK_API_KEY"),
    apiKeyFile: absolutePath.optional(),
    baseUrl: z.url().default("https://api.deepseek.com"),
    concurrency: z.number().int().positive().max(32).default(8),
    datasetIds: z.array(datasetId).min(1),
    model: z.string().min(1).default("deepseek-flash"),
    provider: z.string().min(1).default("deepseek"),
    relevanceThreshold: z.number().int().min(1).max(3).default(2),
  }).optional(),
  queryGeneration: z.object({
    apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
    apiKeyFile: absolutePath.optional(),
    baseUrl: z.url(),
    datasetIds: z.array(datasetId).min(1),
    maxQueries: z.number().int().positive().default(200),
    model: z.string().min(1),
    qualityReviewModel: z.string().min(1).optional(),
    split: querySplitConfigSchema.default({
      groupBy: "project",
      seed: "evaluation-v1",
      testPercent: 20,
      validationPercent: 20,
    }),
  }).optional(),
  schemaVersion: z.literal(1),
}).superRefine((config, context) => {
  const configuredIds = new Set(config.datasets.map((dataset) => dataset.id));
  config.qrelReview?.datasetIds.forEach((id, index) => {
    if (!configuredIds.has(id)) context.addIssue({ code: "custom", message: `unknown qrel-review dataset: ${id}`, path: ["qrelReview", "datasetIds", index] });
  });
  config.queryGeneration?.datasetIds.forEach((id, index) => {
    if (!configuredIds.has(id)) context.addIssue({ code: "custom", message: `unknown query-generation dataset: ${id}`, path: ["queryGeneration", "datasetIds", index] });
  });
});

export type EvaluationConfig = z.infer<typeof evaluationConfigSchema>;

export const manifestChunkSchema = z.object({
  characters: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative().optional(),
  contentTokenCount: z.number().int().nonnegative().optional(),
  endLocation: z.string().optional(),
  endNativeEventId: z.string().optional(),
  endedAt: z.string().optional(),
  location: z.string(),
  nativeEventId: z.string().optional(),
  ordinal: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  turnCount: z.number().int().positive().optional(),
});

export const manifestSessionSchema = z.object({
  byteSize: z.number().int().nonnegative(),
  chunks: z.array(manifestChunkSchema).min(1),
  contentFingerprint: z.string(),
  projectPath: z.string().optional(),
  relativePath: z.string(),
  rootIndex: z.number().int().nonnegative(),
  sourceId: z.string(),
  sourcePath: absolutePath,
  title: z.string().optional(),
  updatedAt: z.string(),
});

export const evaluationManifestSchema = z.object({
  datasets: z.array(z.object({
    agent: evaluationAgentSchema,
    diagnostics: z.record(z.string(), z.number().int().nonnegative()),
    elapsedMs: z.number().nonnegative(),
    eligibleSessions: z.number().int().nonnegative(),
    id: datasetId,
    revision: z.string().optional(),
    roots: z.array(absolutePath).min(1),
    sessions: z.array(manifestSessionSchema),
    sourceBytes: z.number().int().nonnegative(),
    sourceFilesVisited: z.number().int().nonnegative(),
    type: z.enum(["local", "swe-chat"]),
  })),
  generatedAt: z.string(),
  rules: z.object({
    applicationVersion: z.string(),
    indexRuleVersion: z.number().int().positive(),
    sensitiveContentRuleVersion: z.number().int().positive(),
  }),
  schemaVersion: z.literal(1),
});

export type EvaluationManifest = z.infer<typeof evaluationManifestSchema>;
export type EvaluationManifestDataset = EvaluationManifest["datasets"][number];
export type EvaluationManifestSession = EvaluationManifestDataset["sessions"][number];

export const goldSpanSchema = z.object({
  chunkIndex: z.number().int().nonnegative().optional(),
  endLine: z.number().int().positive(),
  endNativeEventId: z.string().optional(),
  passageId: z.string().min(1).optional(),
  sessionId: z.string(),
  startLine: z.number().int().positive(),
  startNativeEventId: z.string().optional(),
}).refine((span) => span.startLine <= span.endLine, "gold span startLine must not exceed endLine");

export const poolResultSchema = z.object({
  chunkIndex: z.number().int().nonnegative().optional(),
  contentTokenCount: z.number().int().nonnegative().optional(),
  endLocation: z.string().optional(),
  endNativeEventId: z.string().optional(),
  fragmentId: z.string().optional(),
  location: z.string(),
  modes: z.array(z.union([searchModeSchema, z.literal("seed")])).min(1),
  nativeEventId: z.string().optional(),
  passageId: z.string().min(1).optional(),
  sessionId: z.string(),
  sourcePath: absolutePath,
  text: z.string().min(1),
  variantIds: z.array(datasetId).min(1).optional(),
});

export const candidatePoolSchema = z.object({
  chunkAblation: z.object({
    manifestSha256: z.string().length(64),
    queriesSha256: z.string().length(64),
    variants: z.array(chunkVariantSchema).min(2),
  }).optional(),
  depth: z.number().int().positive(),
  generatedAt: z.string(),
  modes: z.array(searchModeSchema).min(1),
  queries: z.array(z.object({
    candidateId: z.string(),
    datasetId,
    query: z.string().min(1),
    results: z.array(poolResultSchema).min(1),
  })),
  schemaVersion: z.literal(1),
}).superRefine((pool, context) => {
  if (!pool.chunkAblation) return;
  const variants = new Set(pool.chunkAblation.variants.map((variant) => variant.id));
  pool.queries.forEach((query, queryIndex) => {
    const passageIds = new Set<string>();
    query.results.forEach((result, resultIndex) => {
      if (!result.passageId || !result.variantIds) {
        context.addIssue({ code: "custom", message: "ablation pool results require passageId and variantIds", path: ["queries", queryIndex, "results", resultIndex] });
        return;
      }
      if (passageIds.has(result.passageId)) {
        context.addIssue({ code: "custom", message: "duplicate passageId in ablation query pool", path: ["queries", queryIndex, "results", resultIndex] });
      }
      passageIds.add(result.passageId);
      result.variantIds.forEach((id) => {
        if (!variants.has(id)) context.addIssue({ code: "custom", message: `unknown chunk variant: ${id}`, path: ["queries", queryIndex, "results", resultIndex, "variantIds"] });
      });
    });
  });
});

export type CandidatePool = z.infer<typeof candidatePoolSchema>;

const humanReviewerSchema = z.object({
  name: z.string().min(1),
  type: z.literal("human"),
});

const llmReviewerSchema = z.object({
  model: z.string().min(1),
  promptVersion: z.number().int().positive(),
  provider: z.string().min(1),
  relevanceThreshold: z.number().int().min(1).max(3),
  reportedModels: z.array(z.string().min(1)).min(1),
  type: z.literal("llm"),
});

const reviewJudgmentSchema = z.object({
  chunkIndex: z.number().int().nonnegative().optional(),
  endLine: z.number().int().positive(),
  passageId: z.string().min(1).optional(),
  reason: z.string().min(1),
  relevance: z.number().int().min(0).max(3),
  sessionId: z.string(),
  startLine: z.number().int().positive(),
}).refine((judgment) => judgment.startLine <= judgment.endLine, "judgment startLine must not exceed endLine");

export const queryCandidateSchema = z.object({
  answer: z.string().min(1),
  candidateId: z.string(),
  datasetId,
  generatedBy: z.object({ model: z.string(), promptVersion: z.number().int().positive() }),
  goldSpans: z.array(goldSpanSchema).min(1),
  query: z.string().min(1),
  queryQuality: z.object({
    reason: z.string().min(1),
    reviewedAt: z.string(),
    reviewer: z.object({ model: z.string().min(1), promptVersion: z.number().int().positive() }),
    status: z.enum(["accepted", "rejected"]),
  }).optional(),
  queryType: z.enum(["concept", "decision", "error", "implementation"]),
  rationale: z.string().min(1),
  review: z.object({
    completeness: z.enum(["complete", "incomplete", "unchecked"]),
    judgments: z.array(reviewJudgmentSchema).optional(),
    notes: z.string().optional(),
    reviewedAt: z.string().optional(),
    reviewer: z.union([z.string().min(1), humanReviewerSchema, llmReviewerSchema]).optional(),
    scope: z.object({
      depth: z.number().int().positive(),
      modes: z.array(searchModeSchema).min(1),
      poolGeneratedAt: z.string(),
      poolSha256: z.string().length(64).optional(),
      type: z.literal("pooled"),
    }).optional(),
    status: z.enum(["accepted", "pending", "rejected"]),
  }),
  split: evaluationSplitSchema.optional(),
  splitAssignment: z.object({
    groupBy: z.enum(["project", "session"]),
    seed: z.string().min(1),
    testPercent: z.number().int().min(1).max(98),
    validationPercent: z.number().int().min(1).max(98),
  }).optional(),
});

export type QueryCandidate = z.infer<typeof queryCandidateSchema>;
