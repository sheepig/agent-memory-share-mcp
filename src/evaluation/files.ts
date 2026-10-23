import fs from "node:fs/promises";
import path from "node:path";

import {
  candidatePoolSchema,
  evaluationConfigSchema,
  evaluationManifestSchema,
  queryCandidateSchema,
  type CandidatePool,
  type EvaluationConfig,
  type EvaluationManifest,
  type QueryCandidate,
} from "./types.js";

export async function readCandidatePool(file: string): Promise<CandidatePool> {
  return candidatePoolSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

export async function readEvaluationConfig(file: string): Promise<EvaluationConfig> {
  return evaluationConfigSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

export async function readEvaluationManifest(file: string): Promise<EvaluationManifest> {
  return evaluationManifestSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function readQueryCandidates(file: string): Promise<QueryCandidate[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw.split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return queryCandidateSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid query candidate at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export async function writeQueryCandidates(file: string, candidates: readonly QueryCandidate[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, candidates.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n", { mode: 0o600 });
  await fs.rename(temporary, file);
}
