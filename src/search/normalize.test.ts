import { describe, expect, it } from "vitest";

import { normalizeSearchText } from "./normalize.js";

describe("normalizeSearchText", () => {
  it("normalizes width, case, and whitespace", () => {
    expect(normalizeSearchText("  Ｃｏｄｅｘ\n  MEMORY  ")).toBe("codex memory");
  });

  it("preserves searchable Chinese text", () => {
    expect(normalizeSearchText("  项目　记忆  ")).toBe("项目 记忆");
  });
});
