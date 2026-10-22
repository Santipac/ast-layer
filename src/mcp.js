// MCP server: exposes the deterministic layer to Claude as tools.
// It answers from the last scan on disk; only `scan` runs the analyzer.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runScan, filterFindings, staleFiles, similarOptions, recordDecision } from "./cli.js";
import { DECISION_VALUES } from "./decisions.js";
import { prFindings } from "./pr.js";
import { proposeFix } from "./fix.js";
import { readHookLog, computeStats } from "./stats.js";
import { withWritesForbidden } from "./guard.js";
import { loadOut, findEquivalents, keyForFile, searchNames } from "./lookup.js";
import { TOOL } from "./analyze.js";
import { projectDir as resolveProject, outDirFor } from "./paths.js";

const projectDir = () => resolveProject();
const outDir = () => outDirFor(projectDir());
const noScanYet = "No scan for this workspace yet: call the `scan` tool first.";
const load = () => { try { return loadOut(outDir()); } catch { throw new Error(noScanYet); } };
const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });
// Evidence in `findings`. Without it an agent calls `finding` once per copy;
// with the full evidence on every query, broad explorations cost more than the
// calls it saves. The summary keeps what an agent acts on.
const SUMMARY_MAX = 10; const FULL_INLINE = 5; const FULL_MAX_CHARS = 2000;
const short = (v) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t.length > 60 ? t.slice(0, 57) + "..." : t; };
const copyOf = (m) => `${m.location} (${m.package}${m.lines ? `, ${m.lines} lines` : ""}${(m.public || []).length ? `, public ${m.public[0]}` : ""})`;
const copyNumber = (ev, location) => { const i = (ev.members || []).findIndex((m) => m.location === location); return i < 0 ? location : String(i + 1); };
/** Copies, differences and where a shared version could live; no hashes or module-loading details. */
export function evidenceSummary(f) {
  const ev = f.evidence || {};
  const out = {};
  const copies = [...(ev.members || []), ...(ev.local ? [ev.local] : []), ...(ev.library ? [ev.library] : [])].map(copyOf);
  if (!copies.length && ev.files) copies.push(...ev.files.map((x) => (typeof x === "string" ? x : `${x.file} (${x.package})`)));
  if (copies.length) out.copies = copies.slice(0, 8);
  const diffs = [
    ...(ev.literalDifferences || []).map((d) => `literal: ${(d.values || []).map(short).join(" vs ")}`),
    ...(ev.freeIdentifierDifferences || []).map((d) => `\`${d.name}\` resolves to ${short(d.here || "nothing")} here, ${short(d.library || "nothing")} in the library`),
    ...(ev.moduleStateDifferences || []).map((d) => `\`${d.name}\` is each copy's own module-level declaration`),
    ...(f.kind === "duplicate.similar" ? (ev.pairs || []).slice(0, 3).map((p) => `copies ${copyNumber(ev, p.a)} and ${copyNumber(ev, p.b)} share ${Math.round(p.similarity * 100)}% of their structure`) : []),
  ];
  if (diffs.length) out.differences = diffs.slice(0, 6);
  if ((ev.candidateHomes || []).length) out.candidateHomes = ev.candidateHomes;
  if ((ev.home || []).length) out.home = ev.home;
  if ((ev.brokenRules || []).length) out.brokenRules = ev.brokenRules;
  return out;
}
const brief = (f) => ({ id: f.id, key: f.key, class: f.class, kind: f.kind, where: f.locations.slice(0, 6).map((l) => `${l.file}:${l.line}:${l.col}`), moreLocations: Math.max(0, f.locations.length - 6), why: f.why, nextAction: f.nextAction, stopConditions: f.stopConditions, ...(f.status === "decided" ? { status: f.status, decision: f.decision } : {}), ...(f.previousDecision ? { previousDecision: f.previousDecision } : {}) });

/** "file#name" of every copy in a duplicate finding -> [{ key, kind, class }]. */
function duplicatesByDefinition(report) {
  const out = new Map();
  const add = (m, f) => {
    if (!m || !m.location || !m.name) return;
    const k = `${m.location.slice(0, m.location.lastIndexOf(":"))}#${m.name}`;
    if (!out.has(k)) out.set(k, []);
    if (!out.get(k).some((x) => x.key === f.key)) out.get(k).push({ key: f.key, kind: f.kind, class: f.class, ...(f.status === "decided" ? { decision: f.decision.decision } : {}) });
  };
  for (const f of report.findings) {
    if (!f.kind.startsWith("duplicate.")) continue;
    const ev = f.evidence || {};
    for (const m of ev.members || []) add(m, f);
    add(ev.local, f); add(ev.library, f);
  }
  return out;
}

// The last program stays in memory: the next `scan` of the same roots rebuilds
// with `oldProgram` and reuses every SourceFile whose text did not change.
let memo = null;

function scanNow(roots, includeTests) {
  const rs = (roots && roots.length ? roots : memo ? memo.roots : [projectDir()]).map((r) => path.resolve(projectDir(), r));
  const memoKey = JSON.stringify([rs, Boolean(includeTests)]);
  const ctx = memo && memo.key === memoKey ? { oldProgram: memo.program, sourceFileCache: memo.cache } : { sourceFileCache: new Map() };
  const editedSinceLastScan = staleFiles(outDir());
  const r = runScan(rs, { out: outDir(), includeTests: Boolean(includeTests), ctx });
  memo = { key: memoKey, roots: rs, program: r.program, cache: ctx.sourceFileCache };
  return { ...r, editedSinceLastScan };
}

export async function startMcpServer() {
  const server = new McpServer({ name: TOOL.name, version: TOOL.version });

  server.registerTool("scan", {
    title: "Scan code into deterministic facts",
    description: "Run the read-only analyzer over one or more roots (repos, monorepo folders, or several micro-frontend repos at once) and store the report outside the repository. The plugin already scans the project at session start; call this again after changes, or to analyze several repos as one group. Defaults to the project directory.",
    inputSchema: { roots: z.array(z.string()).optional().describe("Absolute or project-relative directories. Several roots are analyzed as one group."), includeTests: z.boolean().optional() },
  }, async ({ roots, includeTests }) => {
    try {
      const r = scanNow(roots && roots.length ? roots : [projectDir()], includeTests);
      const { report, ms } = r;
      return json({ summary: report.summary, seconds: +(ms / 1000).toFixed(1), incremental: { reusedFiles: r.incremental.reused, parsedFiles: r.incremental.parsed, editedSinceLastScan: r.editedSinceLastScan }, limits: report.limits, firstFindings: report.findings.filter((f) => f.status !== "decided").slice(0, 15).map(brief), report: path.join(outDir(), "REPORT.md") });
    } catch (e) { return fail(`scan failed: ${e.message}`); }
  });

  server.registerTool("findings", {
    title: "Query findings",
    description: "Findings from the last scan, filtered. Each one has an exact location, a class (provable | agent-guided | manual-review), the reason, the next action and stop conditions; filtered by name or file, the first 10 also carry an evidence summary (copies, differences, candidate homes), so `finding` is only needed for the full record. The class was decided before any model saw the code and must not be upgraded.",
    inputSchema: {
      class: z.enum(["provable", "agent-guided", "manual-review"]).optional(),
      kind: z.string().optional().describe("e.g. duplicate, duplicate.reinvents-library-export, boundary, graph.package-cycle, federation, deps.version-drift"),
      name: z.string().optional().describe("A function, hook, component or class name (substring); also matches file names"),
      package: z.string().optional(), file: z.string().optional().describe("Substring of a file path"),
      limit: z.number().int().min(1).max(100).optional(),
      includeDecided: z.boolean().optional().describe("Also return findings that have a recorded decision (left out by default)"),
      evidence: z.enum(["none", "summary", "full"]).optional().describe("summary (default when filtering by name or file): copies, differences and candidate homes of the first 10. full: the complete evidence of the first 5. none (default for broad filters)."),
    },
  }, async (a) => {
    try {
      const { report } = load();
      const r = filterFindings(report, { cls: a.class, kind: a.kind, pkg: a.package, file: a.file, name: a.name, limit: a.limit || 20, includeDecided: Boolean(a.includeDecided) });
      const mode = a.evidence || (a.name || a.file ? "summary" : "none");
      const findings = r.findings.map((f, i) => {
        if (mode === "summary" && i < SUMMARY_MAX) {
          // The copies name every location with its package: `where` would repeat them.
          const { where, moreLocations, ...rest } = brief(f);
          const ev = evidenceSummary(f);
          return ev.copies ? { ...rest, evidence: ev } : { where, moreLocations, ...rest, evidence: ev };
        }
        if (mode === "full" && i < FULL_INLINE && JSON.stringify(f.evidence || {}).length <= FULL_MAX_CHARS) return { ...brief(f), evidence: f.evidence };
        return brief(f);
      });
      const inline = findings.filter((f) => f.evidence).length;
      const note = mode === "none" ? "No evidence inline: filter by name or file for a summary, or call `finding` with a key." : `${inline} of these carry ${mode === "summary" ? "an evidence summary (copies, differences, candidate homes)" : "their full evidence"}; \`finding\` with a key has everything.`;
      return json({ total: r.total, findings, evidence: note, limits: report.limits.slice(0, 2) });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("record_decision", {
    title: "Record a decision about a finding",
    description: "Only when the user explicitly asks to remember a decision about a finding (\"keep these separate\", \"we will extract it later\", \"that copy is fine\", \"false positive\"). scope repo (default) writes ast-layer.decisions.json at the repository root, shared with the team through git; scope user keeps it private in the plugin data dir. The finding then gets status \"decided\" and leaves the session note and edit warnings; if its code changes, the decision stops applying and the finding comes back marked as outdated. Never call it on your own initiative.",
    inputSchema: {
      findingKey: z.string().describe("The finding's key (or id) from the last scan"),
      decision: z.enum(DECISION_VALUES),
      note: z.string().optional().describe("Why, in the user's words"),
      scope: z.enum(["repo", "user"]).optional(),
    },
  }, async ({ findingKey, decision, note, scope }) => {
    try {
      const r = recordDecision({ out: outDir(), findingKey, decision, note: note || "", scope: scope || "repo" });
      const after = scanNow(null, false).report.findings.find((f) => f.key === r.entry.findingKey);
      return json({ recorded: r.entry, file: r.file, scope: r.scope, replaced: r.replaced, findingStatus: after ? after.status : "not found after rescan", note: r.scope === "repo" ? "The decisions file is in the repository: it goes into git with the user's next commit." : "Stored only for this user." });
    } catch (e) { return fail(`record_decision failed: ${e.message}`); }
  });

  server.registerTool("propose_fix", {
    title: "Verified fix for a provable finding",
    description: "For a provable duplicate.reinvents-library-export or boundary.bypasses-package-entry finding: computes the change (delete the local copy and import or re-export the library's; or point the import at the package entry) and verifies it in memory: no new TypeScript diagnostics in the edited files and their importers, and the finding disappears without creating another (a finding about the same code that only got smaller, such as a module copy going from 4 of 4 to 3 of 4 matching definitions, is listed in shrunkFindings and does not count). Returns a unified diff, exact oldString/newString edits and `verified`. Never writes. Apply the edits with Edit only if verified is true; otherwise report why and do not apply.",
    inputSchema: { id: z.string().describe("Finding id or key") },
  }, async ({ id }) => {
    try {
      const { report, meta } = load();
      const roots = meta.roots.map((r) => r.abs);
      const ctx = { rootLabels: meta.roots.map((r) => r.label), ...(memo && memo.key === JSON.stringify([roots, Boolean(report.options.includeTests)]) ? { oldProgram: memo.program, sourceFileCache: memo.cache } : {}) };
      const r = withWritesForbidden(() => proposeFix(roots, id, { opts: { includeTests: report.options.includeTests, minNodes: report.options.minNodes }, ctx }));
      return json(r);
    } catch (e) { return fail(`propose_fix failed: ${e.message}`); }
  });

  server.registerTool("stats", {
    title: "Local hook telemetry",
    description: "What the plugin's hooks did on this machine, from the local hook log: sessions, post-edit warnings by type (structural, similar, same-name, architecture-rule), files warned, and whether each warned unit was removed afterwards (warning followed) or kept. Nothing is sent anywhere.",
    inputSchema: { since: z.string().optional().describe("7d, 24h, 30m or an ISO date") },
  }, async ({ since }) => {
    try {
      const data = process.env.CLAUDE_PLUGIN_DATA;
      if (!data || data.includes("${")) return fail("no plugin data directory: stats are only recorded inside Claude Code");
      const st = computeStats(readHookLog(path.join(data, "hook-log.jsonl")), { since: since || null });
      return json({ ...st, details: st.details.slice(0, 30) });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("pr_findings", {
    title: "Findings this change introduces",
    description: "Compare the working tree with a git ref (default origin/main) or a saved report.json: returns only findings whose key is new, plus findings that touch files changed since the ref. Decisions and architecture rules apply. Use before opening or reviewing a PR. Read-only: the base is extracted to a temporary directory outside the repository and removed.",
    inputSchema: {
      base: z.string().optional().describe("Git ref to compare with (default origin/main)"),
      baseline: z.string().optional().describe("Path to a saved report.json to compare with instead of a git ref"),
      failOn: z.array(z.enum(["provable", "agent-guided", "manual-review"])).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async ({ base, baseline, failOn, limit }) => {
    try {
      const r = await prFindings(projectDir(), { base: baseline ? null : base || "origin/main", baseline: baseline ? path.resolve(projectDir(), baseline) : null, failOn: failOn || [] });
      return json({ base: r.base, changedFiles: r.changedFiles, newFindings: r.newFindings, byClass: r.byClass, failed: r.failed, findings: r.findings.slice(0, limit || 30).map((f) => ({ ...brief(f), prReason: f.prReason })), seconds: r.seconds });
    } catch (e) { return fail(`pr_findings failed: ${e.message}`); }
  });

  server.registerTool("finding", {
    title: "Full finding",
    description: "Everything recorded for one finding, by id or key, including evidence (members, literal differences, free-identifier resolutions, module-loading facts). The key is stable across line shifts; the id is positional.",
    inputSchema: { id: z.string().describe("Finding id or key") },
  }, async ({ id }) => {
    try {
      const { report } = load();
      const f = report.findings.find((x) => x.id === id || x.key === id);
      return f ? json(f) : fail(`no finding with id ${id}`);
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("search_names", {
    title: "Does something with this name or purpose already exist?",
    description: "Search every top-level function, hook, component and class, and every public library export, across all scanned packages and repos, by name or concept words (e.g. \"confirmation modal\", \"useDebounce\", \"format currency\"). Use before creating any new function, hook, component or util, and before writing logic another app may already have. Pass several names or phrasings at once in `queries` (the name you would give it, and the concept) instead of calling it again. Returns locations, for public exports the exact import line, and for definitions that are part of a known duplicate the finding's key and class.",
    inputSchema: {
      query: z.string().optional().describe("A name or a few concept words"),
      queries: z.array(z.string()).max(6).optional().describe("Several names or phrasings searched in one call"),
      limit: z.number().int().min(1).max(50).optional().describe("Per query"),
    },
  }, async ({ query, queries, limit }) => {
    try {
      const { index, meta, report } = load();
      const qs = [...new Set([...(query ? [query] : []), ...(queries || [])].map((q) => q.trim()).filter(Boolean))];
      if (!qs.length) return fail("pass query or queries");
      const dups = duplicatesByDefinition(report);
      const results = qs.map((q) => ({ query: q, hits: searchNames(index, q, { limit: limit || 25 }).map((h) => { const d = dups.get(`${h.where.slice(0, h.where.lastIndexOf(":"))}#${h.name}`); return d ? { ...h, duplicateFindings: d } : h; }) }));
      const empty = results.filter((r) => !r.hits.length).map((r) => `"${r.query}"`);
      const nothing = empty.length ? `Nothing named like ${empty.join(", ")} in the scan from ${meta.generatedAt}. Try other words; this does not prove the behavior is absent.` : null;
      const note = "Name matches are leads: open the code to confirm it does what you need. duplicateFindings: the definition is one of the copies of that finding (`findings` with the name gives the class and the next action).";
      if (qs.length === 1) return json(results[0].hits.length ? { hits: results[0].hits, note } : { result: nothing });
      return json({ results, note, ...(nothing ? { nothing } : {}) });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("find_equivalent", {
    title: "Does equivalent code already exist?",
    description: "Check whether code you have (a draft or a file) is a structural copy of existing code: identical or near-identical after binding-aware normalization (local names and formatting do not matter), or similar (80%+ of the structure in common, cross-package), and whether the match is a public library export to import instead. It only detects copies and close variants; a re-implementation written from a description will not match, so use search_names and findings to ask whether a behavior already exists.",
    inputSchema: { code: z.string().optional(), file: z.string().optional().describe("Path to a file to check instead of code"), language: z.enum(["ts", "tsx", "js", "jsx"]).optional() },
  }, async ({ code, file, language }) => {
    try {
      const { index, meta, report } = load();
      let src = code; let fileName = `snippet.${language || "tsx"}`; let excludeFile = null;
      if (file) { const abs = path.resolve(projectDir(), file); src = fs.readFileSync(abs, "utf8"); fileName = path.basename(abs); excludeFile = keyForFile(meta, abs); }
      if (!src) return fail("pass code or file");
      const excludePackage = excludeFile ? (index.units.find((u) => u.file === excludeFile) || index.names.find((n) => n.file === excludeFile) || {}).package || null : null;
      const res = findEquivalents(index, src, { fileName, excludeFile, similar: similarOptions(outDir(), report), excludePackage });
      return json(res.length ? { matches: res, note: "identical/near: a copy (rules 1 and 2 apply). similar: close but not identical; compare before reusing." } : { result: "No structurally equivalent or similar code in the index from the last scan.", indexFrom: meta.generatedAt });
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("package_graph", {
    title: "Package graph",
    description: "Observed packages, their roles (library vs leaf), entry points, edges with binding-resolved reference counts, Module Federation containers, and public exports nobody in the group consumes.",
    inputSchema: {},
  }, async () => {
    try {
      const { report } = load();
      const o = report.observations;
      return json({ packages: o.packages, edges: o.packageEdges, federation: o.federation.containers, unconsumedPublicExports: o.unconsumedPublicExports.map((u) => ({ package: u.package, count: u.count, sample: (u.exports || []).slice(0, 10).map((e) => e.export), note: u.note })) });
    } catch (e) { return fail(e.message); }
  });

  await server.connect(new StdioServerTransport());
}
