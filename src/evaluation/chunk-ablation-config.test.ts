import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { createChunkAblationConfig } from "./chunk-ablation-config.js";
import { readEvaluationConfig } from "./files.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "portable-ablation-config-"));
  roots.push(root);
  return root;
}

it("resolves portable local configuration relative to its file, independently of the process cwd", async () => {
  const root = await temporary();
  const output = path.join(root, "experiment", "config.json");
  const codexSessions = path.join(root, "sources", "codex");
  const claudeSessions = path.join(root, "sources", "claude");
  await createChunkAblationConfig({ output, codexSessions, claudeSessions, queries: 64 });
  await expect(createChunkAblationConfig({ output: path.join(codexSessions, "config.json"), codexSessions, queries: 1 })).rejects.toThrow(/read-only/);
  const raw = JSON.parse(await fs.readFile(output, "utf8"));
  expect(raw.datasets[0].roots).toEqual([path.join("..", "sources", "codex")]);
  const config = await readEvaluationConfig(output);
  expect(config.datasets.map((dataset) => dataset.type === "local" && dataset.roots[0])).toEqual([codexSessions, claudeSessions]);
  expect(config.outputDirectory).toBe(path.join(root, "experiment", "run"));
  expect(config.benchmark.embeddingCacheDirectory).toBe(path.join(root, "experiment", "models"));
  expect(config.codex).toMatchObject({ command: "codex", reasoningEffort: "high" });
  expect(config.queryGeneration).toMatchObject({ transport: "codex", maxQueries: 64 });
  expect(config.qrelReview?.datasetIds).toEqual(["local-codex", "local-claude"]);
  await expect(createChunkAblationConfig({ output, codexSessions, queries: 1 })).rejects.toMatchObject({ code: "EEXIST" });
});

it("keeps configuration writes outside Session directories reached through symbolic links", async () => {
  const root = await temporary();
  const sessions = path.join(root, "sessions");
  const alias = path.join(root, "alias");
  await fs.mkdir(sessions);
  await fs.symlink(sessions, alias, "junction");
  for (const [outputRoot, sourceRoot] of [[alias, sessions], [sessions, alias]]) {
    await expect(createChunkAblationConfig({
      output: path.join(outputRoot!, "nested", "config.json"), codexSessions: sourceRoot!, queries: 1,
    })).rejects.toThrow(/read-only/);
  }
  expect(await fs.readdir(sessions)).toEqual([]);
});

it("initializes both SWE agents at an immutable revision", async () => {
  const output = path.join(await temporary(), "config.json");
  await expect(createChunkAblationConfig({ output, sweChat: true, queries: 1 })).rejects.toThrow(/revision/);
  await expect(createChunkAblationConfig({ output, sweChat: true, revision: "main", queries: 1 })).rejects.toThrow(/commit/);
  await expect(createChunkAblationConfig({ output, sweChat: true, revision: "a".repeat(40), codexSessions: "/tmp", queries: 1 })).rejects.toThrow(/Choose/);
  await createChunkAblationConfig({ output, sweChat: true, revision: "a".repeat(40), queries: 10 });
  const config = await readEvaluationConfig(output);
  expect(config.datasets.map((dataset) => [dataset.agent, dataset.type])).toEqual([["codex", "swe-chat"], ["claude-code", "swe-chat"]]);
  expect(config.datasets.every((dataset) => dataset.type === "swe-chat" && dataset.revision === "a".repeat(40))).toBe(true);
});

it("validates invalid JSON values and transport requirements without bypassing the schema", async () => {
  const output = path.join(await temporary(), "config.json");
  for (const invalid of [null, { datasets: [null] }, { datasets: [] }]) {
    await fs.writeFile(output, JSON.stringify(invalid));
    await expect(readEvaluationConfig(output)).rejects.toMatchObject({ name: "ZodError" });
  }
  await expect(createChunkAblationConfig({ output, queries: 1 })).rejects.toThrow(/Provide/);
});
