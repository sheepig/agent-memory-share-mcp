import fs from "node:fs/promises";
import path from "node:path";

import { evaluationConfigSchema, type EvaluationDataset } from "./types.js";

async function canonical(file: string): Promise<string> {
  try { return await fs.realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await canonical(path.dirname(file)), path.basename(file));
  }
}

export async function createChunkAblationConfig(options: {
  output: string;
  codexSessions?: string;
  claudeSessions?: string;
  sweChat?: boolean;
  revision?: string;
  queries: number;
}): Promise<{ configFile: string }> {
  const configFile = path.resolve(options.output);
  const directory = path.dirname(configFile);
  const datasets: EvaluationDataset[] = [];
  if (options.sweChat) {
    if (options.codexSessions || options.claudeSessions) throw new Error("Choose local Session directories or --swe-chat when initializing a config.");
    if (!options.revision) throw new Error("--swe-chat requires --revision with a full SWE-chat commit hash.");
    for (const agent of ["codex", "claude-code"] as const) {
      datasets.push({ agent, id: `swe-${agent}`, type: "swe-chat", repository: "SALT-NLP/SWE-chat", revision: options.revision, root: path.join(directory, "data", agent), tokenEnv: "HF_TOKEN", maxSourceFiles: 100 });
    }
  } else {
    if (options.revision) throw new Error("--revision is only used with --swe-chat.");
    if (options.codexSessions) datasets.push({ agent: "codex", id: "local-codex", type: "local", roots: [path.resolve(options.codexSessions)] });
    if (options.claudeSessions) datasets.push({ agent: "claude-code", id: "local-claude", type: "local", roots: [path.resolve(options.claudeSessions)] });
  }
  if (!datasets.length) throw new Error("Provide --codex-sessions, --claude-sessions, or --swe-chat.");
  const destination = await canonical(configFile);
  for (const dataset of datasets) {
    if (dataset.type !== "local") continue;
    for (const source of dataset.roots) {
      const relative = path.relative(await canonical(source), destination);
      if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
        throw new Error("The config file must be outside the read-only Session directories.");
      }
    }
  }
  const datasetIds = datasets.map((dataset) => dataset.id);
  evaluationConfigSchema.parse({
    schemaVersion: 1, datasets, outputDirectory: path.join(directory, "run"),
    queryGeneration: { transport: "codex", model: "gpt-5.6-luna", maxQueries: options.queries, datasetIds },
    qrelReview: { transport: "codex", model: "gpt-5.6-luna", datasetIds },
  });
  const relative = (file: string) => path.relative(directory, file) || ".";
  const portable = {
    schemaVersion: 1,
    outputDirectory: "./run",
    datasets: datasets.map((dataset) => dataset.type === "local"
      ? { ...dataset, roots: dataset.roots.map(relative) }
      : { ...dataset, root: relative(dataset.root) }),
    benchmark: { modes: ["keyword", "semantic", "hybrid"], querySplit: "dev", queryRuns: 3, queryWarmupRuns: 1, embeddingCacheDirectory: "./models" },
    chunkAblation: { variants: [
      { id: "baseline", maxContentTokens: 1024, overlapContentTokens: 64 },
      { id: "half-size", maxContentTokens: 512, overlapContentTokens: 64 },
      { id: "double-size", maxContentTokens: 2048, overlapContentTokens: 64 },
      { id: "no-overlap", maxContentTokens: 1024, overlapContentTokens: 0 },
    ] },
    codex: { command: "codex", reasoningEffort: "high" },
    queryGeneration: { transport: "codex", model: "gpt-5.6-luna", qualityReviewModel: "gpt-5.6-luna", maxQueries: options.queries, datasetIds },
    qrelReview: { transport: "codex", model: "gpt-5.6-luna", concurrency: 6, relevanceThreshold: 2, datasetIds },
  };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify(portable, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { configFile };
}
