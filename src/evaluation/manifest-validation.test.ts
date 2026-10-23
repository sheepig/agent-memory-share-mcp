import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { INDEX_RULE_VERSION } from "../application/source-service.js";
import { SENSITIVE_CONTENT_RULE_VERSION } from "../security/sensitive-content.js";
import { APP_VERSION } from "../version.js";
import { validateEvaluationManifest } from "./manifest-validation.js";
import { evaluationConfigSchema, type EvaluationManifest } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("evaluation manifest validation", () => {
  it("rejects changed source content, duplicate identities and stale index rules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-manifest-validation-"));
    temporaryDirectories.push(root);
    const sourcePath = path.join(root, "session.jsonl");
    const raw = "frozen source\n";
    await fs.writeFile(sourcePath, raw);
    const config = evaluationConfigSchema.parse({
      datasets: [{ agent: "codex", id: "fixture", roots: [root], type: "local" }],
      outputDirectory: path.join(root, "output"),
      schemaVersion: 1,
    });
    const manifest: EvaluationManifest = {
      datasets: [{
        agent: "codex",
        diagnostics: {},
        elapsedMs: 1,
        eligibleSessions: 1,
        id: "fixture",
        roots: [root],
        sessions: [{
          byteSize: Buffer.byteLength(raw),
          chunks: [{ characters: 10, chunkIndex: 0, contentTokenCount: 2, endLocation: "line:2", location: "line:1", ordinal: 0, turnCount: 1 }],
          contentFingerprint: createHash("sha256").update(raw).digest("hex"),
          relativePath: "session.jsonl",
          rootIndex: 0,
          sourceId: "session",
          sourcePath,
          updatedAt: "2026-10-21T00:00:00.000Z",
        }],
        sourceBytes: Buffer.byteLength(raw),
        sourceFilesVisited: 1,
        type: "local",
      }],
      generatedAt: "2026-10-21T00:00:00.000Z",
      rules: {
        applicationVersion: APP_VERSION,
        indexRuleVersion: INDEX_RULE_VERSION,
        sensitiveContentRuleVersion: SENSITIVE_CONTENT_RULE_VERSION,
      },
      schemaVersion: 1,
    };

    await expect(validateEvaluationManifest(config, manifest)).resolves.toBeUndefined();
    await expect(validateEvaluationManifest(config, {
      ...manifest,
      rules: { ...manifest.rules, indexRuleVersion: INDEX_RULE_VERSION - 1 },
    })).rejects.toThrow(/index rule version/u);

    const otherSourcePath = path.join(root, "duplicate-session.jsonl");
    const otherRaw = "different frozen source\n";
    await fs.writeFile(otherSourcePath, otherRaw);
    const dataset = manifest.datasets[0]!;
    await expect(validateEvaluationManifest(config, {
      ...manifest,
      datasets: [{ ...dataset, eligibleSessions: 2, sessions: [dataset.sessions[0]!, {
        ...dataset.sessions[0]!, sourcePath: otherSourcePath,
        contentFingerprint: createHash("sha256").update(otherRaw).digest("hex"),
      }] }],
    })).rejects.toThrow(/duplicate source ID/u);

    await fs.appendFile(sourcePath, "changed\n");
    await expect(validateEvaluationManifest(config, manifest)).rejects.toThrow(/content fingerprint/u);
  });
});
