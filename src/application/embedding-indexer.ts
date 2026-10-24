import { createHash } from "node:crypto";

import { encodeEmbedding, type EmbeddingProvider } from "../search/embedding.js";
import type { AppDatabase } from "../storage/database.js";

export function embeddingInput(document: { body: string; title?: string }): string {
  return `${document.title ? `${document.title}\n` : ""}${document.body}`;
}

export class EmbeddingIndexer {
  constructor(private readonly database: AppDatabase, readonly provider?: EmbeddingProvider) {}

  private missing(sourceId: string) {
    return this.database.prepare(`SELECT f.id, f.title, f.body FROM fragments f
      LEFT JOIN fragment_embeddings e ON e.fragment_id = f.id
      WHERE f.source_id = ? AND (e.model_id IS NOT ? OR f.embedding_input_hash IS NULL OR e.input_hash IS NOT f.embedding_input_hash)
      ORDER BY f.ordinal LIMIT 16`).all(sourceId, this.provider!.modelId) as Array<{ id: string; title: string | null; body: string }>;
  }

  async batch(sourceId: string): Promise<boolean> {
    const provider = this.provider;
    if (!provider) return false;
    const row = this.database.prepare(`SELECT disposition, processing_state, content_fingerprint, indexed_fingerprint
      FROM sources WHERE id = ?`).get(sourceId) as {
      disposition: string; processing_state: string; content_fingerprint: string; indexed_fingerprint: string | null;
    } | undefined;
    if (!row || row.disposition !== "selected" || row.processing_state !== "indexed" || row.content_fingerprint !== row.indexed_fingerprint) return false;
    const batch = this.missing(sourceId).map((item) => {
      const input = embeddingInput({ body: item.body, title: item.title ?? undefined });
      return { ...item, input, hash: createHash("sha256").update(input).digest("hex") };
    });
    if (batch.length === 0) {
      this.database.prepare("UPDATE sources SET embedding_state = 'indexed', embedding_model_id = ?, embedding_error = NULL, retry_after = NULL WHERE id = ?")
        .run(provider.modelId, sourceId);
      return false;
    }
    this.database.prepare("UPDATE sources SET embedding_state = 'indexing', embedding_model_id = ?, embedding_error = NULL WHERE id = ?")
      .run(provider.modelId, sourceId);
    try {
      const embeddings = await provider.embedPassages(batch.map((item) => item.input));
      if (embeddings.length !== batch.length || embeddings.some((value) => value.length === 0 || ![...value].every(Number.isFinite))) {
        throw new Error("The embedding model returned invalid fragment vectors.");
      }
      const current = this.database.prepare("SELECT disposition, processing_state, content_fingerprint FROM sources WHERE id = ?").get(sourceId) as typeof row;
      if (current.disposition !== "selected" || current.processing_state !== "indexed" || current.content_fingerprint !== row.content_fingerprint) return false;
      this.database.transaction(() => {
        const insert = this.database.prepare(`INSERT INTO fragment_embeddings(fragment_id, model_id, dimensions, embedding, input_hash)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(fragment_id) DO UPDATE SET model_id = excluded.model_id,
          dimensions = excluded.dimensions, embedding = excluded.embedding, input_hash = excluded.input_hash`);
        const update = this.database.prepare("UPDATE fragments SET embedding_input_hash = ? WHERE id = ? AND source_id = ?");
        batch.forEach((item, index) => {
          if (update.run(item.hash, item.id, sourceId).changes === 0) return;
          const value = embeddings[index]!;
          insert.run(item.id, provider.modelId, value.length, encodeEmbedding(value), item.hash);
        });
      })();
      const more = this.missing(sourceId).length > 0;
      this.database.prepare("UPDATE sources SET embedding_state = ?, retry_after = NULL WHERE id = ?").run(more ? "pending" : "indexed", sourceId);
      return more;
    } catch (error) {
      const current = this.database.prepare("SELECT disposition, content_fingerprint FROM sources WHERE id = ?").get(sourceId) as typeof row | undefined;
      if (!current || current.disposition !== "selected" || current.content_fingerprint !== row.content_fingerprint) return false;
      const message = error instanceof Error ? error.message : String(error);
      this.database.transaction(() => {
        this.database.prepare("UPDATE sources SET embedding_state = 'failed', embedding_error = ?, retry_after = ? WHERE id = ?")
          .run(message, new Date(Date.now() + 60_000).toISOString(), sourceId);
        this.database.prepare(`INSERT INTO scan_diagnostics(source_id, level, code, message, created_at)
          VALUES (?, 'warning', 'embedding_failed', ?, ?)`).run(sourceId, message, new Date().toISOString());
      })();
      return false;
    }
  }

  async complete(sourceId: string): Promise<void> {
    while (await this.batch(sourceId)) { await new Promise<void>((resolve) => setImmediate(resolve)); }
  }
}
