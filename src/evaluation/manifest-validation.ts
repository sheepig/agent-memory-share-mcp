import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { INDEX_RULE_VERSION } from "../application/source-service.js";
import { SENSITIVE_CONTENT_RULE_VERSION } from "../security/sensitive-content.js";
import type { EvaluationConfig, EvaluationManifest } from "./types.js";

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function validateEvaluationManifest(
  config: EvaluationConfig,
  manifest: EvaluationManifest,
): Promise<void> {
  if (manifest.rules.indexRuleVersion !== INDEX_RULE_VERSION) {
    throw new Error(
      `Evaluation manifest index rule version ${manifest.rules.indexRuleVersion} does not match current version ${INDEX_RULE_VERSION}. Run eval scan again.`,
    );
  }
  if (manifest.rules.sensitiveContentRuleVersion !== SENSITIVE_CONTENT_RULE_VERSION) {
    throw new Error(
      `Evaluation manifest sensitive-content rule version ${manifest.rules.sensitiveContentRuleVersion} does not match current version ${SENSITIVE_CONTENT_RULE_VERSION}. Run eval scan again.`,
    );
  }

  const configured = new Map(config.datasets.map((dataset) => [dataset.id, dataset]));
  if (configured.size !== manifest.datasets.length) {
    throw new Error("Evaluation manifest datasets do not match the configured datasets. Run eval scan again.");
  }
  for (const dataset of manifest.datasets) {
    const expected = configured.get(dataset.id);
    if (!expected
      || expected.agent !== dataset.agent
      || expected.type !== dataset.type
      || !sameStrings(expected.type === "local" ? expected.roots : [expected.root], dataset.roots)
      || (expected.type === "swe-chat" && expected.revision !== dataset.revision)) {
      throw new Error(`Evaluation manifest dataset ${dataset.id} does not match the current configuration. Run eval scan again.`);
    }
    const sourceIds = new Set<string>();
    for (const session of dataset.sessions) {
      if (sourceIds.has(session.sourceId)) {
        throw new Error(`Evaluation manifest dataset ${dataset.id} has duplicate source ID ${session.sourceId}. Run eval scan again.`);
      }
      sourceIds.add(session.sourceId);
    }
    for (const session of dataset.sessions) {
      let raw: Buffer;
      try {
        raw = await fs.readFile(session.sourcePath);
      } catch (error) {
        throw new Error(`Evaluation source is unavailable for ${dataset.id}/${session.sourceId}.`, { cause: error });
      }
      const fingerprint = createHash("sha256").update(raw).digest("hex");
      if (fingerprint !== session.contentFingerprint) {
        throw new Error(`Evaluation source content fingerprint changed for ${dataset.id}/${session.sourceId}. Run eval scan again.`);
      }
    }
  }
}
