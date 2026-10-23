import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { scanEvaluation } from "./scanner.js";
import { createSourceService } from "../application/source-service.js";
import { CodexSessionAdapter } from "../sources/desktop-sources.js";
import { openDatabase } from "../storage/database.js";
import { evaluationConfigSchema } from "./types.js";

const temporaryDirectories: string[] = [];
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sources/fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("evaluation scanner", () => {
  it("keeps the last discovered duplicate identity and caps distinct sessions while counting every visited file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-eval-duplicate-"));
    temporaryDirectories.push(root);
    const sourceRoot = path.join(root, "sources");
    await fs.mkdir(sourceRoot);
    const fixture = await fs.readFile(path.join(fixtures, "codex-jsonl-v1.jsonl"), "utf8");
    const records = [
      ["first.jsonl", fixture.replace("Synthetic final answer", "First duplicate final answer")],
      ["last.jsonl", fixture.replace("Synthetic final answer", "Last duplicate final answer has different content")],
      ["distinct.jsonl", fixture.replace("fixture-codex", "distinct-codex")],
      ["beyond-limit.jsonl", fixture.replace("fixture-codex", "beyond-limit")],
    ] as const;
    for (let index = 0; index < records.length; index += 1) {
      const [name, body] = records[index]!;
      const file = path.join(sourceRoot, name);
      await fs.writeFile(file, body);
      const timestamp = new Date(Date.UTC(2026, 0, 4 - index));
      await fs.utimes(file, timestamp, timestamp);
    }
    const config = evaluationConfigSchema.parse({
      datasets: [{ agent: "codex", id: "duplicates", maxEligibleSessions: 2, roots: [sourceRoot], type: "local" }],
      outputDirectory: path.join(root, "output"), schemaVersion: 1,
    });
    const counter = { async countContentTokens(text: string) { return [...text].length; } };
    const { manifest } = await scanEvaluation(config, undefined, counter);
    const dataset = manifest.datasets[0]!;
    expect(dataset.eligibleSessions).toBe(2);
    expect(dataset.sessions.map((session) => session.sourceId)).toEqual(["fixture-codex", "distinct-codex"]);
    expect(dataset.sessions.find((session) => session.sourceId === "fixture-codex")?.sourcePath)
      .toBe(path.join(sourceRoot, "last.jsonl"));
    expect(dataset.diagnostics).toMatchObject({ duplicate_source_id: 1 });
    expect(dataset.sourceFilesVisited).toBe(3);
    expect(dataset.sourceBytes).toBe(records.slice(0, 3).reduce((sum, [, body]) => sum + Buffer.byteLength(body), 0));

    const database = openDatabase(path.join(root, "database"));
    try {
      const service = createSourceService(database, { adapters: {
        memories: [], sessions: [new CodexSessionAdapter("", counter, [sourceRoot])],
      } });
      await service.scanSources();
      const duplicate = (await service.listSessions({ limit: 10, offset: 0 })).sessions
        .find((session) => session.sessionId === "fixture-codex")!;
      expect(duplicate.sourcePath).toBe(dataset.sessions[0]!.sourcePath);
      expect(database.prepare("SELECT content_fingerprint FROM sources WHERE id = ?").get(duplicate.candidateId))
        .toEqual({ content_fingerprint: dataset.sessions[0]!.contentFingerprint });
    } finally {
      database.close();
    }
  });

  it("uses explicit roots and emits only eligible Codex and Claude Code sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-eval-scan-"));
    temporaryDirectories.push(root);
    const codexRoot = path.join(root, "codex");
    const claudeRoot = path.join(root, "claude");
    const outputDirectory = path.join(root, "output");
    await Promise.all([fs.mkdir(codexRoot), fs.mkdir(claudeRoot)]);
    await fs.copyFile(path.join(fixtures, "codex-jsonl-v1.jsonl"), path.join(codexRoot, "accepted.jsonl"));
    await fs.copyFile(path.join(fixtures, "claude-jsonl-v1.jsonl"), path.join(claudeRoot, "accepted.jsonl"));
    await fs.writeFile(path.join(codexRoot, "rejected.jsonl"), `${JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "short" }] },
    })}\n`);
    const config = evaluationConfigSchema.parse({
      datasets: [
        { agent: "codex", id: "local-codex", roots: [codexRoot], type: "local" },
        { agent: "claude-code", id: "local-claude", roots: [claudeRoot], type: "local" },
      ],
      outputDirectory,
      schemaVersion: 1,
    });

    const { manifest, outputFile } = await scanEvaluation(config, undefined, {
      async countContentTokens(text) {
        return [...text].length;
      },
    });

    expect(outputFile).toBe(path.join(outputDirectory, "manifest.json"));
    expect(manifest.datasets.map((dataset) => [dataset.id, dataset.eligibleSessions])).toEqual([
      ["local-codex", 1],
      ["local-claude", 1],
    ]);
    expect(manifest.datasets[0]?.diagnostics).toMatchObject({ session_below_minimum_content: 1 });
    expect(manifest.datasets[0]?.sourceBytes).toBeGreaterThan((await fs.stat(path.join(codexRoot, "accepted.jsonl"))).size);
    expect(manifest.datasets[0]?.sessions[0]?.chunks[0]).toMatchObject({
      endNativeEventId: "codex-assistant-event",
      nativeEventId: "codex-user-event",
    });
    expect(manifest.datasets[1]?.sessions[0]?.chunks[0]).toMatchObject({
      endNativeEventId: "claude-assistant-event",
      nativeEventId: "claude-user-event",
    });
  });
});
