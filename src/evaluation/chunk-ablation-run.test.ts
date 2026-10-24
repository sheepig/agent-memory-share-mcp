import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";

import { runChunkAblationWorkflow } from "./chunk-ablation-run.js";
import { readQueryCandidates, writeQueryCandidates } from "./files.js";
import { evaluationConfigSchema } from "./types.js";

vi.mock("../search/embedding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../search/embedding.js")>();
  return { ...original, LocalContentTokenizer: class { async countContentTokens(text: string) { return [...text].length; } } };
});
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ablation-run-test-"));
  roots.push(root);
  const sources = path.join(root, "sources");
  await fs.mkdir(sources);
  const source = path.join(sources, "fixture.jsonl");
  await fs.copyFile(fileURLToPath(new URL("../sources/fixtures/codex-jsonl-v1.jsonl", import.meta.url)), source);
  let seed = "";
  for (let index = 0; !seed; index++) {
    if (createHash("sha256").update(`seed-${index}\0project:/fixture/codex`).digest().readUInt32BE(0) / 2 ** 32 >= 0.4) seed = `seed-${index}`;
  }
  vi.stubEnv("EVAL_FIXTURE_KEY", "fixture-credential");
  const config = evaluationConfigSchema.parse({
    schemaVersion: 1, datasets: [{ type: "local", id: "fixture", agent: "codex", roots: [sources] }],
    outputDirectory: path.join(root, "output"),
    benchmark: { modes: ["keyword"], querySplit: "dev", queryRuns: 1, queryWarmupRuns: 0 },
    chunkAblation: { variants: [{ id: "small", maxContentTokens: 40, overlapContentTokens: 0 }, { id: "large", maxContentTokens: 80, overlapContentTokens: 10 }] },
    queryGeneration: { baseUrl: "https://fixture.invalid", apiKeyEnv: "EVAL_FIXTURE_KEY", model: "generator", qualityReviewModel: "quality", datasetIds: ["fixture"], maxQueries: 1, split: { seed } },
    qrelReview: { baseUrl: "https://fixture.invalid", apiKeyEnv: "EVAL_FIXTURE_KEY", model: "judge", datasetIds: ["fixture"] },
  });
  let failReview = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.model === "judge" && failReview) return new Response("", { status: 402 });
    const data = request.model === "generator"
      ? { query: "deterministic indexing behavior", answer: "A synthetic indexing implementation.", queryType: "implementation", rationale: "Synthetic evidence." }
      : request.model === "quality" ? { accepted: true, reason: "Supported by synthetic evidence." }
        : { relevance: 3, reason: "Synthetic judgment." };
    return new Response(JSON.stringify({ model: request.model, choices: [{ message: { role: "assistant", content: JSON.stringify(data) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return { config, root, source, fetch, failReview: () => { failReview = true; }, restoreReview: () => { failReview = false; } };
}

it("requires explicit disclosure authorization before creating artifacts or making model calls", async () => {
  const { config, fetch } = await fixture();
  await expect(runChunkAblationWorkflow(config, { allowExternalModel: false })).rejects.toThrow(/allow-external-model/);
  expect(fetch).not.toHaveBeenCalled();
  await expect(fs.access(config.outputDirectory)).rejects.toThrow();
});

it("runs the production pipeline, resumes frozen stages and refuses changed settings or evidence", async () => {
  const { config, source, fetch } = await fixture();
  const original = await fs.readFile(source, "utf8");
  const first = await runChunkAblationWorkflow(config, { allowExternalModel: true });
  expect(first.queries).toBe(1);
  expect(first.judgments).toBeGreaterThan(1);
  expect(await fs.readFile(first.htmlReportFile, "utf8")).toContain("Chunk parameter ablation");
  const before = fetch.mock.calls.length;
  expect(before).toBe(first.judgments + 2);
  expect(await runChunkAblationWorkflow(config, { allowExternalModel: true })).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(before);
  expect(await fs.readFile(source, "utf8")).toBe(original);
  const changed = evaluationConfigSchema.parse({ ...config, queryGeneration: { ...config.queryGeneration, model: "different" } });
  await expect(runChunkAblationWorkflow(changed, { allowExternalModel: true })).rejects.toThrow(/changed/);
  const candidates = await readQueryCandidates(path.join(config.outputDirectory, "query-candidates.jsonl"));
  await writeQueryCandidates(path.join(config.outputDirectory, "query-candidates.jsonl"), candidates.map((candidate) => ({ ...candidate, query: "tampered" })));
  await expect(runChunkAblationWorkflow(config, { allowExternalModel: true })).rejects.toThrow(/Frozen queries/);
  await writeQueryCandidates(path.join(config.outputDirectory, "query-candidates.jsonl"), candidates);
  await fs.appendFile(source, "\n");
  await expect(runChunkAblationWorkflow(config, { allowExternalModel: true })).rejects.toThrow(/fingerprint changed/);
  expect(fetch).toHaveBeenCalledTimes(before);
});

it("resumes a failed review using the same frozen pool", async () => {
  const setup = await fixture();
  setup.failReview();
  await expect(runChunkAblationWorkflow(setup.config, { allowExternalModel: true })).rejects.toThrow();
  const statePath = path.join(setup.config.outputDirectory, "ablation-run.json");
  const failed = JSON.parse(await fs.readFile(statePath, "utf8"));
  expect(failed).toMatchObject({ status: "failed", stage: "review" });
  setup.restoreReview();
  await runChunkAblationWorkflow(setup.config, { allowExternalModel: true });
  const complete = JSON.parse(await fs.readFile(statePath, "utf8"));
  expect(complete.pool).toEqual(failed.pool);
  expect(complete.status).toBe("complete");
  expect(setup.fetch.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).model === "generator")).toHaveLength(1);
});

it("does not silently substitute dev queries for an empty held-out split", async () => {
  const { config } = await fixture();
  config.benchmark.querySplit = "test";
  await expect(runChunkAblationWorkflow(config, { allowExternalModel: true })).rejects.toThrow(/No accepted queries.*test split/);
});

it("rejects overlapping source/output directories, including symlink aliases", async () => {
  const { config, root } = await fixture();
  const dataset = config.datasets[0]!;
  if (dataset.type !== "local") throw new Error("fixture");
  config.outputDirectory = path.join(dataset.roots[0]!, "derived");
  await expect(runChunkAblationWorkflow(config, { allowExternalModel: true })).rejects.toThrow(/separate/);
  if (process.platform !== "win32") {
    const alias = path.join(root, "alias");
    await fs.symlink(dataset.roots[0]!, alias);
    config.outputDirectory = path.join(alias, "derived");
    await expect(runChunkAblationWorkflow(config, { allowExternalModel: true })).rejects.toThrow(/separate/);
  }
});
