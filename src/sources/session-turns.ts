import type { IndexDocument, SessionMessage, SourceReference } from "../domain/source.js";

export const SESSION_CHUNK_MAX_CONTENT_TOKENS = 1_024;
export const SESSION_CHUNK_OVERLAP_CONTENT_TOKENS = 64;

export interface SessionChunkOptions {
  maxContentTokens: number;
  overlapContentTokens: number;
}

export interface ContentTokenCounter {
  countContentTokens(text: string): Promise<number>;
}

interface TurnSection {
  end: number;
  role: "assistant" | "user";
  start: number;
}

interface CompleteTurn {
  content: string;
  endNativeEventId?: string;
  endLocation: string;
  endedAt?: string;
  location: string;
  nativeEventId?: string;
  sections: TurnSection[];
  startedAt?: string;
}

interface ContentWindow {
  end: number;
  start: number;
  tokens: number;
}

function completeTurns(messages: readonly SessionMessage[]): CompleteTurn[] {
  const turns: CompleteTurn[] = [];
  let users: SessionMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      users.push(message);
      continue;
    }
    if (users.length === 0) {
      continue;
    }
    const userBody = users.map((user) => user.body).join("\n");
    const content = `${userBody}\n\n${message.body}`;
    const assistantStart = userBody.length + 2;
    turns.push({
      content,
      endNativeEventId: message.nativeEventId,
      endLocation: message.location,
      endedAt: message.timestamp,
      location: users[0]!.location,
      nativeEventId: users[0]!.nativeEventId,
      sections: [
        { end: userBody.length, role: "user", start: 0 },
        { end: content.length, role: "assistant", start: assistantStart },
      ],
      startedAt: users[0]!.timestamp,
    });
    users = [];
  }

  return turns;
}

function avoidSplitSurrogate(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const left = text.charCodeAt(index - 1);
  const right = text.charCodeAt(index);
  return left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF
    ? index - 1
    : index;
}

function nextCodePointEnd(text: string, start: number): number {
  const codePoint = text.codePointAt(start);
  return Math.min(text.length, start + (codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1));
}

async function largestPrefixEnd(
  text: string,
  start: number,
  maximumTokens: number,
  tokenCounter: ContentTokenCounter,
): Promise<number> {
  let best = start;
  let low = start + 1;
  let high = text.length;
  while (low <= high) {
    const rawMiddle = Math.floor((low + high) / 2);
    const middle = avoidSplitSurrogate(text, rawMiddle);
    const tokens = await tokenCounter.countContentTokens(text.slice(start, middle));
    if (tokens <= maximumTokens) {
      best = middle;
      low = rawMiddle + 1;
    } else {
      high = rawMiddle - 1;
    }
  }
  if (best > start) return best;
  const end = nextCodePointEnd(text, start);
  if (await tokenCounter.countContentTokens(text.slice(start, end)) > maximumTokens) {
    throw new Error("A source character exceeds the Session chunk token limit.");
  }
  return end;
}

function lastBoundary(text: string, start: number, end: number, separator: string): number | undefined {
  const index = text.lastIndexOf(separator, end - separator.length);
  return index >= start ? index + separator.length : undefined;
}

function preferredBoundary(text: string, start: number, hardEnd: number): number {
  const minimum = start + Math.floor((hardEnd - start) * 0.6);
  const before = text.slice(start, hardEnd);
  const fenceCount = before.match(/```/gu)?.length ?? 0;
  if (fenceCount % 2 === 1) {
    const fenceStart = text.lastIndexOf("```", hardEnd - 1);
    if (fenceStart >= minimum) return fenceStart;
  }
  const headingStart = text.lastIndexOf("\n#", hardEnd - 1);
  if (headingStart >= minimum) return headingStart + 1;
  const boundaries = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " "];
  for (const separator of boundaries) {
    const boundary = lastBoundary(text, start, hardEnd, separator);
    if (boundary !== undefined && boundary >= minimum) return boundary;
  }
  return hardEnd;
}

async function overlapStart(
  text: string,
  windowStart: number,
  windowEnd: number,
  tokenCounter: ContentTokenCounter,
  overlapContentTokens: number,
): Promise<number> {
  let best = windowEnd;
  let low = windowStart + 1;
  let high = windowEnd;
  while (low <= high) {
    const rawMiddle = Math.floor((low + high) / 2);
    const middle = avoidSplitSurrogate(text, rawMiddle);
    const tokens = await tokenCounter.countContentTokens(text.slice(middle, windowEnd));
    if (tokens <= overlapContentTokens) {
      best = middle;
      high = rawMiddle - 1;
    } else {
      low = rawMiddle + 1;
    }
  }
  return best;
}

async function contentWindows(
  content: string,
  tokenCounter: ContentTokenCounter,
  options: SessionChunkOptions,
): Promise<ContentWindow[]> {
  const total = await tokenCounter.countContentTokens(content);
  if (total <= options.maxContentTokens) {
    return [{ end: content.length, start: 0, tokens: total }];
  }
  const windows: ContentWindow[] = [];
  let start = 0;
  while (start < content.length) {
    const remainingTokens = await tokenCounter.countContentTokens(content.slice(start));
    if (remainingTokens <= options.maxContentTokens) {
      windows.push({ end: content.length, start, tokens: remainingTokens });
      break;
    }
    const hardEnd = await largestPrefixEnd(content, start, options.maxContentTokens, tokenCounter);
    let end = preferredBoundary(content, start, hardEnd);
    let tokens = await tokenCounter.countContentTokens(content.slice(start, end));
    // A shorter substring can tokenize differently at the chosen structural boundary.
    if (tokens > options.maxContentTokens) {
      end = hardEnd;
      tokens = await tokenCounter.countContentTokens(content.slice(start, end));
    }
    windows.push({ end, start, tokens });
    const nextStart = await overlapStart(content, start, end, tokenCounter, options.overlapContentTokens);
    start = nextStart > start ? nextStart : end;
  }
  return windows;
}

function renderBody(turn: CompleteTurn, window: ContentWindow): string {
  return turn.sections.flatMap((section) => {
    const start = Math.max(section.start, window.start);
    const end = Math.min(section.end, window.end);
    if (start >= end) return [];
    const label = section.role === "user" ? "User" : "Assistant";
    return [`${label}:\n${turn.content.slice(start, end)}`];
  }).join("\n\n");
}

export async function buildSessionIndexDocuments(
  messages: readonly SessionMessage[],
  source: SourceReference,
  tokenCounter: ContentTokenCounter,
  options: SessionChunkOptions = {
    maxContentTokens: SESSION_CHUNK_MAX_CONTENT_TOKENS,
    overlapContentTokens: SESSION_CHUNK_OVERLAP_CONTENT_TOKENS,
  },
): Promise<IndexDocument[]> {
  if (!Number.isSafeInteger(options.maxContentTokens) || options.maxContentTokens <= 0
    || !Number.isSafeInteger(options.overlapContentTokens) || options.overlapContentTokens < 0
    || options.overlapContentTokens >= options.maxContentTokens) {
    throw new Error("Session chunk size must be positive and overlap must be smaller than chunk size.");
  }
  const documents: IndexDocument[] = [];
  for (const turn of completeTurns(messages)) {
    const windows = await contentWindows(turn.content, tokenCounter, options);
    windows.forEach((window, chunkIndex) => {
      documents.push({
        body: renderBody(turn, window),
        chunkIndex,
        contentTokenCount: window.tokens,
        ...(turn.endNativeEventId ? { endNativeEventId: turn.endNativeEventId } : {}),
        endLocation: turn.endLocation,
        ...(turn.endedAt ? { endedAt: turn.endedAt } : {}),
        location: turn.location,
        ...(turn.nativeEventId ? { nativeEventId: turn.nativeEventId } : {}),
        searchText: turn.content.slice(window.start, window.end),
        source,
        ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
        turnCount: 1,
      });
    });
  }
  return documents;
}
