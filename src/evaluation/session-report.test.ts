import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { sessionReportHref, writeSessionReportPages } from "./session-report.js";
import type { EvaluationManifest } from "./types.js";

it("links to escaped, filtered original-line evidence without modifying the source", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-report-"));
  try {
    const sourcePath = path.join(directory, "source.jsonl");
    const record = (role: string, text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
    const raw = [record("system", "HIDDEN SYSTEM"), record("user", "Inspect <script>alert(1)</script>"), record("assistant", "Synthetic visible answer.\napi_key=synthetic-secret-value")].join("\n");
    await fs.writeFile(sourcePath, raw);
    const manifest = { datasets: [{ id: "dataset", agent: "codex", sessions: [{ sourceId: "session/unsafe", sourcePath, updatedAt: new Date(0).toISOString(), contentFingerprint: createHash("sha256").update(raw).digest("hex") }] }] } as EvaluationManifest;
    await writeSessionReportPages(directory, manifest, { async countContentTokens() { throw new Error("Viewer must not tokenize"); } });
    const href = sessionReportHref("dataset", "session/unsafe", "line:2");
    const html = await fs.readFile(path.join(directory, href.split("#")[0]!), "utf8");
    expect(href).toMatch(/^sessions\/[a-f0-9]+\.html#line-2$/u);
    expect(html).toContain('id="line-2"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("HIDDEN SYSTEM");
    expect(html).not.toContain("synthetic-secret-value");
    expect(html).toContain("[credential-like content omitted]");
    expect(html).toContain(sourcePath);
    expect(await fs.readFile(sourcePath, "utf8")).toBe(raw);
    manifest.datasets[0]!.sessions[0]!.contentFingerprint = "changed";
    await expect(writeSessionReportPages(directory, manifest, { async countContentTokens() { return 1; } })).rejects.toThrow("fingerprint");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
