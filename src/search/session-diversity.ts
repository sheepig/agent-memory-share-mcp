export interface SessionChunkIdentity {
  endLocation?: string | null;
  location: string;
  sourceId: string;
  sourceType: "memory" | "session";
}

function turnKey(chunk: SessionChunkIdentity): string {
  return `${chunk.sourceId}\0${chunk.location}\0${chunk.endLocation ?? chunk.location}`;
}

export function countDiverseSessionChunks<T>(
  values: readonly T[],
  identity: (value: T) => SessionChunkIdentity,
): number {
  let count = 0;
  const seen = new Set<string>();
  for (const value of values) {
    const chunk = identity(value);
    if (chunk.sourceType === "memory" || !seen.has(turnKey(chunk))) count += 1;
    if (chunk.sourceType === "session") seen.add(turnKey(chunk));
  }
  return count;
}

export function diversifySessionChunks<T>(
  values: readonly T[],
  identity: (value: T) => SessionChunkIdentity,
  limit: number,
): T[] {
  const firstPerTurn: T[] = [];
  const repeated: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const chunk = identity(value);
    if (chunk.sourceType !== "session") {
      firstPerTurn.push(value);
      continue;
    }
    const key = turnKey(chunk);
    if (seen.has(key)) repeated.push(value);
    else {
      seen.add(key);
      firstPerTurn.push(value);
    }
  }
  return [...firstPerTurn, ...repeated].slice(0, limit);
}
