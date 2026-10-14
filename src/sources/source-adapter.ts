import type { IndexDocument, SourceReference } from "../domain/source.js";

export interface SourceAdapter {
  readonly agent: string;
  discover(): AsyncIterable<SourceReference>;
  extract(source: SourceReference): AsyncIterable<IndexDocument>;
}
