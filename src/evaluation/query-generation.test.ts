import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { generateQueryCandidates } from "./query-generation.js";
import { scanEvaluation } from "./scanner.js";
import { evaluationConfigSchema } from "./types.js";

vi.mock("../search/embedding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../search/embedding.js")>();
  return {
    ...original,
    LocalContentTokenizer: class {
      async countContentTokens(text: string) {
        return [...text].length;
      }
    },
  };
});

const temporaryDirectories: string[] = [];
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sources/fixtures");

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("query generation", () => {
  it("reads the API key from a protected token file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-query-generation-"));
    temporaryDirectories.push(root);
    const sourceRoot = path.join(root, "sessions");
    const outputDirectory = path.join(root, "output");
    const tokenFile = path.join(root, "token");
    await fs.mkdir(sourceRoot);
    await fs.copyFile(path.join(fixtures, "codex-jsonl-v1.jsonl"), path.join(sourceRoot, "session.jsonl"));
    await fs.writeFile(tokenFile, "token-file-value\n", { mode: 0o600 });
    const config = evaluationConfigSchema.parse({
      datasets: [{ agent: "codex", id: "fixture", roots: [sourceRoot], type: "local" }],
      outputDirectory,
      queryGeneration: {
        apiKeyFile: tokenFile,
        baseUrl: "https://example.invalid",
        datasetIds: ["fixture"],
        maxQueries: 1,
        model: "fixture-model",
      },
      schemaVersion: 1,
    });
    const responses = [
      { answer: "Deterministic indexing.", query: "How is indexing kept deterministic?", queryType: "implementation", rationale: "The evidence explains indexing." },
      { accepted: true, reason: "Clear and answerable from the evidence." },
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-file-value");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { manifest } = await scanEvaluation(config);

    const result = await generateQueryCandidates(config, manifest);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ query: "How is indexing kept deterministic?", review: { status: "pending" } });
  });
});
