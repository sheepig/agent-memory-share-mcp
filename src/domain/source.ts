export type SourceType = "memory" | "session";
export type SearchMode = "hybrid" | "keyword" | "semantic";

export interface SourceReference {
  agent: string;
  contentFingerprint: string;
  discoveryCursor?: string;
  metadata?: Record<string, string | string[]>;
  originalSessionId?: string;
  projectPath?: string;
  sourceId: string;
  sourcePath: string;
  sourceType: SourceType;
  title?: string;
  updatedAt: Date;
}

export interface IndexDocument {
  body: string;
  chunkIndex?: number;
  contentTokenCount?: number;
  endNativeEventId?: string;
  endLocation?: string;
  endedAt?: string;
  location: string;
  nativeEventId?: string;
  role?: "assistant" | "user";
  searchText?: string;
  source: SourceReference;
  startedAt?: string;
  title?: string;
  turnCount?: number;
}

export type SourceDisposition = "discovered" | "excluded" | "selected";

export type SourceProcessingState =
  | "discovered"
  | "failed"
  | "indexed"
  | "indexing"
  | "source_changed"
  | "source_unavailable";

export type EmbeddingState = "disabled" | "failed" | "indexed" | "indexing" | "pending";

export interface SessionCandidate {
  agent: string;
  candidateId: string;
  disposition: SourceDisposition;
  indexStatus: SourceProcessingState;
  projectPath?: string;
  sessionId: string;
  sourcePath: string;
  title?: string;
  updatedAt: string;
}

export interface SessionMessage {
  body: string;
  location: string;
  nativeEventId?: string;
  role: "assistant" | "user";
  timestamp?: string;
}

export interface SessionConversation {
  messages: SessionMessage[];
  session: SessionCandidate;
}

export interface FragmentSearchResult {
  agent: string;
  chunkIndex?: number;
  contentFingerprint: string;
  contentTokenCount?: number;
  endLocation?: string;
  endedAt?: string;
  excerpt: string;
  fragmentId: string;
  location: string;
  matchReason: string;
  originalSessionId?: string;
  projectPath?: string;
  role?: "assistant" | "user";
  score?: number;
  sessionId?: string;
  sourceId: string;
  sourcePath: string;
  sourceType: SourceType;
  startedAt?: string;
  title?: string;
  turnCount?: number;
  updatedAt: string;
}

export class SourceNotFoundError extends Error {
  constructor(message = "Unknown session candidate.") {
    super(message);
    this.name = "SourceNotFoundError";
  }
}

export class SourceUnavailableError extends Error {
  constructor(message = "The session source is no longer available.") {
    super(message);
    this.name = "SourceUnavailableError";
  }
}
