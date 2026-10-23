import { describe, expect, it } from "vitest";

import { buildSearchExcerpt } from "./excerpt.js";

describe("buildSearchExcerpt", () => {
  it("centers long excerpts around a late exact match", () => {
    const body = `${"a".repeat(700)}needle${"b".repeat(300)}`;
    const excerpt = buildSearchExcerpt(body, "needle");
    expect(excerpt).toContain("needle");
    expect(excerpt.length).toBeLessThanOrEqual(502);
    expect(excerpt.startsWith("…")).toBe(true);
  });

  it("falls back to the first query term and preserves short bodies", () => {
    expect(buildSearchExcerpt("short body", "missing")).toBe("short body");
    expect(buildSearchExcerpt(`${"x".repeat(600)} 中文命中 ${"y".repeat(100)}`, "中文命中 其他")).toContain("中文命中");
  });
});
