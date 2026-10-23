import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  disposed: vi.fn(),
  inputs: [] as Array<{ query: string; text: string; options: Record<string, unknown> }>,
  tokens: 12,
}));

vi.mock("@huggingface/transformers", () => ({
  AutoTokenizer: { from_pretrained: async () => (query: string, options: Record<string, unknown>) => {
    state.inputs.push({ query, text: options.text_pair as string, options });
    return { input_ids: { dims: [1, state.tokens] } };
  } },
  AutoModelForSequenceClassification: { from_pretrained: async () => Object.assign(
    async () => ({ logits: { data: Float32Array.from([-2]), dims: [1, 1] } }),
    { dispose: state.disposed },
  ) },
}));

import { LocalRerankerProvider } from "./reranker.js";

describe("local cross-encoder reranker", () => {
  it("scores query/document pairs without truncation and releases the model", async () => {
    const provider = new LocalRerankerProvider("/tmp/synthetic-rerank-cache");
    state.inputs = [];
    const scores = await provider.score("why exclude?", ["a complete passage", "second passage"]);
    expect(scores).toEqual([-2, -2]);
    expect(state.inputs.map(({ query, text }) => [query, text])).toEqual([
      ["why exclude?", "a complete passage"], ["why exclude?", "second passage"],
    ]);
    expect(state.inputs.every(({ options }) => options.truncation === false)).toBe(true);
    expect(provider.modelId).toContain("6f5ff65298512715a1e669753bc754d2bc8f367b");
    await provider.dispose();
    expect(state.disposed).toHaveBeenCalledOnce();
  });

  it("rejects an over-capacity pair instead of silently dropping evidence", async () => {
    state.tokens = 8_193;
    const provider = new LocalRerankerProvider("/tmp/synthetic-rerank-cache");
    await expect(provider.score("query", ["passage"])).rejects.toThrow("8192");
    state.tokens = 12;
    await provider.dispose();
  });
});
