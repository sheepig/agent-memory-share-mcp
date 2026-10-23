import { describe, expect, it } from "vitest";

import { buildMemoryChunks } from "./memory-chunks.js";

describe("memory chunking", () => {
  it("keeps a short document intact across headings and blank lines", () => {
    const body = "# A\nfirst paragraph\n\n\n# B\nsecond paragraph";
    expect(buildMemoryChunks(body, "memory.md")).toEqual([
      { body, endLine: 6, startLine: 1, title: "memory.md" },
    ]);
    expect(buildMemoryChunks(" \n\n", "memory.md")).toEqual([]);
  });

  it("tracks actual lines of pieces split from one oversized block", () => {
    const chunks = buildMemoryChunks(["# A", "a".repeat(1300), "b".repeat(1300), "c".repeat(1300)].join("\n"), "memory.md");
    expect(chunks.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([[1, 2], [3, 3], [4, 4]]);
  });

  it("bounds punctuation at the size limit and preserves Unicode pairs", () => {
    const chunks = buildMemoryChunks(`${"a".repeat(1999)}. ${"😀".repeat(1100)}`, "memory.md");
    expect(chunks.every((chunk) => chunk.body.length <= 2000)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk.body))).toBe(true);
  });

  it("keeps headings and paragraphs together within the retrieval limit", () => {
    const chunks = buildMemoryChunks([
      "# Search",
      "first paragraph",
      "",
      "second paragraph",
      "",
      "## Storage",
      "x".repeat(2_100),
    ].join("\n"), "memory.md");

    expect(chunks[0]).toMatchObject({ endLine: 4, startLine: 1, title: "Search" });
    expect(chunks.some((chunk) => chunk.title === "Storage")).toBe(true);
    expect(chunks.every((chunk) => chunk.body.length <= 2_000)).toBe(true);
  });
});
