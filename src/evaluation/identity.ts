import { createHash } from "node:crypto";

import type { QueryCandidate } from "./types.js";

export function evaluationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function passageIdFor(
  datasetId: string,
  sessionId: string,
  location: string,
  endLocation: string,
  body: string,
): string {
  return evaluationHash([datasetId, sessionId, location, endLocation, body]);
}

export function querySetHash(candidates: readonly QueryCandidate[]): string {
  return evaluationHash(candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    datasetId: candidate.datasetId,
    query: candidate.query,
    split: candidate.split ?? "test",
  })));
}
