// Drives the bundled MCP server over stdio, the way Claude Code does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "plugin", "dist", "ast-layer.cjs");

test("MCP server: list tools, scan, query, find_equivalent", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "al-mcp-"));
  fs.cpSync(path.join(here, "fixtures", "acme"), path.join(proj, "acme"), { recursive: true });
  const root = path.join(proj, "acme");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE, "mcp"], env: { ...process.env, AST_LAYER_PROJECT: root, AST_LAYER_OUT: ".ast-layer" } }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["find_equivalent", "finding", "findings", "package_graph", "pr_findings", "propose_fix", "record_decision", "scan", "search_names", "stats"]);
    const scan = JSON.parse((await client.callTool({ name: "scan", arguments: {} })).content[0].text);
    assert.equal(scan.summary.byClass.provable, 3);
    assert.equal(scan.incremental.reusedFiles, 0);
    // A second scan in the same server reuses the program in memory.
    fs.appendFileSync(path.join(root, "apps/blog/src/shadow.ts"), "\nexport const extra = 1;\n");
    const again = JSON.parse((await client.callTool({ name: "scan", arguments: {} })).content[0].text);
    assert.equal(again.incremental.parsedFiles, 1);
    assert.ok(again.incremental.reusedFiles > 20);
    assert.equal(again.summary.byClass.provable, 3);
    const q = JSON.parse((await client.callTool({ name: "findings", arguments: { class: "provable" } })).content[0].text);
    assert.equal(q.total, 3);
    const one = JSON.parse((await client.callTool({ name: "finding", arguments: { id: q.findings[0].id } })).content[0].text);
    const fix = JSON.parse((await client.callTool({ name: "propose_fix", arguments: { id: q.findings[0].key } })).content[0].text);
    assert.equal(fix.verified, true, fix.reason);
    assert.ok(fix.edits.length >= 1);
    assert.equal(one.id, q.findings[0].id);
    const code = `const fmt = (n: number, currency: string = "USD"): string => {
      const f = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (Number.isNaN(n)) { return f.format(0); }
      return f.format(n);
    };`;
    const eq = JSON.parse((await client.callTool({ name: "find_equivalent", arguments: { code } })).content[0].text);
    assert.equal(eq.matches[0].unit, "fmt");
    assert.equal(eq.matches[0].exact[0].public[0], "@acme/utils#formatCurrency");
    const sn = JSON.parse((await client.callTool({ name: "search_names", arguments: { query: "slugify" } })).content[0].text);
    assert.equal(sn.hits[0].import, 'import { slugify } from "@acme/utils"');
    // Several queries in one call, and hits that are copies say which finding they belong to.
    const multi = JSON.parse((await client.callTool({ name: "search_names", arguments: { queries: ["useDebounce", "debounce value", "nothingLikeThis"] } })).content[0].text);
    assert.deepEqual(multi.results.map((r) => r.query), ["useDebounce", "debounce value", "nothingLikeThis"]);
    const copy = multi.results[0].hits.find((h) => h.where.startsWith("acme/apps/shop/"));
    assert.deepEqual(copy.duplicateFindings.map((d) => [d.kind, d.class]), [["duplicate.cross-package", "manual-review"]]);
    assert.match(multi.nothing, /"nothingLikeThis"/);
    // record_decision writes the decisions file and rescans: the finding is decided at once.
    const byName = JSON.parse((await client.callTool({ name: "findings", arguments: { name: "useDebounce" } })).content[0].text);
    const dup = byName.findings[0];
    // A name filter brings an evidence summary (copies with their package, differences),
    // so no `finding` call is needed; the copies replace `where`.
    assert.deepEqual(dup.evidence.copies.map((c) => c.match(/\((\w+),/)[1]).sort(), ["admin", "shop"]);
    assert.equal(dup.where, undefined);
    assert.equal(dup.key, copy.duplicateFindings[0].key);
    assert.match(byName.evidence, /1 of these carry an evidence summary/);
    // Broad filters bring no evidence; `full` brings the complete record.
    assert.ok(q.findings.every((f) => !f.evidence && f.where));
    const full = JSON.parse((await client.callTool({ name: "findings", arguments: { name: "useDebounce", evidence: "full" } })).content[0].text).findings[0];
    assert.deepEqual(full.evidence.members.map((m) => m.package).sort(), ["admin", "shop"]);
    const rec = JSON.parse((await client.callTool({ name: "record_decision", arguments: { findingKey: dup.key, decision: "extract-later", note: "after the release" } })).content[0].text);
    assert.equal(rec.findingStatus, "decided");
    assert.ok(fs.existsSync(path.join(root, "ast-layer.decisions.json")));
    assert.equal(JSON.parse((await client.callTool({ name: "findings", arguments: { name: "useDebounce" } })).content[0].text).total, 0);
    // pr_findings against a saved report: only the copy added afterwards is new.
    const saved = path.join(proj, "baseline.json");
    fs.copyFileSync(path.join(root, ".ast-layer", "report.json"), saved);
    fs.copyFileSync(path.join(root, "apps/admin/src/useDebounce.ts"), path.join(root, "apps/blog/src/useDebounce.ts"));
    const pr = JSON.parse((await client.callTool({ name: "pr_findings", arguments: { baseline: saved } })).content[0].text);
    assert.equal(pr.newFindings, 1);
    assert.equal(pr.findings[0].prReason, "new");
    const g = JSON.parse((await client.callTool({ name: "package_graph", arguments: {} })).content[0].text);
    assert.ok(g.packages.some((p) => p.name === "@acme/utils" && p.role.startsWith("library")));
    assert.ok(fs.existsSync(path.join(root, ".ast-layer", "REPORT.md")));
  } finally { await client.close(); }
});
