const MAX_MEMORY_CHUNK_CHARACTERS = 2_000;

export interface MemoryChunk {
  body: string;
  endLine: number;
  startLine: number;
  title: string;
}

interface Block {
  endLine: number;
  startLine: number;
  text: string;
  title: string;
}

function splitOversizedBlock(block: Block): Block[] {
  const values: Block[] = [];
  let start = 0;
  while (start < block.text.length) {
    const remaining = block.text.slice(start);
    const window = remaining.slice(0, MAX_MEMORY_CHUNK_CHARACTERS + 1);
    const sentenceBoundaries = [...window.matchAll(/[。！？.!?](?:\s|$)/gu)].map((match) => match.index);
    const candidates = [window.lastIndexOf("\n"), ...sentenceBoundaries];
    const boundary = Math.max(...candidates.filter((value) => value >= Math.floor(MAX_MEMORY_CHUNK_CHARACTERS * 0.6) && value < MAX_MEMORY_CHUNK_CHARACTERS));
    let end = Math.min(remaining.length, boundary > 0 && remaining.length > MAX_MEMORY_CHUNK_CHARACTERS ? boundary + 1 : MAX_MEMORY_CHUNK_CHARACTERS);
    if (end < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[end - 1]!)) end -= 1;
    const piece = remaining.slice(0, end);
    const text = piece.trim();
    if (text) {
      const first = start + piece.indexOf(text);
      const last = first + text.length;
      values.push({
        ...block,
        endLine: block.startLine + (block.text.slice(0, last).match(/\n/gu)?.length ?? 0),
        startLine: block.startLine + (block.text.slice(0, first).match(/\n/gu)?.length ?? 0),
        text,
      });
    }
    start += end;
  }
  return values;
}

function markdownBlocks(text: string, fallbackTitle: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let title = fallbackTitle;
  let buffer: string[] = [];
  let startLine = 1;

  const flush = (endLine: number) => {
    const value = buffer.join("\n").trim();
    if (value) blocks.push({ endLine, startLine, text: value, title });
    buffer = [];
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = /^#{1,6}\s+(.+)/u.exec(line);
    if (heading) {
      flush(lineNumber - 1);
      title = heading[1]!.trim().slice(0, 160) || fallbackTitle;
      startLine = lineNumber;
      buffer.push(line);
      return;
    }
    if (!line.trim()) {
      flush(lineNumber - 1);
      startLine = lineNumber + 1;
      return;
    }
    if (buffer.length === 0) startLine = lineNumber;
    buffer.push(line);
  });
  flush(lines.length);
  return blocks.flatMap(splitOversizedBlock);
}

export function buildMemoryChunks(text: string, fallbackTitle: string): MemoryChunk[] {
  const body = text.trim();
  if (!body) return [];
  if (body.length <= MAX_MEMORY_CHUNK_CHARACTERS) {
    const start = text.indexOf(body);
    const startLine = 1 + (text.slice(0, start).match(/\n/gu)?.length ?? 0);
    return [{ body, endLine: startLine + (body.match(/\n/gu)?.length ?? 0), startLine, title: fallbackTitle }];
  }
  const chunks: MemoryChunk[] = [];
  let current: MemoryChunk | undefined;
  for (const block of markdownBlocks(text, fallbackTitle)) {
    const separator = current ? "\n\n" : "";
    if (current && (current.title !== block.title || current.body.length + separator.length + block.text.length > MAX_MEMORY_CHUNK_CHARACTERS)) {
      chunks.push(current);
      current = undefined;
    }
    if (!current) {
      current = { body: block.text, endLine: block.endLine, startLine: block.startLine, title: block.title };
    } else {
      current.body += `${separator}${block.text}`;
      current.endLine = block.endLine;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
