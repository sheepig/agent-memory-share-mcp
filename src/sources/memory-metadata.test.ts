import { describe, expect, it } from "vitest";

import { parseMemoryMetadata } from "./memory-metadata.js";

describe("parseMemoryMetadata", () => {
  it("reads only explicit supported frontmatter without inferring from the body", () => {
    const result = parseMemoryMetadata([
      "---",
      'title: "Stable fact"',
      "project_path: /workspace/demo",
      "session_id: session-42",
      "date: 2026-10-17T01:02:03.000Z",
      "tags: [memory, durable]",
      "---",
      "# Body",
      "Mentions /another/project and session-99.",
    ].join("\n"));
    expect(result).toMatchObject({
      body: "# Body\nMentions /another/project and session-99.",
      originalSessionId: "session-42",
      projectPath: "/workspace/demo",
      title: "Stable fact",
    });
    expect(result.updatedAt?.toISOString()).toBe("2026-10-17T01:02:03.000Z");
    expect(result.metadata?.tags).toEqual(["memory", "durable"]);
  });

  it("leaves missing metadata absent and malformed frontmatter in the body", () => {
    expect(parseMemoryMetadata("# Session session-99\n/project/demo")).toEqual({ body: "# Session session-99\n/project/demo" });
    expect(parseMemoryMetadata("---\ntitle: no close")).toEqual({ body: "---\ntitle: no close" });
  });
});
