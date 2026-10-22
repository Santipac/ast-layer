// ast-layer CLI
//   scan <root...> [--out .ast-layer] [--include-tests] [--min-nodes N]
//   findings [--out dir] [--class c] [--kind k] [--package p] [--file f] [--limit n] [--json]
//   equivalent (--file path [--name n] | --code "...") [--out dir]
//   stats [--since 7d] [--json] [--log file]   (local hook telemetry; nothing is sent)
//   fix <finding-id-or-key> [--json]   (verified diff for a provable finding; never writes)
//   pr [root] (--base <git-ref> | --baseline report.json) [--format md|json] [--fail-on classes] [--max N]
//   decide <finding-key> --decision keep-separate|extract-later|accepted-copy|false-positive [--note n] [--scope repo|user]
//   hook-session-start        (Claude Code SessionStart hook: scan + short digest into context)
//   hook-post-edit            (Claude Code PostToolUse hook; reads JSON on stdin)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyze, discoverFor, signatureOf } from "./analyze.js";
import { withWritesForbidden } from "./guard.js";
import { stableStringify, toMarkdown } from "./report.js";
import { writeReport, markStale, writeFileAtomic } from "./writer.js";
import { DECISIONS_FILE, DECISION_VALUES, parseDecisions } from "./decisions.js";
import { loadOut, findEquivalents, describeMatches, keyForFile, nameMatches, similarLoader } from "./lookup.js";
import { discover, TEST_RE } from "./discover.js";
import { brokenRules, importsOfText, ownerOfKey, targetOfSpec } from "./rules.js";
import { projectDir, outDirFor, userDecisionsFile } from "./paths.js";
import { sessionSummary } from "./summary.js";
import { fingerprintStandalone } from "./fingerprint.js";
import { prFindings, prMarkdown } from "./pr.js";
import { proposeFix } from "./fix.js";
import { readHookLog, computeStats, statsText } from "./stats.js";

const MAX_FILES = () => Number(process.env.AST_LAYER_MAX_FILES || 20000);

/** Append one line to the hook log so the hooks' effect can be measured. */
function hookLog(entry) {
  try {
    const data = process.env.CLAUDE_PLUGIN_DATA;
    if (!data || data.includes("${")) return;
    fs.mkdirSync(data, { recursive: true });
    fs.appendFileSync(path.join(data, "hook-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* logging must never break a hook */ }
}

/** The rule that applies to a structural match, as text that travels with the fact. */
function ruleFor(match, editedPackage) {
  const all = [...match.exact, ...match.near];
  const pub = all.find((u) => u.public.length);
  if (pub) {
    const [spec, name] = pub.public[0].split("#");
    return `ast-layer rule for this case: a library the code can depend on already exports it. Import it (\`import { ${name} } from "${spec}"\`) instead of keeping this definition${match.exact.length ? "" : ", after checking the listed differences"}.`;
  }
  const others = [...new Set(all.map((u) => u.package).filter((p) => p !== editedPackage))].sort();
  if (others.length) return `This makes ${others.length + 1} copies of code that exists in ${others.join(", ")} and in no library (manual-review). ast-layer rule for this case: unless the user explicitly asked for a copy, remove this definition and ask the user whether to extract it to a shared package or to copy it.`;
  return "The same package already has this code. ast-layer rule for this case: reuse the existing definition instead of adding a second one.";
}

/** Imports in an edited file that break an architecture rule and are not already known findings. */
function ruleBreaks(report, key, code, fileName) {
  const rules = (report.observations && report.observations.architectureRules) || [];
  if (!rules.length || !key) return [];
  const pkgs = report.observations.packages;
  const from = ownerOfKey(pkgs, key);
  if (!from || (!report.options.includeTests && TEST_RE.test(key.slice(from.root.length + 1)))) return [];
  const known = new Set(report.findings.filter((f) => f.kind === "architecture.rule-violation" && f.locations[0].file === key).map((f) => `${f.evidence.rule.id}\0${f.evidence.specifier}`));
  const out = [];
  const fed = new Set(((report.observations.federation.remoteAliases || []).find((x) => x.package === from.id) || { aliases: [] }).aliases);
  for (const imp of importsOfText(code, fileName)) {
    // Federated remotes resolve at runtime, never to a workspace package: only toSpecifier rules apply.
    let target = fed.has(imp.spec.split("/")[0]) ? null : targetOfSpec(pkgs, key, imp.spec);
    if (target && target.id === from.id) target = null;
    for (const rule of brokenRules(rules, { root: from.root, from, spec: imp.spec, target, typeOnly: imp.typeOnly })) {
      if (!known.has(`${rule.id}\0${imp.spec}`)) out.push({ rule, imp });
    }
  }
  return out;
}

/** "file:line" of every copy covered by a recorded decision (the local copy only, for library reinventions). */
function decidedLocations(report) {
  const out = new Map();
  for (const f of report.findings) {
    if (f.status !== "decided" || !f.kind.startsWith("duplicate.")) continue;
    const locs = f.kind === "duplicate.reinvents-library-export" ? f.locations.slice(0, 1) : f.locations;
    for (const l of locs) out.set(`${l.file}:${l.line}`, f.decision);
  }
  return out;
}

/** The rule for code that is similar but not identical to existing code (3.2). */
function similarRuleFor(match) {
  const pub = match.similar.find((u) => u.public.length);
  const reuse = pub ? `import the public export (\`import { ${pub.public[0].split("#")[1]} } from "${pub.public[0].split("#")[0]}"\`)` : "do not add another copy; tell the user where the existing copies are and ask whether to extract or copy";
  return `Similar is not the same: ast-layer rule for this case: compare \`${match.unit}\` with the existing code before reusing or keeping it. If they do the same thing, rules 1 and 2 apply: ${reuse}. If the differences are intentional, keep it and say why.`;
}

/** Options for similar matches against a scan's index (same thresholds as the scan). */
export function similarOptions(outDir, report) {
  return { load: similarLoader(outDir), minNodes: report.options.similarMinNodes, threshold: report.options.similarThreshold, sameNameThreshold: report.options.similarSameNameThreshold ?? report.options.similarThreshold };
}

/** Scan `project` into `out` unless it is too large for an automatic scan. */
function autoScan(project, out, { reuse = false } = {}) {
  const disc = withWritesForbidden(() => discover([project]));
  const n = disc.files.length;
  if (!n) return { skipped: "no JS/TS files" };
  if (n > MAX_FILES()) return { skipped: `${n} JS/TS files is above the automatic-scan limit of ${MAX_FILES()} (AST_LAYER_MAX_FILES); call the scan tool explicitly` };
  return runScan([project], { out, reuse, ctx: { disc } });
}

/** The package a file key belongs to, from the closest indexed file. */
function packageForKey(index, key) {
  if (!key) return null;
  let best = null; let bestLen = -1;
  for (const n of index.names || []) {
    let i = 0; const a = n.file; while (i < a.length && i < key.length && a[i] === key[i]) i++;
    const common = a.slice(0, i).lastIndexOf("/");
    if (common > bestLen) { bestLen = common; best = n.package; }
  }
  return best;
}

function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[k] = true; else { flags[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Files edited after the last scan, as recorded by the post-edit hook. */
export function staleFiles(out) {
  try { return JSON.parse(fs.readFileSync(path.join(path.resolve(out), "stale.json"), "utf8")).files || []; } catch { return []; }
}

/**
 * Scan `roots` into `out`.
 * - `reuse`: if nothing the result depends on changed since the scan in `out`
 *   (same signature, no stale mark), return that scan instead of re-analyzing.
 * - `ctx`: passed to analyze (oldProgram/sourceFileCache for an incremental
 *   rebuild; rootLabels). The result is the same as a full scan either way.
 */
export function runScan(roots, { out = ".ast-layer", includeTests = false, minNodes, reuse = false, ctx = {} } = {}) {
  const opts = { includeTests };
  if (minNodes) opts.minNodes = Number(minNodes);
  const t0 = Date.now();
  const disc = ctx.disc || withWritesForbidden(() => discoverFor(roots, opts, ctx));
  if (!ctx.userDecisionFiles) ctx = { ...ctx, userDecisionFiles: disc.roots.map((r) => ({ root: r.label, abs: userDecisionsFile(r.abs) })).filter((u) => u.abs) };
  const signature = withWritesForbidden(() => signatureOf(disc, opts, ctx.userDecisionFiles.map((u) => u.abs)));
  if (reuse && !staleFiles(out).length) {
    try {
      const prev = loadOut(out);
      if (prev.meta.signature === signature) return { dir: prev.dir, report: prev.report, ms: Date.now() - t0, cached: true, signature };
    } catch { /* no usable previous scan */ }
  }
  const result = withWritesForbidden(() => analyze(roots, opts, { ...ctx, disc }));
  const ms = Date.now() - t0;
  const meta = {
    roots: result.report.roots.map((r, i) => {
      const abs = path.resolve(roots[i]);
      let gitHead = null;
      try { gitHead = execFileSync("git", ["-C", abs, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
      return { label: r.label, abs, gitHead };
    }),
    durationMs: ms,
    generatedAt: new Date().toISOString(),
    signature,
    sourceFiles: result.incremental,
  };
  const dir = writeReport(out, {
    "report.json": stableStringify(result.report),
    "index.json": stableStringify(result.index, 0),
    "similar.json": stableStringify(result.similar, 0),
    "REPORT.md": toMarkdown(result.report),
    "meta.json": stableStringify(meta),
  });
  return { dir, report: result.report, ms, cached: false, signature, program: result.program, incremental: result.incremental };
}

export function filterFindings(report, { cls, kind, pkg, file, name, limit = 50, includeDecided = false } = {}) {
  let fs_ = includeDecided ? report.findings : report.findings.filter((f) => f.status !== "decided");
  if (name) {
    const n = name.toLowerCase();
    const namesOf = (f) => { const ev = f.evidence || {}; return [...(ev.members || []).map((m) => m.name), ev.local && ev.local.name, ev.library && ev.library.name, ...((ev.bindings || []).map((b) => b.imported))].filter(Boolean); };
    fs_ = fs_.filter((f) => namesOf(f).some((x) => x.toLowerCase().includes(n)) || f.locations.some((l) => l.file.toLowerCase().includes(n)));
  }
  if (cls) fs_ = fs_.filter((f) => f.class === cls);
  if (kind) fs_ = fs_.filter((f) => f.kind === kind || f.kind.startsWith(kind + "."));
  if (file) fs_ = fs_.filter((f) => f.locations.some((l) => l.file.includes(file)));
  if (pkg) fs_ = fs_.filter((f) => JSON.stringify(f.evidence).includes(pkg) || f.why.includes(pkg));
  return { total: fs_.length, findings: fs_.slice(0, Number(limit)) };
}

/**
 * Record a decision about a finding of the last scan in `out`. Writes only the
 * decisions file (repo scope: <root>/ast-layer.decisions.json, shared through
 * git; user scope: the plugin data dir), and only when called: the CLI command
 * and the MCP tool exist for when the user asks to record a decision.
 */
export function recordDecision({ out, findingKey, decision, note = "", scope = "repo" }) {
  if (!DECISION_VALUES.includes(decision)) throw new Error(`decision must be one of ${DECISION_VALUES.join(", ")}`);
  if (scope !== "repo" && scope !== "user") throw new Error("scope must be repo or user");
  const { report, meta } = loadOut(out);
  const f = report.findings.find((x) => x.key === findingKey || x.id === findingKey);
  if (!f) throw new Error(`no finding with key ${findingKey} in the last scan; rescan and use the current key`);
  const root = (meta.roots || []).find((r) => r.label === f.locations[0].file.split("/")[0]);
  if (!root) throw new Error(`cannot tell which root ${f.locations[0].file} belongs to`);
  const file = scope === "user" ? userDecisionsFile(root.abs) : path.join(root.abs, DECISIONS_FILE);
  if (!file) throw new Error("scope user needs the plugin data directory (CLAUDE_PLUGIN_DATA); use scope repo");
  let current = [];
  if (fs.existsSync(file)) {
    const parsed = parseDecisions(fs.readFileSync(file, "utf8"), file, scope);
    if (parsed.problems.length) throw new Error(`${parsed.problems[0]} Fix or remove it first; it was not overwritten.`);
    current = parsed.decisions.map(({ scope: _s, ...d }) => d);
  }
  // A new decision replaces the one for the same key and any outdated one for the same finding.
  const kept = current.filter((d) => d.findingKey !== f.key && d.anchor !== f.anchor);
  const entry = { findingKey: f.key, anchor: f.anchor, kind: f.kind, decision, ...(note ? { note } : {}), about: f.why.length > 200 ? f.why.slice(0, 199) + "…" : f.why, recordedAt: new Date().toISOString().slice(0, 10) };
  const decisions = [...kept, entry].sort((a, b) => a.findingKey.localeCompare(b.findingKey));
  writeFileAtomic(file, JSON.stringify({ version: 1, decisions }, null, 2) + "\n");
  return { file, scope, entry, replaced: current.length - kept.length };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const out = flags.out || ".ast-layer";

  if (cmd === "scan") {
    if (!pos.length) throw new Error("usage: ast-layer scan <root...>");
    const { dir, report, ms } = runScan(pos, { out, includeTests: Boolean(flags["include-tests"]), minNodes: flags["min-nodes"] });
    const s = report.summary;
    console.log(`ast-layer: ${s.files} files, ${s.packages} packages, ${s.findings} findings in ${(ms / 1000).toFixed(1)}s`);
    console.log(`  ${Object.entries(s.byClass).map(([k, v]) => `${k}: ${v}`).join(" · ")}`);
    console.log(`  report: ${path.join(dir, "REPORT.md")}`);
    return;
  }
  if (cmd === "findings") {
    const { report } = loadOut(out);
    const r = filterFindings(report, { cls: flags.class, kind: flags.kind, pkg: flags.package, file: flags.file, name: flags.name, limit: flags.limit || 50, includeDecided: Boolean(flags["include-decided"]) });
    if (flags.json) { process.stdout.write(stableStringify(r)); return; }
    console.log(`${r.total} matching findings${r.total > r.findings.length ? ` (showing ${r.findings.length})` : ""}`);
    for (const f of r.findings) console.log(`\n[${f.class}] ${f.kind} ${f.id} (key ${f.key})\n  at ${f.locations.slice(0, 4).map((l) => `${l.file}:${l.line}`).join(", ")}\n  why: ${f.why}\n  next: ${f.nextAction}`);
    return;
  }
  if (cmd === "stats") {
    const data = process.env.CLAUDE_PLUGIN_DATA;
    const log = typeof flags.log === "string" ? flags.log : data && !data.includes("${") ? path.join(data, "hook-log.jsonl") : null;
    if (!log) throw new Error("no hook log: pass --log <hook-log.jsonl> or run inside Claude Code (CLAUDE_PLUGIN_DATA)");
    const st = computeStats(readHookLog(log), { since: typeof flags.since === "string" ? flags.since : null });
    if (flags.json) process.stdout.write(stableStringify(st)); else process.stdout.write(statsText(st));
    return;
  }
  if (cmd === "fix") {
    if (!pos[0]) throw new Error("usage: ast-layer fix <finding-id-or-key> [--out dir] [--json]");
    const { report, meta } = loadOut(out);
    const r = withWritesForbidden(() => proposeFix(meta.roots.map((x) => x.abs), pos[0], { opts: { includeTests: report.options.includeTests, minNodes: report.options.minNodes }, ctx: { rootLabels: meta.roots.map((x) => x.label) } }));
    if (flags.json) process.stdout.write(stableStringify(r));
    else {
      console.log(`${r.verified ? "VERIFIED" : "NOT VERIFIED"}: ${r.reason}`);
      if (r.diff) console.log(`\n${r.diff}`);
      for (const d of r.newDiagnostics || []) console.log(`new diagnostic ${d.file}:${d.line} TS${d.code} ${d.message}`);
      for (const n of r.newFindings || []) console.log(`new finding ${n.kind} at ${n.where}: ${n.why}`);
      for (const n of r.shrunkFindings || []) console.log(`still reported, smaller: ${n.kind} at ${n.where}: ${n.why}`);
    }
    if (!r.verified) process.exitCode = 1;
    return;
  }
  if (cmd === "pr") {
    const failOn = typeof flags["fail-on"] === "string" ? flags["fail-on"].split(",").map((x) => x.trim()).filter(Boolean) : [];
    const bad = failOn.filter((c) => !["provable", "agent-guided", "manual-review"].includes(c));
    if (bad.length) throw new Error(`--fail-on takes provable, agent-guided, manual-review (got ${bad.join(", ")})`);
    const r = await prFindings(pos[0] || projectDir(), { base: typeof flags.base === "string" ? flags.base : null, baseline: typeof flags.baseline === "string" ? flags.baseline : null, failOn, includeTests: Boolean(flags["include-tests"]) });
    if (flags.format === "json") process.stdout.write(stableStringify({ ...r, findings: r.findings.slice(0, Number(flags.max) || r.findings.length) }));
    else process.stdout.write(prMarkdown(r, { max: Number(flags.max) || 50 }));
    if (r.failed) process.exitCode = 1;
    return;
  }
  if (cmd === "decide") {
    if (!pos[0] || !flags.decision) throw new Error(`usage: ast-layer decide <finding-key> --decision ${DECISION_VALUES.join("|")} [--note "..."] [--scope repo|user] [--out dir]`);
    const r = recordDecision({ out, findingKey: pos[0], decision: flags.decision, note: typeof flags.note === "string" ? flags.note : "", scope: flags.scope || "repo" });
    console.log(`ast-layer: recorded "${r.entry.decision}" for ${r.entry.findingKey} (${r.entry.kind}) in ${r.file}${r.replaced ? `, replacing ${r.replaced} earlier decision(s)` : ""}. It applies from the next scan.`);
    return;
  }
  if (cmd === "equivalent") {
    const { index, meta, report } = loadOut(out);
    let code; let fileName = "snippet.tsx"; let excludeFile = null;
    if (flags.file) { code = fs.readFileSync(flags.file, "utf8"); fileName = path.basename(flags.file); excludeFile = keyForFile(meta, flags.file); }
    else if (typeof flags.code === "string") code = flags.code;
    else code = await readStdin();
    let res = findEquivalents(index, code, { fileName, excludeFile, minNodes: flags["any-size"] ? 0 : report.options.minNodes, similar: similarOptions(out, report), excludePackage: excludeFile ? packageForKey(index, excludeFile) : null });
    if (flags.name) res = res.filter((r) => r.unit === flags.name);
    if (flags.json) { process.stdout.write(stableStringify(res)); return; }
    console.log(res.length ? describeMatches(res) : "No structurally equivalent code found in the index.");
    return;
  }
  if (cmd === "hook-session-start") {
    // Silent on any problem: a hook must never block the session.
    try {
      const raw = await readStdin();
      const input = raw.trim() ? JSON.parse(raw) : {};
      const project = projectDir(input.cwd);
      const out = outDirFor(project);
      const haveIndex = fs.existsSync(path.join(out, "report.json"));
      let report = null; let cached = null;
      if (haveIndex && (process.env.AST_LAYER_SESSION_SCAN === "off" || input.source === "resume" || input.source === "compact")) report = loadOut(out).report;
      else if (process.env.AST_LAYER_SESSION_SCAN !== "off") {
        // A second session on an unchanged repo reuses the scan (signature match).
        const r = autoScan(project, out, { reuse: true });
        if (r.skipped) {
          if (r.skipped !== "no JS/TS files") process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `ast-layer did not scan this workspace automatically: ${r.skipped}.` } }));
          return;
        }
        report = r.report; cached = r.cached;
      }
      if (!report || !report.summary.files) return;
      const context = sessionSummary(report);
      hookLog({ hook: "session-start", project, source: input.source || null, cached, files: report.summary.files, findings: report.summary.findings, chars: context.length });
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
    } catch { /* silent by design */ }
    return;
  }
  if (cmd === "hook-post-edit") {
    // Never fail the agent's edit: any problem here is silent.
    try {
      const input = JSON.parse(await readStdin());
      const file = input.tool_input && (input.tool_input.file_path || input.tool_input.path);
      if (!file || !/\.[cm]?[jt]sx?$/.test(file) || /\.d\.[cm]?ts$/.test(file)) return;
      const project = projectDir(input.cwd);
      const outDir = flags.out ? path.resolve(project, flags.out) : outDirFor(project);
      // No scan yet (e.g. a fresh workspace): build the index now. It already
      // contains this edit, so there is no "before" for this file: compare all of it.
      let fresh = false;
      if (!fs.existsSync(path.join(outDir, "index.json"))) {
        const r = autoScan(project, outDir);
        if (r.skipped) return;
        fresh = true;
      }
      const { index, meta, report } = loadOut(outDir);
      const abs = path.resolve(project, file);
      if (!fs.existsSync(abs)) return;
      const code = fs.readFileSync(abs, "utf8");
      const key = keyForFile(meta, abs);
      // The index no longer matches this file: the next scan must not reuse it.
      if (!fresh && key) markStale(outDir, key);
      const editedPackage = packageForKey(index, key);
      const structural = findEquivalents(index, code, { fileName: path.basename(abs), excludeFile: key, minNodes: report.options.minNodes, onlyChanged: !fresh, similar: similarOptions(outDir, report), excludePackage: editedPackage });
      const reported = new Set(structural.map((r) => r.unit));
      const currentUnits = fingerprintStandalone(code, path.basename(abs));
      const byName = nameMatches(index, currentUnits.map((u) => u.name).filter((n) => !reported.has(n)), { excludeFile: key, excludePackage: packageForKey(index, key), ignorePrior: fresh });
      const relFile = path.relative(project, abs);
      const breaks = ruleBreaks(report, key, code, abs);
      const identical = structural.filter((r) => r.exact.length || r.near.length);
      // `units` is the file's inventory now and `warned` what this run warned
      // about: `stats` compares a warning with the next inventory of the same
      // file to tell whether the warned copy was removed or kept.
      const exactOf = (name) => (currentUnits.find((u) => u.name === name) || {}).exact || null;
      const warned = [
        ...identical.map((r) => ({ unit: r.unit, type: "structural", exact: exactOf(r.unit) })),
        ...structural.filter((r) => !r.exact.length && !r.near.length).map((r) => ({ unit: r.unit, type: "similar", exact: exactOf(r.unit) })),
        ...byName.map((m) => ({ unit: m.name, type: "same-name", exact: exactOf(m.name) })),
        ...breaks.map((b) => ({ unit: null, type: "architecture-rule", rule: b.rule.id, spec: b.imp.spec })),
      ];
      hookLog({ hook: "post-edit", project, file: relFile, units: currentUnits.map((u) => ({ name: u.name, exact: u.exact })), warned, structural: identical.map((r) => ({ unit: r.unit, exact: r.exact.length, near: r.near.length })), similar: structural.filter((r) => r.similar.length).map((r) => ({ unit: r.unit, matches: r.similar.length, best: r.similar[0].similarity })), sameName: byName.map((m) => m.name), ruleBreaks: breaks.map((b) => b.rule.id), emitted: Boolean(structural.length || byName.length || breaks.length), freshIndex: fresh });
      if (!structural.length && !byName.length && !breaks.length) return;
      const lines = [`[ast-layer] Code in ${relFile} relates to existing code (index from ${meta.generatedAt}).`];
      const decidedAt = decidedLocations(report);
      for (const r of structural) {
        lines.push(describeMatches([r]));
        if (r.exact.length || r.near.length) lines.push(ruleFor(r, editedPackage));
        else lines.push(similarRuleFor(r));
        const d = [...r.exact, ...r.near, ...r.similar].map((u) => decidedAt.get(`${u.file}:${u.line}`)).find(Boolean);
        if (d) lines.push(`A recorded decision covers the existing copies ("${d.decision}"${d.note ? `: ${d.note}` : ""}): do not propose extracting or merging them again. This edit adds one more copy, so the decision will not cover the group any more; unless the user asked for this copy, ask whether the decision should cover it.`);
      }
      for (const b of breaks) lines.push(`\`"${b.imp.spec}"\` (line ${b.imp.line}) breaks architecture rule ${b.rule.text} from ast-layer.rules.json${b.rule.message ? `: ${b.rule.message}` : "."} ast-layer rule for this case: the rules file is the team's decision; remove this import and take the code from where the rule allows, or ask the user before keeping it.`);
      for (const m of byName) lines.push(`\`${m.name}\` has the same name as existing exported definitions: ${m.existing.map((e) => `${e.where} (${e.package}${e.public.length ? `; public export ${e.public[0]}` : ""})`).join(", ")}. Same name only; the structure differs, so check whether it is the same behavior. If it is, the ast-layer rules apply: import a public export, or ask the user before adding another copy.`);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: lines.join("\n").slice(0, 9500) } }));
    } catch { /* silent by design */ }
    return;
  }
  console.log("usage: ast-layer <scan|findings|equivalent|fix|pr|decide|stats|hook-session-start|hook-post-edit|mcp> ...");
  process.exitCode = cmd ? 1 : 0;
}
