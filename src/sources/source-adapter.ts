import type { IndexDocument, SessionMessage, SourceReference } from "../domain/source.js";

export interface SourceDiagnostic {
  code: string;
  level: "error" | "warning";
  message: string;
  sourcePath?: string;
}

export interface SourceDiscoveryOptions {
  after?: string;
}

export interface SourceAdapter {
  readonly agent: string;
  readonly key: string;
  discover(options?: SourceDiscoveryOptions): AsyncIterable<SourceReference>;
  extract(source: SourceReference): AsyncIterable<IndexDocument>;
  takeDiagnostics?(): SourceDiagnostic[];
}

export interface SessionSourceAdapter extends SourceAdapter {
  readConversation(source: SourceReference): AsyncIterable<SessionMessage>;
}
