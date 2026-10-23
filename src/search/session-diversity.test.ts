import { describe, expect, it } from "vitest";

import {
  countDiverseSessionChunks,
  diversifySessionChunks,
  type SessionChunkIdentity,
} from "./session-diversity.js";

interface RankedChunk extends SessionChunkIdentity {
  id: string;
}

describe("session chunk result diversity", () => {
  it("returns the best chunk from each turn before repeated chunks from one turn", () => {
    const ranked: RankedChunk[] = [
      { id: "turn-1-best", location: "line:1", endLocation: "line:2", sourceId: "source", sourceType: "session" },
      { id: "turn-1-second", location: "line:1", endLocation: "line:2", sourceId: "source", sourceType: "session" },
      { id: "turn-2-best", location: "line:3", endLocation: "line:4", sourceId: "source", sourceType: "session" },
    ];

    expect(diversifySessionChunks(ranked, (value) => value, 3).map((value) => value.id)).toEqual([
      "turn-1-best",
      "turn-2-best",
      "turn-1-second",
    ]);
    expect(countDiverseSessionChunks(ranked, (value) => value)).toBe(2);
  });

  it("does not group Memory chunks or turns from different sources", () => {
    const ranked: RankedChunk[] = [
      { id: "memory-1", location: "heading", sourceId: "memory", sourceType: "memory" },
      { id: "memory-2", location: "heading", sourceId: "memory", sourceType: "memory" },
      { id: "session-a", location: "line:1", sourceId: "a", sourceType: "session" },
      { id: "session-b", location: "line:1", sourceId: "b", sourceType: "session" },
    ];

    expect(diversifySessionChunks(ranked, (value) => value, 4).map((value) => value.id)).toEqual(
      ranked.map((value) => value.id),
    );
  });
});
