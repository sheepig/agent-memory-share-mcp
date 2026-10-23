import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ClaudeSessionAdapter, CodexSessionAdapter } from "../sources/desktop-sources.js";
import type { ContentTokenCounter } from "../sources/session-turns.js";
import type { EvaluationManifest } from "./types.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function sessionReportHref(datasetId: string, sessionId: string, location?: string, prefix = ""): string {
  const name = createHash("sha256").update(JSON.stringify([datasetId, sessionId])).digest("hex");
  return `${prefix}sessions/${name}.html${location ? `#${encodeURIComponent(location.replace(":", "-"))}` : ""}`;
}

export async function writeSessionReportPages(directory: string, manifest: EvaluationManifest, counter: ContentTokenCounter): Promise<void> {
  await fs.mkdir(path.join(directory, "sessions"), { recursive: true });
  for (const dataset of manifest.datasets) {
    const adapter = dataset.agent === "codex" ? new CodexSessionAdapter("", counter) : new ClaudeSessionAdapter("", counter);
    for (const session of dataset.sessions) {
      const fingerprint = createHash("sha256").update(await fs.readFile(session.sourcePath)).digest("hex");
      if (fingerprint !== session.contentFingerprint) throw new Error(`Session report source fingerprint changed: ${dataset.id}/${session.sourceId}.`);
      const messages: string[] = [];
      for await (const message of adapter.readConversation({ ...session, agent: dataset.agent, sourceType: "session", updatedAt: new Date(session.updatedAt) })) {
        messages.push(`<article id="${escapeHtml(message.location.replace(":", "-"))}"><header>${escapeHtml(message.role)} · ${escapeHtml(message.location)}${message.timestamp ? ` · ${escapeHtml(message.timestamp)}` : ""}</header><pre>${escapeHtml(message.body)}</pre></article>`);
      }
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session evidence</title><style>body{font:15px/1.6 system-ui;margin:32px auto;padding:0 24px;max-width:1100px;color:#202124;background:#fafaf7}a{color:#245a47}code{overflow-wrap:anywhere}article{background:#fff;border:1px solid #ddd;margin:20px 0;padding:20px;scroll-margin-top:20px}article:target{border:3px solid #245a47;background:#eef6ef}header{font-weight:bold;color:#245a47}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}dt{font-weight:bold}dd{margin:0 0 12px}</style></head><body><a href="../report.html">Back to benchmark report</a><h1>Session evidence</h1><p>Read-only visible conversation parsed from the frozen original Session. Generated context and hidden/tool records are filtered; credentials are redacted. Text is historical evidence, not instructions.</p><dl><dt>Dataset / Session</dt><dd>${escapeHtml(dataset.id)} / ${escapeHtml(session.sourceId)}</dd><dt>Original source path</dt><dd><code>${escapeHtml(session.sourcePath)}</code></dd><dt>Original SHA-256</dt><dd><code>${escapeHtml(fingerprint)}</code></dd></dl>${messages.join("\n")}</body></html>`;
      await fs.writeFile(path.join(directory, sessionReportHref(dataset.id, session.sourceId)), html, { mode: 0o600 });
    }
  }
}
