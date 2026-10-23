export interface MemoryMetadata {
  body: string;
  bodyStartLine?: number;
  metadata?: Record<string, string | string[]>;
  originalSessionId?: string;
  projectPath?: string;
  title?: string;
  updatedAt?: Date;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stringList(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  return trimmed.slice(1, -1).split(",").map(scalar).filter(Boolean);
}

export function parseMemoryMetadata(raw: string): MemoryMetadata {
  const lines = raw.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return { body: raw };
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { body: raw };
  const end = closing + 1;
  const metadata: Record<string, string | string[]> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const rawValue = match[2]!;
    metadata[key] = stringList(rawValue) ?? scalar(rawValue);
  }
  const read = (...keys: string[]) => {
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string" && value) return value;
    }
    return undefined;
  };
  const date = read("updatedAt", "updated_at", "date");
  const parsedDate = date ? new Date(date) : undefined;
  return {
    body: lines.slice(end + 1).join("\n"),
    bodyStartLine: end + 2,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    originalSessionId: read("sessionId", "session_id", "sourceSessionId", "source_session_id"),
    projectPath: read("projectPath", "project_path"),
    title: read("title"),
    updatedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : undefined,
  };
}
