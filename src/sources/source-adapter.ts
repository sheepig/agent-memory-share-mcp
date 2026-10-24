import type { IndexDocument, SessionMessage, SourceReference } from "../domain/source.js";

export interface SourceDiagnostic {
  code: string;
  level: "error" | "warning";
  message: string;
  sourcePath?: string;
}

export interface SourceDiscoveryOptions {
  after?: string;
  cache?: {
    get(path: string, size: number, mtimeMs: number): SourceReference | null | undefined;
    set(path: string, size: number, mtimeMs: number, source: SourceReference | null): void;
  };
}

export interface SourceDiscoveryStep {
  cursor?: string;
  source?: SourceReference;
  complete?: boolean;
}

export interface SourceAdapter {
  readonly agent: string;
  readonly key: string;
  discover(options?: SourceDiscoveryOptions): AsyncIterable<SourceReference>;
  discoverSteps?(options?: SourceDiscoveryOptions): AsyncIterable<SourceDiscoveryStep>;
  refresh?(source: SourceReference): Promise<SourceReference | null>;
  isAvailable?(source: SourceReference): Promise<boolean>;
  extract(source: SourceReference): AsyncIterable<IndexDocument>;
  takeDiagnostics?(): SourceDiagnostic[];
}

export interface SessionSourceAdapter extends SourceAdapter {
  readConversation(source: SourceReference): AsyncIterable<SessionMessage>;
}
