import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as transformers from "@huggingface/transformers";
import { AutoTokenizer, env, FeatureExtractionPipeline, Tensor, type PreTrainedModel } from "@huggingface/transformers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildSessionIndexDocuments } from "../sources/session-turns.js";
import { LocalContentTokenizer, LocalEmbeddingProvider } from "./embedding.js";

vi.mock("@huggingface/transformers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@huggingface/transformers")>();
  return { ...original, pipeline: vi.fn() };
});

// Supply a prepopulated HF cache to run with the pinned tokenizer, without network or model weights.
const cacheDirectory = process.env.EMBEDDING_TEST_CACHE_DIRECTORY;

describe.skipIf(!cacheDirectory)("pinned Jina tokenizer integration", () => {
  let localRoot: string;
  const previous = { allowRemoteModels: env.allowRemoteModels, localModelPath: env.localModelPath };

  beforeAll(async () => {
    localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jina-tokenizer-"));
    await fs.mkdir(path.join(localRoot, "jinaai"));
    // Transformers.js 4.3 metadata discovery omits the revision and cache options.
    // Expose the pinned files locally so its preliminary existence check stays offline.
    await fs.symlink(path.join(cacheDirectory!, "jinaai/jina-embeddings-v2-base-zh/c1ff9086a89a1123d7b5eff58055a665db4fb4b9"), path.join(localRoot, "jinaai/jina-embeddings-v2-base-zh"));
    env.localModelPath = localRoot;
    env.allowRemoteModels = false;
  });

  afterAll(async () => {
    Object.assign(env, previous);
    await fs.rm(localRoot, { recursive: true, force: true });
  });

  it("bounds multilingual chunks and verifies the overlap using real source tokens", async () => {
    const tokenizer = await AutoTokenizer.from_pretrained("jinaai/jina-embeddings-v2-base-zh", {
      cache_dir: cacheDirectory!,
      local_files_only: true,
      revision: "c1ff9086a89a1123d7b5eff58055a665db4fb4b9",
    });
    const counter = new LocalContentTokenizer(cacheDirectory!);
    const user = "检查中文、English、代码与 emoji 的切分边界。";
    const answer = Array.from({ length: 90 }, (_, index) => `段落 ${index} 包含检索结果。\n\n\`\`\`ts\nconst value${index} = compute(input);\n\`\`\`\n😀 Mixed language sentence ${index}. `).join("");
    const documents = await buildSessionIndexDocuments([
      { body: user, location: "line:1", role: "user" },
      { body: answer, location: "line:2", role: "assistant" },
    ], { agent: "codex", contentFingerprint: "fixture", sourceId: "fixture", sourcePath: "/synthetic/session.jsonl", sourceType: "session", updatedAt: new Date(0) }, counter);

    expect(documents.length).toBeGreaterThan(1);
    const source = `${user}\n\n${answer}`;
    let previousEnd = 0;
    for (const [index, document] of documents.entries()) {
      const text = document.searchText!;
      const start = source.indexOf(text, Math.max(0, previousEnd - text.length));
      expect(start).toBeGreaterThanOrEqual(0);
      const sourceTokens = (tokenizer(text, { add_special_tokens: false, truncation: false }).input_ids as Tensor).dims.at(-1)!;
      const fullTokens = (tokenizer(document.body, { truncation: false }).input_ids as Tensor).dims.at(-1)!;
      expect(document.contentTokenCount).toBe(sourceTokens);
      expect(sourceTokens).toBeLessThanOrEqual(1024);
      expect(fullTokens).toBeLessThanOrEqual(8192);
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      if (index > 0) {
        expect(start).toBeLessThan(previousEnd);
        const overlap = source.slice(start, previousEnd);
        expect(await counter.countContentTokens(overlap)).toBe(64);
      }
      previousEnd = start + text.length;
    }
    expect(previousEnd).toBe(source.length);
  }, 30_000);

  it("passes all tokens beyond 512 through the real pipeline and rejects oversized wrapped inputs", async () => {
    const tokenizer = await AutoTokenizer.from_pretrained("jinaai/jina-embeddings-v2-base-zh", {
      cache_dir: cacheDirectory!, local_files_only: true, revision: "c1ff9086a89a1123d7b5eff58055a665db4fb4b9",
    });
    const input = `User:\nquestion\n\nAssistant:\n${"中文检索 mixed text. ".repeat(200)}`;
    const expectedTokens = (tokenizer(input, { truncation: false }).input_ids as Tensor).dims.at(-1)!;
    expect(expectedTokens).toBeGreaterThan(512);
    expect(expectedTokens).toBeLessThan(8192);
    const model = vi.fn(async (inputs: Record<string, Tensor>) => {
      const [batch, length] = inputs.input_ids!.dims;
      expect(length).toBe(expectedTokens);
      return { last_hidden_state: new Tensor("float32", new Float32Array(batch! * length! * 2).fill(1), [batch!, length!, 2]) };
    });
    const extractor = new FeatureExtractionPipeline({ task: "feature-extraction", tokenizer, model: model as unknown as PreTrainedModel });
    const loader = vi.mocked(transformers.pipeline).mockResolvedValue(extractor);
    try {
      const provider = new LocalEmbeddingProvider(cacheDirectory!);
      const vectors = await provider.embedPassages([input]);
      expect(model).toHaveBeenCalledOnce();
      expect(vectors).toHaveLength(1);
      const tooLong = `Title\nUser:\n${"中文检索 mixed text. ".repeat(2000)}`;
      await expect(provider.embedPassages([tooLong])).rejects.toThrow(/model capacity is 8192/u);
      expect(model).toHaveBeenCalledOnce();
    } finally {
      loader.mockReset();
    }
  }, 30_000);
});
