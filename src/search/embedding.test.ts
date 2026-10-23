import { describe, expect, it } from "vitest";

import { cosineSimilarity, decodeEmbedding, encodeEmbedding } from "./embedding.js";

describe("embedding utilities", () => {
  it("round-trips float vectors without changing similarity", () => {
    const vector = Float32Array.from([0.25, -0.5, 0.75]);
    const decoded = decodeEmbedding(encodeEmbedding(vector));

    expect(Array.from(decoded)).toEqual(Array.from(vector));
    expect(cosineSimilarity(vector, decoded)).toBeCloseTo(1);
    expect(cosineSimilarity(vector, Float32Array.from([-0.25, 0.5, -0.75]))).toBeCloseTo(-1);
  });
});
