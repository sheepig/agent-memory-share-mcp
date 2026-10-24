import type { SourceReference } from "../domain/source.js";
import type { AppDatabase } from "../storage/database.js";

export function discoveryCache(database: AppDatabase, adapterKey: string, ruleVersion: string, scanStartedAt: string) {
  const pending: Array<() => void> = [];
  return {
    get(sourcePath: string, size: number, modified: number): SourceReference | null | undefined {
      const row = database.prepare(`SELECT reference_json FROM source_discovery_cache
        WHERE adapter_key = ? AND source_path = ? AND byte_size = ? AND modified_ms = ?
          AND rule_version = ? AND checked_at > ?`).get(adapterKey, sourcePath, size, modified, ruleVersion, Date.now() - 86_400_000) as { reference_json: string | null } | undefined;
      if (!row) return undefined;
      pending.push(() => { database.prepare(`UPDATE scan_diagnostics SET last_seen_at = ?,
        occurrence_count = occurrence_count + CASE WHEN last_seen_at < ? THEN 1 ELSE 0 END
        WHERE adapter_key = ? AND source_path = ? AND resolved_at IS NULL`).run(new Date().toISOString(), scanStartedAt, adapterKey, sourcePath); });
      if (row.reference_json === null) return null;
      const reference = JSON.parse(row.reference_json) as SourceReference;
      return { ...reference, updatedAt: new Date(reference.updatedAt) };
    },
    set(sourcePath: string, size: number, modified: number, reference: SourceReference | null): void {
      pending.push(() => {
        database.prepare("UPDATE scan_diagnostics SET resolved_at = ? WHERE adapter_key = ? AND source_path = ? AND resolved_at IS NULL")
          .run(new Date().toISOString(), adapterKey, sourcePath);
        database.prepare(`INSERT INTO source_discovery_cache(adapter_key, source_path, byte_size, modified_ms, rule_version, checked_at, reference_json)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(adapter_key, source_path) DO UPDATE SET byte_size = excluded.byte_size,
          modified_ms = excluded.modified_ms, rule_version = excluded.rule_version, checked_at = excluded.checked_at,
          reference_json = excluded.reference_json`).run(adapterKey, sourcePath, size, modified, ruleVersion, Date.now(), reference ? JSON.stringify(reference) : null);
      });
    },
    flush(): void { for (const operation of pending.splice(0)) operation(); },
  };
}
