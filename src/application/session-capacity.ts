import type { AppDatabase } from "../storage/database.js";

const agents = ["codex", "claude-code", "cursor", "opencode"] as const;

export class SessionCapacity {
  constructor(private readonly database: AppDatabase, private readonly limits: Readonly<Record<string, number>>) {}

  limit(agent: string): number { return this.limits[agent] ?? 5_000; }

  private used(agent: string): number {
    return (this.database.prepare("SELECT fragments FROM session_fragment_usage WHERE agent = ?").get(agent) as { fragments: number } | undefined)?.fragments ?? 0;
  }

  private oldest(agent: string, except = "") {
    return this.database.prepare(`SELECT s.id, s.source_updated_at,
      (SELECT count(*) FROM fragments f WHERE f.source_id = s.id) AS n FROM sources s
      WHERE s.source_type = 'session' AND s.agent = ? AND s.disposition = 'selected' AND s.id <> ?
        AND EXISTS (SELECT 1 FROM fragments f WHERE f.source_id = s.id)
      ORDER BY s.source_updated_at ASC, s.id DESC LIMIT 1`).get(agent, except) as { id: string; n: number; source_updated_at: string };
  }

  status() {
    return Object.fromEntries(agents.map((agent) => {
      const fragments = this.used(agent);
      const counts = this.database.prepare(`
        SELECT sum(disposition = 'selected') AS selectedSessions,
               sum(disposition = 'discovered' AND admission_reason IS NOT NULL) AS waitingSessions
        FROM sources WHERE source_type = 'session' AND agent = ? AND processing_state <> 'source_unavailable'
      `).get(agent) as { selectedSessions: number | null; waitingSessions: number | null };
      return [agent, { fragmentLimit: this.limit(agent), fragments, reservedFragments: 0,
        selectedSessions: counts.selectedSessions ?? 0, waitingSessions: counts.waitingSessions ?? 0 }];
    }));
  }

  removeFragments(id: string): void {
    if (!this.database.prepare("SELECT 1 FROM fragments WHERE source_id = ? LIMIT 1").get(id)) return;
    this.database.prepare("DELETE FROM fragment_search WHERE rowid IN (SELECT search_rowid FROM fragments WHERE source_id = ? AND search_rowid IS NOT NULL)").run(id);
    if (this.database.prepare("SELECT 1 FROM fragments WHERE source_id = ? AND search_rowid IS NULL LIMIT 1").get(id)) {
      this.database.prepare("DELETE FROM fragment_search WHERE fragment_id IN (SELECT id FROM fragments WHERE source_id = ? AND search_rowid IS NULL)").run(id);
    }
    this.database.prepare("DELETE FROM fragments WHERE source_id = ?").run(id);
  }

  private wait(id: string, reason: "capacity" | "oversized"): void {
    this.removeFragments(id);
    this.database.prepare(`UPDATE sources SET disposition = 'discovered', processing_state = 'discovered',
      indexed_fingerprint = NULL, admission_reason = ?, embedding_state = 'disabled' WHERE id = ?`).run(reason, id);
  }

  defer(id: string, reason: "capacity" | "oversized"): void {
    const row = this.database.prepare("SELECT disposition, processing_state, admission_reason FROM sources WHERE id = ?").get(id) as {
      disposition: string; processing_state: string; admission_reason: string | null;
    };
    if (row.disposition === "discovered" && row.processing_state === "discovered" && row.admission_reason === reason) return;
    this.database.transaction(() => this.wait(id, reason))();
  }

  canFit(id: string, count: number): boolean {
    const row = this.database.prepare("SELECT agent, source_updated_at FROM sources WHERE id = ?").get(id) as { agent: string; source_updated_at: string };
    if (count > this.limit(row.agent)) return false;
    const own = (this.database.prepare("SELECT count(*) AS n FROM fragments WHERE source_id = ?").get(id) as { n: number }).n;
    if (this.used(row.agent) - own + count <= this.limit(row.agent)) return true;
    const oldest = this.oldest(row.agent, id);
    if (oldest && (oldest.source_updated_at > row.source_updated_at || (oldest.source_updated_at === row.source_updated_at && oldest.id < id))) return false;
    const { used } = this.database.prepare(`
      SELECT count(*) AS used FROM fragments f JOIN sources s ON s.id = f.source_id
      WHERE s.source_type = 'session' AND s.agent = ? AND s.id <> ?
        AND (s.source_updated_at > ? OR (s.source_updated_at = ? AND s.id < ?))
    `).get(row.agent, id, row.source_updated_at, row.source_updated_at, id) as { used: number };
    return used + count <= this.limit(row.agent);
  }

  // Called within the same transaction that replaces this source's fragments.
  admit(id: string, count: number): boolean {
    const row = this.database.prepare("SELECT agent FROM sources WHERE id = ?").get(id) as { agent: string };
    this.database.prepare("UPDATE sources SET session_fragment_count = ? WHERE id = ?").run(count, id);
    if (!this.canFit(id, count)) {
      this.wait(id, count > this.limit(row.agent) ? "oversized" : "capacity");
      return false;
    }
    const own = (this.database.prepare("SELECT count(*) AS n FROM fragments WHERE source_id = ?").get(id) as { n: number }).n;
    let used = this.used(row.agent) - own;
    while (used + count > this.limit(row.agent)) {
      const oldest = this.oldest(row.agent, id);
      this.wait(oldest.id, "capacity");
      this.database.prepare("INSERT INTO source_audit(source_id, action, created_at) VALUES (?, 'capacity_released', ?)")
        .run(oldest.id, new Date().toISOString());
      used -= oldest.n;
    }
    this.database.prepare("UPDATE sources SET admission_reason = NULL WHERE id = ?").run(id);
    return true;
  }

  *trimSteps(): Generator<void> {
    for (const [agent, value] of Object.entries(this.status())) {
      let used = value.fragments;
      while (used > this.limit(agent)) {
        const oldest = this.oldest(agent);
        this.database.transaction(() => this.wait(oldest.id, "capacity"))();
        used -= oldest.n;
        yield;
      }
    }
  }
}
