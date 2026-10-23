import { describe, expect, it } from "vitest";

import type { SessionMessage, SourceReference } from "../domain/source.js";
import {
  buildSessionIndexDocuments,
  SESSION_CHUNK_MAX_CONTENT_TOKENS,
  SESSION_CHUNK_OVERLAP_CONTENT_TOKENS,
  type ContentTokenCounter,
} from "./session-turns.js";

const source: SourceReference = {
  agent: "codex",
  contentFingerprint: "fingerprint",
  sourceId: "session",
  sourcePath: "/sessions/session.jsonl",
  sourceType: "session",
  title: "Session title",
  updatedAt: new Date("2026-10-16T10:00:00.000Z"),
};

const codePointTokens: ContentTokenCounter = {
  async countContentTokens(text) {
    return [...text].length;
  },
};

function message(
  role: SessionMessage["role"],
  body: string,
  location: string,
  timestamp?: string,
): SessionMessage {
  return { body, location, role, ...(timestamp ? { timestamp } : {}) };
}

describe("session turn indexing", () => {
  it.each([". ", "! ", "? ", "\n\n"])("keeps %j separators inside the hard token boundary", async (separator) => {
    const documents = await buildSessionIndexDocuments([
      message("user", "q", "line:1"),
      message("assistant", `${"a".repeat(96)}${separator}${"b".repeat(120)}`, "line:2"),
    ], source, codePointTokens, { maxContentTokens: 100, overlapContentTokens: 0 });

    expect(documents.every((document) => document.contentTokenCount! <= 100)).toBe(true);
    expect(documents.map((document) => document.searchText).join("")).toBe(`q\n\n${"a".repeat(96)}${separator}${"b".repeat(120)}`);
  });

  it("rechecks token count after choosing a structural boundary", async () => {
    const documents = await buildSessionIndexDocuments([
      message("user", "q", "line:1"),
      message("assistant", `${"a".repeat(70)}\n\n${"b".repeat(140)}`, "line:2"),
    ], source, {
      async countContentTokens(text) {
        return [...text].length + (text.endsWith("\n\n") ? 40 : 0);
      },
    }, { maxContentTokens: 100, overlapContentTokens: 0 });

    expect(documents.every((document) => document.contentTokenCount! <= 100)).toBe(true);
  });

  it("keeps each complete turn as its own retrieval chunk without padding from adjacent turns", async () => {
    const documents = await buildSessionIndexDocuments([
      message("user", "First question", "line:1", "2026-10-16T00:00:00.000Z"),
      message("user", "Follow-up detail", "line:2", "2026-10-16T00:01:00.000Z"),
      message("assistant", "First answer", "line:3", "2026-10-16T00:02:00.000Z"),
      message("user", "Second question", "line:4", "2026-10-16T00:30:00.000Z"),
      message("assistant", "Second answer", "line:5", "2026-10-16T00:31:00.000Z"),
    ], source, codePointTokens);

    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({
      chunkIndex: 0,
      contentTokenCount: 45,
      endLocation: "line:3",
      endedAt: "2026-10-16T00:02:00.000Z",
      location: "line:1",
      startedAt: "2026-10-16T00:00:00.000Z",
      turnCount: 1,
    });
    expect(documents[0]?.body).toBe("User:\nFirst question\nFollow-up detail\n\nAssistant:\nFirst answer");
    expect(documents[0]?.searchText).toBe("First question\nFollow-up detail\n\nFirst answer");
    expect(documents[0]?.title).toBeUndefined();
    expect(documents[1]).toMatchObject({ chunkIndex: 0, endLocation: "line:5", location: "line:4", turnCount: 1 });
  });

  it("does not merge separate turns based on timestamps", async () => {
    const documents = await buildSessionIndexDocuments([
      message("user", "First question", "line:1", "2026-10-16T00:00:00.000Z"),
      message("assistant", "First answer", "line:2", "2026-10-16T00:01:00.000Z"),
      message("user", "Immediate follow-up", "line:3", "2026-10-16T00:01:01.000Z"),
      message("assistant", "Separate answer", "line:4", "2026-10-16T00:02:00.000Z"),
      message("user", "No timestamp", "line:5"),
      message("assistant", "No timestamp answer", "line:6"),
    ], source, codePointTokens);

    expect(documents.map((document) => ({
      endLocation: document.endLocation,
      location: document.location,
      turnCount: document.turnCount,
    }))).toEqual([
      { endLocation: "line:2", location: "line:1", turnCount: 1 },
      { endLocation: "line:4", location: "line:3", turnCount: 1 },
      { endLocation: "line:6", location: "line:5", turnCount: 1 },
    ]);
  });

  it("omits incomplete users and orphan assistant replies", async () => {
    const documents = await buildSessionIndexDocuments([
      message("assistant", "Orphan answer", "line:1", "2026-10-16T00:00:00.000Z"),
      message("user", "Complete question", "line:2", "2026-10-16T00:01:00.000Z"),
      message("assistant", "Complete answer", "line:3", "2026-10-16T00:02:00.000Z"),
      message("user", "Unanswered question", "line:4", "2026-10-16T00:03:00.000Z"),
    ], source, codePointTokens);

    expect(documents).toHaveLength(1);
    expect(documents[0]?.body).toContain("Complete question");
    expect(documents[0]?.body).not.toContain("Orphan answer");
    expect(documents[0]?.body).not.toContain("Unanswered question");
  });

  it("splits only an oversized turn and overlaps its source content by 64 tokens", async () => {
    const longAnswer = "a".repeat(1_400);
    const documents = await buildSessionIndexDocuments([
      message("user", "Large question", "line:1", "2026-10-16T00:00:00.000Z"),
      message("assistant", longAnswer, "line:2", "2026-10-16T00:01:00.000Z"),
      message("user", "Next question", "line:3", "2026-10-16T00:02:00.000Z"),
      message("assistant", "Next answer", "line:4", "2026-10-16T00:03:00.000Z"),
    ], source, codePointTokens);

    expect(documents).toHaveLength(3);
    const first = documents[0]!.searchText!;
    const second = documents[1]!.searchText!;
    expect(documents.slice(0, 2).every((document) => (
      document.endLocation === "line:2"
      && document.location === "line:1"
      && document.turnCount === 1
      && document.contentTokenCount! <= SESSION_CHUNK_MAX_CONTENT_TOKENS
    ))).toBe(true);
    expect(first.slice(-SESSION_CHUNK_OVERLAP_CONTENT_TOKENS)).toBe(
      second.slice(0, SESSION_CHUNK_OVERLAP_CONTENT_TOKENS),
    );
    expect(documents.slice(0, 2).map((document) => document.chunkIndex)).toEqual([0, 1]);
    expect(documents.at(-1)).toMatchObject({ chunkIndex: 0, endLocation: "line:4", location: "line:3", turnCount: 1 });
  });

  it("counts only source content and excludes generated role labels", async () => {
    const documents = await buildSessionIndexDocuments([
      message("user", "12345", "line:1"),
      message("assistant", "67890", "line:2"),
    ], source, codePointTokens);

    expect(documents[0]?.contentTokenCount).toBe(12);
    expect(documents[0]?.searchText).toBe("12345\n\n67890");
    expect(documents[0]?.body.length).toBeGreaterThan(documents[0]!.contentTokenCount!);
  });

  it("never splits a Unicode surrogate pair at a hard boundary", async () => {
    const documents = await buildSessionIndexDocuments([
      message("user", "emoji boundary", "line:1"),
      message("assistant", "😀".repeat(1_400), "line:2"),
    ], source, codePointTokens);

    expect(documents.length).toBeGreaterThan(1);
    for (const document of documents) {
      expect(document.contentTokenCount).toBeLessThanOrEqual(SESSION_CHUNK_MAX_CONTENT_TOKENS);
      expect(document.searchText).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  });

  it("keeps a Markdown heading marker with the following chunk", async () => {
    const documents = await buildSessionIndexDocuments([
      message("user", "Heading boundary", "line:1"),
      message("assistant", `${"a".repeat(700)}\n# Deployment\n${"b".repeat(700)}`, "line:2"),
    ], source, codePointTokens);

    expect(documents).toHaveLength(2);
    expect(documents[0]?.searchText).not.toContain("# Deployment");
    expect(documents[0]?.searchText).not.toMatch(/#$/u);
    expect(documents[1]?.searchText).toContain("# Deployment");
  });

  it("uses supplied chunk size and overlap without changing the production defaults", async () => {
    const messages = [
      message("user", "Question", "line:1"),
      message("assistant", "x".repeat(290), "line:2"),
    ];
    const small = await buildSessionIndexDocuments(messages, source, codePointTokens, {
      maxContentTokens: 100,
      overlapContentTokens: 20,
    });
    const noOverlap = await buildSessionIndexDocuments(messages, source, codePointTokens, {
      maxContentTokens: 100,
      overlapContentTokens: 0,
    });
    const production = await buildSessionIndexDocuments(messages, source, codePointTokens);

    expect(production).toHaveLength(1);
    expect(small.length).toBeGreaterThan(noOverlap.length);
    expect(small.every((document) => document.contentTokenCount! <= 100)).toBe(true);
    expect(small[0]!.searchText!.slice(-20)).toBe(small[1]!.searchText!.slice(0, 20));
    expect(noOverlap.map((document) => document.searchText).join("")).toBe(`Question\n\n${"x".repeat(290)}`);
  });

  it("rejects overlap that can prevent chunking from advancing", async () => {
    await expect(buildSessionIndexDocuments([
      message("user", "Question", "line:1"),
      message("assistant", "x".repeat(240), "line:2"),
    ], source, codePointTokens, { maxContentTokens: 100, overlapContentTokens: 100 })).rejects.toThrow(/overlap/u);
  });
});
