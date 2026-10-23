import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocalContentTokenizer, LocalEmbeddingProvider } from "./embedding.js";

const mocks = vi.hoisted(() => {
  const tokenizer = Object.assign(vi.fn((text: string, options: { add_special_tokens?: boolean }) => ({
    input_ids: { dims: [1, [...text].length + (options.add_special_tokens === false ? 0 : 2)] },
  })), { config: { model_max_length: 512 } });
  const extractor = Object.assign(vi.fn(async () => ({ tolist: () => [[1, 0]] })), {
    tokenizer: { config: { model_max_length: 512 } },
  });
  return { extractor, pipeline: vi.fn(async () => extractor), tokenizer };
});

vi.mock("@huggingface/transformers", () => ({
  AutoTokenizer: { from_pretrained: async () => mocks.tokenizer },
  pipeline: mocks.pipeline,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extractor.tokenizer.config.model_max_length = 512;
});

describe("embedding input boundaries", () => {
  it("counts source content without special tokens", async () => {
    expect(await new LocalContentTokenizer("unused").countContentTokens("abc")).toBe(3);
  });

  it("aligns pipeline tokenization with the pinned model capacity", async () => {
    await new LocalEmbeddingProvider("unused").embedPassages(["a".repeat(1024)]);
    expect(mocks.extractor.tokenizer.config.model_max_length).toBe(8192);
    expect(mocks.extractor).toHaveBeenCalledOnce();
  });

  it("accepts a complete input exactly at capacity", async () => {
    await expect(new LocalEmbeddingProvider("unused").embedQuery("a".repeat(8190))).resolves.toEqual(Float32Array.from([1, 0]));
  });

  it.each(["query", "passages"])("rejects oversized %s including special tokens before loading the model", async (kind) => {
    const provider = new LocalEmbeddingProvider("unused");
    const input = "a".repeat(8191);
    await expect(kind === "query" ? provider.embedQuery(input) : provider.embedPassages(["short", input])).rejects.toThrow(/8193.*8192/u);
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.extractor).not.toHaveBeenCalled();
  });
});
