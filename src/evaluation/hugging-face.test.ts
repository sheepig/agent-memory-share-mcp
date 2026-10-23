import { describe, expect, it } from "vitest";

import { selectSweChatRows } from "./hugging-face.js";

describe("SWE-chat materialization", () => {
  it("selects only canonical Agent rows with raw transcript paths in deterministic order", () => {
    const rows = [
      { agent: "Codex CLI", session_id: "old-label", transcript_path: "transcripts/old-label.jsonl" },
      { agent: "Codex", session_id: "second", transcript_path: "transcripts/second.jsonl", turn_count: 100 },
      { agent: "Claude Code", session_id: "claude", transcript_path: "transcripts/claude.jsonl" },
      { agent: "Codex", session_id: "compact", transcript_path: "transcripts_compact/compact.jsonl" },
      { agent: "Codex", session_id: "middle", transcript_path: "transcripts/middle.jsonl", turn_count: 50 },
      { agent: "Codex", session_id: "first", transcript_path: "transcripts/first.jsonl", turn_count: 1 },
    ];

    expect(selectSweChatRows(rows, "codex", 2).map((row) => row.session_id)).toEqual(["first", "second"]);
    expect(selectSweChatRows(rows, "claude-code").map((row) => row.session_id)).toEqual(["claude"]);
  });
});
