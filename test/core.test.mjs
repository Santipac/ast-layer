// Executable verification contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runScan } from "../src/cli.js";
import { withWritesForbidden } from "../src/guard.js";
import { findEquivalents, loadOut } from "../src/lookup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "acme");
const CLI = path.join(here, "..", "src", "main.js");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function treeHash(dir) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const st = fs.statSync(p);
      h.update(path.relative(dir, p) + "\0" + st.mode + "\0" + st.mtimeMs + "\0");
      if (e.isDirectory()) walk(p); else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

const out1 = tmp("al-out1-");
const before = treeHash(FIXTURE);
const { report } = runScan([FIXTURE], { out: path.join(out1, "r") });
const find = (kind, file) => report.findings.filter((f) => f.kind === kind && f.locations[0].file.endsWith(file));

test("target files are untouched by a scan (content, mode and mtime)", () => {
  assert.equal(treeHash(FIXTURE), before);
});

test("two scans produce byte-identical reports", () => {
  const out2 = tmp("al-out2-");
  runScan([FIXTURE], { out: path.join(out2, "r") });
  for (const f of ["report.json", "index.json", "REPORT.md"]) {
    assert.equal(fs.readFileSync(path.join(out2, "r", f), "utf8"), fs.readFileSync(path.join(out1, "r", f), "utf8"), f);
  }
});

test("analysis runs with filesystem writes forbidden", () => {
  const p = path.join(tmp("al-guard-"), "x");
  assert.throws(() => withWritesForbidden(() => fs.writeFileSync(p, "x")), /read-only/);
  assert.throws(() => withWritesForbidden(() => fs.openSync(p, "w")), /read-only/);
  assert.equal(fs.existsSync(p), false);
  fs.writeFileSync(p, "x"); // restored afterwards
});

test("analysis modules have no write path (static check)", () => {
  for (const f of ["analyze.js", "discover.js", "program.js", "fingerprint.js", "cache.js", "rules.js", "decisions.js", "assets.js", "fix.js", "stats.js"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", f), "utf8");
    assert.doesNotMatch(src, /(from|import)\s*\(?\s*["'][^"']*writer(\.js)?["']/, `${f} imports the writer`);
    assert.doesNotMatch(src, /\b(writeFile|appendFile|mkdir|rmSync|unlink|renameSync|createWriteStream)\w*\(/, `${f} calls a write API`);
  }
});

test("exact copy of a public export, dependency declared → provable", () => {
  const [f] = find("duplicate.reinvents-library-export", "apps/shop/src/price.ts");
  assert.equal(f.class, "provable");
  assert.match(f.nextAction, /import \{ formatCurrency as formatPrice \} from "@acme\/utils"/);
});

test("re-export chains are followed to the original declaration", () => {
  const [f] = find("duplicate.reinvents-library-export", "apps/shop/src/price.ts");
  // index.ts → export * from ./format → export { formatCurrency } from ./money/currency
  assert.equal(f.locations[1].file, "acme/packages/utils/src/money/currency.ts");
  assert.deepEqual(f.evidence.library.public, ["@acme/utils#formatCurrency"]);
});

test("near copy with a different literal → agent-guided, with the exact difference", () => {
  const [f] = find("duplicate.reinvents-library-export", "apps/admin/src/money.ts");
  assert.equal(f.class, "agent-guided");
  assert.deepEqual(f.evidence.literalDifferences.map((d) => d.values), [["en-US", "es-AR"]]);
});

test("copy without a declared dependency is not provable", () => {
  const [f] = find("duplicate.reinvents-library-export", "apps/blog/src/currency.js");
  assert.equal(f.class, "agent-guided");
  assert.equal(f.evidence.dependencyDeclared, false);
});

test("cross-package duplicate with no library copy → manual-review with candidate home", () => {
  const [f] = find("duplicate.cross-package", "apps/admin/src/useDebounce.ts");
  assert.equal(f.class, "manual-review");
  assert.deepEqual(f.evidence.candidateHomes, ["@acme/utils"]);
});

test("binding resolution: a local that shadows an import is not a reference", () => {
  const e = report.observations.packageEdges.find((x) => x.from === "blog" && x.to === "@acme/utils");
  assert.equal(e.boundReferences, 1); // `slugify("the import")` only
});

test("relative import into another package, available from its entry → provable", () => {
  const [f] = find("boundary.bypasses-package-entry", "apps/admin/src/Dashboard.tsx");
  assert.equal(f.class, "provable");
  assert.equal(f.evidence.bindings[0].availableFromEntry, "@acme/utils#formatCurrency");
});

test("runtime package cycle is reported", () => {
  const f = report.findings.find((x) => x.kind === "graph.package-cycle");
  assert.deepEqual(f.evidence.packages, ["@acme/ui", "@acme/utils"]);
});

test("federation: remote alias wins over a same-named workspace package; missing exposes are reported", () => {
  assert.equal(report.observations.federation.matchedImports.length, 1);
  assert.equal(find("federation.import-not-exposed", "apps/shop/src/cart.ts")[0].evidence.exposeKey, "./Settings");
  assert.equal(report.findings.filter((x) => x.kind === "federation.expose-file-missing").length, 1);
  const drift = report.findings.find((x) => x.kind === "deps.version-drift");
  assert.equal(drift.evidence.dependency, "react");
  assert.equal(drift.evidence.federatedShared, true);
});

test("limits are printed by construction", () => {
  assert.match(report.limits[0], /not a verdict/);
  assert.ok(report.limits.some((l) => /1 \.vue/.test(l)));
  assert.ok(report.findings.every((f) => f.status === "observation"));
});

test("find_equivalent: renamed snippet matches the public export", () => {
  const { index } = loadOut(path.join(out1, "r"));
  // Different names and formatting; same structure.
  const code = `export const money = (value: number, currency: string = "USD"): string => {
    const f = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (Number.isNaN(value)) { return f.format(0); }
    return f.format(value);
  };`;
  const [r] = findEquivalents(index, code, { fileName: "x.ts" });
  assert.ok(r.exact.some((u) => u.public.includes("@acme/utils#formatCurrency")));
});

test("post-edit hook reports a new copy and stays silent for unrelated code", () => {
  const proj = tmp("al-proj-");
  fs.cpSync(FIXTURE, path.join(proj, "acme"), { recursive: true });
  const root = path.join(proj, "acme");
  execFileSync(process.execPath, [CLI, "scan", root, "--out", path.join(root, ".ast-layer")]);
  const newFile = path.join(root, "apps/blog/src/newprice.ts");
  fs.writeFileSync(newFile, fs.readFileSync(path.join(root, "packages/utils/src/money/currency.ts"), "utf8").replace("formatCurrency", "priceOf").replace(/^import.*$/m, ""));
  const run = (file) => spawnSync(process.execPath, [CLI, "hook-post-edit"], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file }, cwd: root }), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" });
  const r = run(newFile);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /priceOf.*identical.*@acme\/utils#formatCurrency/s);
  // An already-known file that did not change produces no output.
  assert.equal(run(path.join(root, "apps/shop/src/price.ts")).stdout, "");
});

test("a binding that resolves to a type is not a runtime edge (no false cycle)", () => {
  const cycles = report.findings.filter((x) => x.kind === "graph.package-cycle");
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].evidence.packages, ["@acme/ui", "@acme/utils"]);
  const e = report.observations.packageEdges.find((x) => x.from === "@acme/utils" && x.to === "admin");
  assert.equal(e.typeOnlyStatements, 1);
});

test("identical copy is not provable when the library entry would add side-effect imports", () => {
  const [f] = find("duplicate.reinvents-library-export", "apps/shop/src/clamp.ts");
  assert.equal(f.class, "agent-guided");
  assert.equal(f.evidence.match, "exact");
  assert.equal(f.evidence.moduleLoading.alreadyImportsEntry, false);
  assert.equal(f.evidence.moduleLoading.entrySideEffects[0].spec, "./theme.css");
  assert.match(f.why, /side-effect import/);
});

test("library whose exports point to dist/ but whose source lives in lib/ is resolved", () => {
  const [f] = find("duplicate.reinvents-library-export", "apps/shop/src/legacy/date.ts");
  assert.ok(f, "copy of a lib/-sourced export was not detected");
  assert.deepEqual(f.evidence.library.public, ["@acme/legacy-ui#shortDate"]);
});

test("entry that imports Node built-ins is not offered to a React Native consumer", () => {
  const [f] = find("duplicate.reinvents-library-export", "apps/mobile/src/errors.ts");
  assert.equal(f.evidence.match, "exact");
  assert.equal(f.class, "manual-review");
  assert.equal(f.evidence.moduleLoading.entryNodeBuiltins[0].spec, "node:crypto");
  assert.match(f.why, /React Native/);
});

test("identical copies that read their own module-level state are flagged, not merged blindly", () => {
  const [f] = find("duplicate.within-package", "apps/admin/src/pages/reports.ts");
  assert.equal(f.evidence.moduleStateDifferences[0].name, "logger");
  assert.match(f.nextAction, /module-level `logger`/);
});

test("a package whose entry does not resolve is reported as a blind spot", () => {
  assert.ok(report.limits.some((l) => /Blind spot: 1 named package.*@acme\/ghost/.test(l)), report.limits.join("\n"));
});

// ---------- v0.2: the plugin must act without being asked ----------
function freshProject() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "al-v2-"));
  fs.cpSync(FIXTURE, path.join(proj, "acme"), { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "al-data-"));
  return { root: path.join(proj, "acme"), data };
}
const hook = (cmd, root, data, input) => spawnSync(process.execPath, [CLI, cmd], { input: JSON.stringify({ cwd: root, ...input }), env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_DATA: data }, encoding: "utf8" });

test("session start: scans into the plugin data dir (not the repo) and injects a factual digest", async () => {
  const { root, data } = freshProject();
  const before = treeHash(root);
  const r = hook("hook-session-start", root, data, { hook_event_name: "SessionStart", source: "startup" });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "SessionStart");
  assert.match(out.additionalContext, /3 provable/);
  assert.match(out.additionalContext, /useDebounce — copies in admin, shop; no library copy \[manual-review/);
  // Each library copy says its class and why
  assert.match(out.additionalContext, /formatCurrency \(admin\) ≈ @acme\/utils#formatCurrency \[agent-guided: 1 literal value\(s\) differ\]/);
  assert.match(out.additionalContext, /isTokenErrorLike \(mobile\) = @acme\/crypto#isTokenErrorLike \[manual-review: the library entry needs Node\.js built-ins/);
  // The rule travels with the facts
  assert.match(out.additionalContext, /ast-layer rules for acting on these facts:[\s\S]*do not create another copy/);
  assert.match(out.additionalContext, /search_names/);
  assert.ok(out.additionalContext.length <= 3800);
  assert.ok(out.additionalContext.endsWith((await import("../src/summary.js")).ACTION_RULES));
  assert.equal(treeHash(root), before, "the repository must not change");
  assert.equal(fs.readdirSync(path.join(data, "scans")).length, 1);
});

test("session summary: the names line is cut to the space left, not dropped", async () => {
  const { sessionSummary, ACTION_RULES } = await import("../src/summary.js");
  const namesOf = (s) => s.split("\n").find((l) => l.startsWith("Other names"));
  const full = sessionSummary(report, { maxDetailed: 1 });
  const all = namesOf(full);
  assert.ok(all && !/ more\. /.test(all), all);
  const maxChars = full.length - 40;
  const cut = sessionSummary(report, { maxDetailed: 1, maxChars });
  const line = namesOf(cut);
  assert.ok(line, "the line survives a smaller budget");
  assert.match(line, /, and \d+ more\. `findings` with the name returns locations and class\.$/);
  assert.ok(all.startsWith(line.slice(0, line.indexOf(", and "))), "the names kept are the first ones, in order");
  assert.ok(cut.length <= maxChars);
  assert.ok(cut.endsWith(ACTION_RULES));
});

test("post-edit with no prior scan: builds the index, then reports an identical copy", () => {
  const { root, data } = freshProject();
  const f = path.join(root, "apps/blog/src/useDebounce.ts");
  fs.copyFileSync(path.join(root, "apps/shop/src/hooks.ts"), f);
  const r = hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } });
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^\[ast-layer\]/);
  assert.match(ctx, /useDebounce.*identical.*apps\/shop\/src\/hooks\.ts/s);
  // The warning carries the class and the rule
  assert.match(ctx, /makes 3 copies of code that exists in admin, shop and in no library \(manual-review\)/);
  assert.match(ctx, /remove this definition and ask the user/);
  // Every hook run is logged
  const log = fs.readFileSync(path.join(data, "hook-log.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const last = log[log.length - 1];
  assert.equal(last.hook, "post-edit");
  assert.equal(last.emitted, true);
  assert.equal(last.structural[0].exact + last.structural[0].near, 2);
});

test("post-edit: a copy of a public export gets the import line as the rule", () => {
  const { root, data } = freshProject();
  const f = path.join(root, "apps/blog/src/money.ts");
  fs.copyFileSync(path.join(root, "packages/utils/src/money/currency.ts"), f);
  const ctx = JSON.parse(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Import it \(`import \{ formatCurrency \} from "@acme\/utils"`\)/);
});

test("post-edit: same-name matches ignore file-internal helpers (P10.3)", () => {
  const { root, data } = freshProject();
  hook("hook-session-start", root, data, { source: "startup" });
  const f = path.join(root, "apps/shop/src/helpers.ts");
  fs.writeFileSync(f, "export function local(): number {\n  return 42;\n}\n"); // `local` exists in blog, but is not exported there
  assert.equal(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } }).stdout, "");
});

test("findings can be filtered by name", async () => {
  const { filterFindings } = await import("../src/cli.js");
  const r = filterFindings(report, { name: "useDebounce" });
  assert.equal(r.findings[0].kind, "duplicate.cross-package");
});

test("post-edit: a re-implementation with an existing name is reported as a lead, not as a duplicate", () => {
  const { root, data } = freshProject();
  const f = path.join(root, "apps/blog/src/useDebounce.ts");
  fs.writeFileSync(f, `import { useEffect, useState } from "react";
export function useDebounce<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}
`);
  const ctx = JSON.parse(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /`useDebounce` has the same name as existing exported definitions/);
  assert.match(ctx, /Same name only; the structure differs/);
});

test("post-edit: framework-convention names (getServerSideProps, Page...) never match by name", () => {
  const { root, data } = freshProject();
  const f = path.join(root, "apps/blog/src/page.ts");
  fs.writeFileSync(f, "export async function getServerSideProps() { return { props: {} }; }\n");
  assert.equal(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } }).stdout, "");
});

test("search_names finds public exports by concept words, with the import line", async () => {
  const { searchNames } = await import("../src/lookup.js");
  const { index } = loadOut(path.join(out1, "r"));
  const [hit] = searchNames(index, "format currency");
  assert.equal(hit.import, 'import { formatCurrency } from "@acme/utils"');
  assert.ok(searchNames(index, "debounce").some((h) => h.where.includes("apps/admin/src/useDebounce.ts")));
});

// ---------- v0.4: similar copies and module copies ----------
test("similar but not identical copies across packages are grouped", () => {
  const f = report.findings.find((x) => x.kind === "duplicate.similar" && x.evidence.members.some((m) => m.name === "getMe"));
  assert.ok(f, "getMe copies not grouped");
  assert.equal(f.class, "manual-review");
  assert.deepEqual(f.evidence.packages.sort(), ["admin", "shop"]);
  assert.ok(f.evidence.pairs[0].similarity >= 0.8 && f.evidence.pairs[0].similarity < 1);
});

test("a copied module is reported as one module, not function by function", () => {
  const f = report.findings.find((x) => x.kind === "duplicate.module");
  assert.ok(f, "module copy not reported");
  assert.deepEqual(f.locations.map((l) => l.file), ["acme/apps/admin/src/follow.mappers.ts", "acme/apps/blog/src/follow.mappers.ts"]);
  assert.ok(f.evidence.files[0].definitions.includes("RELATION_BY_TYPE"));
  assert.equal(f.evidence.pairs[0].shared, 4);
});

// ---------- v1.0 ----------
// 3.0: a finding's key is its identity; line shifts change the id, not the key.
test("finding key survives line shifts above the copy; id does not", () => {
  const { root } = freshProject();
  const r1 = runScan([root], { out: path.join(tmp("al-key1-"), "r") }).report;
  const f = path.join(root, "apps/shop/src/price.ts");
  fs.writeFileSync(f, "\n\n\n" + fs.readFileSync(f, "utf8"));
  const r2 = runScan([root], { out: path.join(tmp("al-key2-"), "r") }).report;
  const pick = (r) => r.findings.find((x) => x.kind === "duplicate.reinvents-library-export" && x.locations[0].file.endsWith("apps/shop/src/price.ts"));
  assert.notEqual(pick(r1).id, pick(r2).id);
  assert.equal(pick(r1).key, pick(r2).key);
  assert.equal(new Set(r1.findings.map((x) => x.key)).size, r1.findings.length, "keys are unique");
  // Every other finding keeps its key too.
  assert.deepEqual(r2.findings.map((x) => x.key).sort(), r1.findings.map((x) => x.key).sort());
});

test("finding key changes when the code it is about changes", () => {
  const { root } = freshProject();
  const r1 = runScan([root], { out: path.join(tmp("al-key3-"), "r") }).report;
  const pick = (r) => r.findings.find((x) => x.kind === "duplicate.cross-package" && x.evidence.members.some((m) => m.name === "useDebounce"));
  const f = path.join(root, "apps/shop/src/hooks.ts");
  // Renaming a local and adding a comment is the same code: same key.
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\bhandle\b/g, "h").replace("useEffect(() => {", "useEffect(() => { // debounce"));
  const r2 = runScan([root], { out: path.join(tmp("al-key4-"), "r") }).report;
  assert.equal(pick(r2).key, pick(r1).key);
  // A type change keeps it a (near) copy, with the same anchor and a new key.
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("delay: number", "delay: number | undefined"));
  const r3 = runScan([root], { out: path.join(tmp("al-key5-"), "r") }).report;
  assert.equal(pick(r3).evidence.match, "near");
  assert.equal(pick(r3).anchor, pick(r1).anchor);
  assert.notEqual(pick(r3).key, pick(r1).key);
});

// 3.1: incremental analysis must be indistinguishable from a full scan.
test("incremental rebuild (oldProgram + SourceFile reuse) equals a full scan after edits", async () => {
  const { analyze } = await import("../src/analyze.js");
  const { stableStringify } = await import("../src/report.js");
  const { root } = freshProject();
  const cache = new Map();
  const first = withWritesForbidden(() => analyze([root], {}, { sourceFileCache: cache }));
  assert.equal(first.incremental.reused, 0);
  // Edit one file, add a copy, delete another file.
  const price = path.join(root, "apps/shop/src/price.ts");
  fs.writeFileSync(price, fs.readFileSync(price, "utf8").replace("formatPrice", "formatPriceTag"));
  fs.copyFileSync(path.join(root, "apps/shop/src/hooks.ts"), path.join(root, "apps/blog/src/hooks.ts"));
  fs.rmSync(path.join(root, "apps/admin/src/pages/reports.ts"));
  const inc = withWritesForbidden(() => analyze([root], {}, { oldProgram: first.program, sourceFileCache: cache }));
  const full = withWritesForbidden(() => analyze([root], {}));
  assert.equal(stableStringify(inc.report), stableStringify(full.report));
  assert.equal(stableStringify(inc.index, 0), stableStringify(full.index, 0));
  assert.equal(inc.incremental.parsed, 2, "only the edited and the new file are parsed again");
  assert.ok(inc.incremental.reused > 20);
  assert.ok(inc.report.findings.some((f) => f.kind === "duplicate.cross-package" && f.locations.some((l) => l.file.endsWith("apps/blog/src/hooks.ts"))));
});

test("session start reuses the scan when nothing changed, and rescans after an edit", () => {
  const { root, data } = freshProject();
  const log = () => fs.readFileSync(path.join(data, "hook-log.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.hook === "session-start");
  const first = hook("hook-session-start", root, data, { source: "startup" }).stdout;
  const t0 = Date.now();
  const second = hook("hook-session-start", root, data, { source: "startup" }).stdout;
  const ms = Date.now() - t0;
  assert.equal(second, first);
  assert.deepEqual(log().map((e) => e.cached), [false, true]);
  assert.ok(ms < 2000, `second SessionStart took ${ms} ms`);
  // An edit seen by the post-edit hook marks the index stale: no reuse.
  const f = path.join(root, "apps/blog/src/extra.ts");
  fs.writeFileSync(f, "export const x = 1;\n");
  hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } });
  hook("hook-session-start", root, data, { source: "startup" });
  assert.equal(log().pop().cached, false);
});

// 3.2: similar (not identical) code is reported on edit and by find_equivalent.
const GET_ME_VARIANT = `export async function getMe(token: string, baseUrl: string) {
  const url = baseUrl.concat("/users/me");
  const response = await fetch(url, { headers: { Authorization: \`Bearer \${token}\` } });
  if (!response.ok) {
    throw new Error("Could not load user");
  }
  const data = await response.json();
  return { id: data.id, name: data.name, email: data.email, avatar: data.avatar, roles: data.roles };
}
`;

test("post-edit: code similar to copies in two other apps gets the 'similar, not identical' rule", () => {
  const { root, data } = freshProject();
  hook("hook-session-start", root, data, { source: "startup" });
  const f = path.join(root, "apps/blog/src/user.ts");
  fs.writeFileSync(f, GET_ME_VARIANT);
  const ctx = JSON.parse(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /`getMe` \(line 1\) is similar, not identical, to `getMe` at acme\/apps\/admin\/src\/user\.ts:1 \(admin; 82% of the structure in common\)/);
  assert.match(ctx, /`getMe` \(line 1\) is similar, not identical, to `getMe` at acme\/apps\/shop\/src\/user\.ts:1 \(shop; 81% of the structure in common\)/);
  assert.match(ctx, /Similar is not the same: ast-layer rule for this case: compare/);
  assert.match(ctx, /rules 1 and 2 apply/);
  assert.doesNotMatch(ctx, /has the same name as existing/, "a similar match is not also reported as a same-name lead");
  const last = fs.readFileSync(path.join(data, "hook-log.jsonl"), "utf8").trim().split("\n").map(JSON.parse).pop();
  assert.equal(last.similar[0].unit, "getMe");
  assert.equal(last.similar[0].matches, 2);
});

test("find_equivalent: similar matches respect the literal guard and the package", async () => {
  const { similarOptions } = await import("../src/cli.js");
  const dir = path.join(out1, "r");
  const { index } = loadOut(dir);
  const opts = similarOptions(dir, report);
  const [r] = findEquivalents(index, GET_ME_VARIANT, { fileName: "user.ts", similar: opts });
  // 0.82 against admin's copy; shop's (0.81) also counts.
  assert.deepEqual(r.similar.map((u) => [u.package, u.similarity]), [["admin", 0.82], ["shop", 0.81]]);
  // Same shape, unrelated literals: not similar (the guard the scan uses).
  const other = GET_ME_VARIANT.replace(/"\/users\/me"/, '"/orders/list"').replace("Could not load user", "Orders failed").replace("Bearer ", "Token ");
  assert.deepEqual(findEquivalents(index, other, { fileName: "o.ts", similar: opts }), []);
  // Within the same package: not reported.
  const [inAdmin] = findEquivalents(index, GET_ME_VARIANT, { fileName: "user.ts", similar: opts, excludePackage: "admin" });
  assert.deepEqual(inAdmin.similar.map((u) => u.package), ["shop"]);
});

// v1.1: similarity that survives an added variable, and a lower bar for the same name.
const ACCOUNT = `const LOCALE_COOKIE = "NEXT_LOCALE";
const DEFAULT_LOCALE = "es";
const ACCOUNT_PATH = "/accounts/me";
type Req = { cookies: { get(name: string): { value: string } | undefined; toString(): string } };

export const loadAccount = async (request: Req) => {
  const locale = request.cookies.get(LOCALE_COOKIE)?.value || DEFAULT_LOCALE;
  const response = await fetch(\`\${process.env.API_URL}\${ACCOUNT_PATH}\`, {
    headers: {
      "Content-Type": "application/json",
      "Accept-Language": locale.toUpperCase(),
      Cookie: request.cookies.toString(),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw data;
  }
  return data;
};
`;
// The URL is built with new URL(...) instead of a template: one statement more, one argument different.
const ACCOUNT_URL_VARIANT = ACCOUNT.replace("  const response = await fetch(\`\${process.env.API_URL}\${ACCOUNT_PATH}\`, {", "  const url = new URL(ACCOUNT_PATH, process.env.API_URL);\n  const response = await fetch(url.toString(), {");

test("similarity: an added local variable does not renumber the rest of the function", async () => {
  const { fingerprintStandalone, jaccard } = await import("../src/fingerprint.js");
  const fp = (code) => fingerprintStandalone(code, "a.ts").find((u) => u.name === "loadAccount");
  const added = ACCOUNT.replace("  const locale =", "  const startedAt = Date.now();\n  const locale =");
  assert.ok(jaccard(fp(ACCOUNT).shingles, fp(added).shingles) >= 0.9);
  const variant = jaccard(fp(ACCOUNT).shingles, fp(ACCOUNT_URL_VARIANT).shingles);
  assert.ok(variant >= 0.6 && variant < 0.8, String(variant));
});

test("similarity: the same name needs 60% shared structure, other names 80%, in the scan and in lookups", async () => {
  const { similarOptions } = await import("../src/cli.js");
  const { root } = freshProject();
  fs.writeFileSync(path.join(root, "apps/shop/src/account.ts"), ACCOUNT);
  fs.writeFileSync(path.join(root, "apps/blog/src/account.ts"), ACCOUNT_URL_VARIANT);
  const dir = path.join(tmp("al-p13-"), "r");
  const r = runScan([root], { out: dir }).report;
  assert.equal(r.options.similarSameNameThreshold, 0.6);
  const g = r.findings.find((f) => f.kind === "duplicate.similar" && f.evidence.members.some((m) => m.name === "loadAccount"));
  assert.deepEqual(g.locations.map((l) => l.file), ["acme/apps/blog/src/account.ts", "acme/apps/shop/src/account.ts"]);
  assert.match(g.why, /share 64–64% of their structure/);
  const { index } = loadOut(dir);
  const opts = similarOptions(dir, r);
  const [hit] = findEquivalents(index, ACCOUNT_URL_VARIANT, { fileName: "account.ts", similar: opts, excludeFile: "acme/apps/blog/src/account.ts", excludePackage: "blog" });
  assert.deepEqual(hit.similar.map((u) => [u.package, u.similarity]), [["shop", 0.64]]);
  // Under another name the same code is below the 80% bar.
  const renamed = ACCOUNT_URL_VARIANT.replace("loadAccount", "fetchCurrentAccount");
  assert.deepEqual(findEquivalents(index, renamed, { fileName: "account.ts", similar: opts, excludeFile: "acme/apps/blog/src/account.ts", excludePackage: "blog" }), []);
  // Framework names (GET, default, Page...) never get the lower bar.
  const route = (code) => code.replace("export const loadAccount = async", "export const GET = async");
  fs.writeFileSync(path.join(root, "apps/shop/src/account.ts"), route(ACCOUNT));
  fs.writeFileSync(path.join(root, "apps/blog/src/account.ts"), route(ACCOUNT_URL_VARIANT));
  const r2 = runScan([root], { out: path.join(tmp("al-p13b-"), "r") }).report;
  assert.ok(!r2.findings.some((f) => f.kind === "duplicate.similar" && f.evidence.members.some((m) => m.name === "GET")));
});

// 3.3: architecture rules.
test("architecture rules: violations are manual-review findings; type-only and except are honored", () => {
  const v = report.findings.filter((f) => f.kind === "architecture.rule-violation");
  const byRule = Object.fromEntries(v.map((f) => [f.evidence.rule.id, f]));
  assert.deepEqual(Object.keys(byRule).sort(), ["apps-no-cross-import", "libs-no-app-types", "no-legacy"]);
  assert.ok(v.every((f) => f.class === "manual-review"));
  assert.equal(byRule["apps-no-cross-import"].locations[0].file, "acme/apps/blog/src/nav.ts");
  assert.match(byRule["apps-no-cross-import"].why, /Apps do not import from each other; use @acme\/ui\./);
  // packages/utils imports a type from admin: only the rule with includeTypeOnly sees it.
  assert.equal(byRule["libs-no-app-types"].evidence.typeOnly, true);
  // mobile and shop are excepted from no-legacy; blog is not.
  assert.equal(byRule["no-legacy"].locations[0].file, "acme/apps/blog/src/today.ts");
  assert.ok(report.limits.some((l) => /^Architecture rules: 5 rule\(s\)/.test(l)));
});

test("architecture rules: globs, toSpecifier and allow rules", async () => {
  const { brokenRules, compileGlob } = await import("../src/rules.js");
  assert.ok(compileGlob("@acme/utils/src/**").test("@acme/utils/src/money/currency"));
  assert.ok(compileGlob("apps/**/x").test("apps/x") && compileGlob("apps/**/x").test("apps/a/b/x") && !compileGlob("apps/**/x").test("apps/ax"));
  assert.ok(!compileGlob("apps/*").test("apps/a/b"));
  assert.ok(compileGlob("apps/?/x*").test("apps/a/xyz") && !compileGlob("apps/?/x*").test("apps/ab/x"));
  assert.ok(compileGlob("**/*.css").test("a/b.css") && compileGlob("**/*.css").test("b.css") && !compileGlob("**/*.css").test("a/b.cssx"));
  // Patterns come from the analyzed repo: a hostile one must not hang the scan.
  const t0 = Date.now();
  assert.equal(compileGlob("**/".repeat(40) + "*x").test("a/".repeat(200) + "b"), false);
  assert.equal(compileGlob("*a".repeat(40) + "b").test("a".repeat(300)), false);
  assert.ok(Date.now() - t0 < 1000);
  const rules = [
    { root: "r", id: "ui-no-utils-internals", from: "@acme/ui", toSpecifier: "@acme/utils/src/**", allow: false },
    { root: "r", id: "no-lodash", from: "*", to: "lodash", allow: false },
    { root: "r", id: "lodash-ok-in-scripts", from: "tools/*", to: "lodash", allow: true },
  ];
  const imp = (from, spec, target) => ({ root: "r", from, spec, target, typeOnly: false });
  assert.deepEqual(brokenRules(rules, imp({ name: "@acme/ui", dir: "packages/ui" }, "@acme/utils/src/x", { name: "@acme/utils", dir: "packages/utils" })).map((r) => r.id), ["ui-no-utils-internals"]);
  assert.deepEqual(brokenRules(rules, imp({ name: "web", dir: "apps/web" }, "lodash/get", { name: "lodash" })).map((r) => r.id), ["no-lodash"]);
  assert.deepEqual(brokenRules(rules, imp({ name: "s", dir: "tools/s" }, "lodash", { name: "lodash" })), []);
});

test("architecture rules: a malformed rules file is a limit, not a crash", () => {
  const { root } = freshProject();
  fs.writeFileSync(path.join(root, "ast-layer.rules.json"), JSON.stringify({ rules: [{ id: "x", from: "apps/*", allow: false }], extra: 1 }));
  const r = runScan([root], { out: path.join(tmp("al-rules-"), "r") }).report;
  assert.ok(r.limits.some((l) => /ast-layer\.rules\.json does not match the rules format/.test(l)), r.limits.join("\n"));
  assert.equal(r.findings.filter((f) => f.kind === "architecture.rule-violation").length, 0);
  fs.writeFileSync(path.join(root, "ast-layer.rules.json"), "{ not json");
  assert.ok(runScan([root], { out: path.join(tmp("al-rules2-"), "r") }).report.limits.some((l) => /is not valid JSON/.test(l)));
});

test("architecture rules: the session note lists them; the post-edit hook flags a new forbidden import", () => {
  const { root, data } = freshProject();
  const ctx = JSON.parse(hook("hook-session-start", root, data, { source: "startup" }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /- apps-no-cross-import \(apps\/\* ↛ apps\/\*\) "Apps do not import from each other; use @acme\/ui\.": 1 violation/);
  assert.match(ctx, /No violations: ui-no-utils-internals/);
  const f = path.join(root, "apps/shop/src/admin-route.ts");
  fs.writeFileSync(f, 'import { ADMIN_ROUTE } from "admin";\nimport type { AdminConfig } from "admin";\nexport const r = (c: AdminConfig) => ADMIN_ROUTE + c.locale;\n');
  // shop declares "admin" as a federation remote: the runtime import is federated, so `to` rules do not apply to it.
  assert.equal(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: f } }).stdout, "");
  const g = path.join(root, "apps/blog/src/more.ts");
  fs.writeFileSync(g, 'import { ADMIN_ROUTE } from "admin";\nexport const more = () => ADMIN_ROUTE;\n');
  const out = JSON.parse(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: g } }).stdout).hookSpecificOutput.additionalContext;
  assert.match(out, /`"admin"` \(line 1\) breaks architecture rule apps-no-cross-import/);
  assert.match(out, /remove this import/);
  // The known violation in nav.ts is not repeated when the file is edited without changing it.
  assert.equal(hook("hook-post-edit", root, data, { tool_name: "Edit", tool_input: { file_path: path.join(root, "apps/blog/src/nav.ts") } }).stdout, "");
});

// 3.4: recorded decisions.
const scanDirOf = (data) => path.join(data, "scans", fs.readdirSync(path.join(data, "scans"))[0]);
const cli = (args, root, data) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_DATA: data }, encoding: "utf8" });
const sessionNote = (root, data) => JSON.parse(hook("hook-session-start", root, data, { source: "startup" }).stdout).hookSpecificOutput.additionalContext;

test("decisions: a decision silences the finding in the session note; editing the copy brings it back as outdated", () => {
  const { root, data } = freshProject();
  assert.match(sessionNote(root, data), /useDebounce — copies in admin, shop/);
  const out = scanDirOf(data);
  const f = loadOut(out).report.findings.find((x) => x.kind === "duplicate.cross-package" && x.evidence.members.some((m) => m.name === "useDebounce"));
  const r = cli(["decide", f.key, "--decision", "keep-separate", "--note", "each app owns its hooks", "--out", out], root, data);
  assert.equal(r.status, 0, r.stderr);
  const file = JSON.parse(fs.readFileSync(path.join(root, "ast-layer.decisions.json"), "utf8"));
  assert.deepEqual(file.decisions.map((d) => [d.findingKey, d.anchor, d.decision, d.note]), [[f.key, f.anchor, "keep-separate", "each app owns its hooks"]]);
  const note = sessionNote(root, data);
  assert.doesNotMatch(note, /useDebounce/);
  assert.match(note, /\(1 more with a recorded decision, not listed\)/);
  const rep = loadOut(out).report;
  const decided = rep.findings.find((x) => x.key === f.key);
  assert.equal(decided.status, "decided");
  assert.deepEqual(decided.decision, { decision: "keep-separate", note: "each app owns its hooks", scope: "repo" });
  assert.ok(rep.limits.some((l) => /^Decisions: 1 recorded .* 1 apply/.test(l)));
  // Edit the copy: the key changes, the decision no longer applies.
  const h = path.join(root, "apps/shop/src/hooks.ts");
  fs.writeFileSync(h, fs.readFileSync(h, "utf8").replace("delay: number", "delay: number | undefined"));
  const again = sessionNote(root, data);
  assert.match(again, /useDebounce — copies in admin, shop; no library copy \[manual-review: do not add another copy\] \(a recorded "keep-separate" decision no longer applies: the code changed\)/);
  const back = loadOut(out).report.findings.find((x) => x.anchor === f.anchor);
  assert.equal(back.status, "observation");
  assert.equal(back.previousDecision.outdated, true);
});

test("decisions: the edit warning carries the decision; findings hides decided ones unless asked", async () => {
  const { root, data } = freshProject();
  sessionNote(root, data);
  const out = scanDirOf(data);
  const f = loadOut(out).report.findings.find((x) => x.kind === "duplicate.cross-package" && x.evidence.members.some((m) => m.name === "useDebounce"));
  cli(["decide", f.key, "--decision", "keep-separate", "--out", out], root, data);
  sessionNote(root, data);
  const { filterFindings } = await import("../src/cli.js");
  const rep = loadOut(out).report;
  assert.equal(filterFindings(rep, { name: "useDebounce" }).findings.filter((x) => x.kind === "duplicate.cross-package").length, 0);
  assert.equal(filterFindings(rep, { name: "useDebounce", includeDecided: true }).findings.filter((x) => x.kind === "duplicate.cross-package").length, 1);
  const g = path.join(root, "apps/blog/src/useDebounce.ts");
  fs.copyFileSync(path.join(root, "apps/shop/src/hooks.ts"), g);
  const ctx = JSON.parse(hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: g } }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /A recorded decision covers the existing copies \("keep-separate"\): do not propose extracting or merging them again/);
});

test("decisions: user scope is stored outside the repo; a malformed file is a limit", () => {
  const { root, data } = freshProject();
  sessionNote(root, data);
  const out = scanDirOf(data);
  const f = loadOut(out).report.findings.find((x) => x.kind === "duplicate.similar");
  assert.equal(cli(["decide", f.key, "--decision", "false-positive", "--scope", "user", "--out", out], root, data).status, 0);
  assert.equal(fs.existsSync(path.join(root, "ast-layer.decisions.json")), false);
  assert.equal(fs.readdirSync(path.join(data, "decisions")).length, 1);
  assert.doesNotMatch(sessionNote(root, data), /getMe/);
  fs.writeFileSync(path.join(root, "ast-layer.decisions.json"), "{}");
  const rep = runScan([root], { out: path.join(tmp("al-dec-"), "r") }).report;
  assert.ok(rep.limits.some((l) => /ast-layer\.decisions\.json does not match the decisions format/.test(l)), rep.limits.join("\n"));
  // A malformed file is never overwritten.
  const bad = cli(["decide", f.key, "--decision", "keep-separate", "--out", out], root, data);
  assert.notEqual(bad.status, 0);
  assert.equal(fs.readFileSync(path.join(root, "ast-layer.decisions.json"), "utf8"), "{}");
});

// 3.5: PR mode.
function gitRepoFromFixture() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "al-pr-"));
  const root = path.join(proj, "acme");
  fs.cpSync(FIXTURE, root, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "base");
  return { root, g };
}

test("pr --base: a copy added on a branch is the only new finding", () => {
  const { root, g } = gitRepoFromFixture();
  g("checkout", "-qb", "feature");
  fs.copyFileSync(path.join(root, "apps/shop/src/hooks.ts"), path.join(root, "apps/blog/src/useDebounce.ts"));
  g("add", "-A"); g("commit", "-qm", "copy");
  const before = treeHash(root);
  const run = (...a) => spawnSync(process.execPath, [CLI, "pr", root, "--base", "main", ...a], { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: "" } });
  const j = run("--format", "json");
  assert.equal(j.status, 0, j.stderr);
  const r = JSON.parse(j.stdout);
  assert.equal(r.newFindings, 1, JSON.stringify(r.findings.map((f) => [f.kind, f.locations[0].file, f.prReason])));
  assert.equal(r.findings[0].kind, "duplicate.cross-package");
  assert.ok(r.findings[0].locations.some((l) => l.file === "acme/apps/blog/src/useDebounce.ts"));
  assert.equal(r.changedFiles, 1);
  const md = run();
  assert.match(md.stdout, /^## ast-layer: 1 finding\(s\) in this change/);
  assert.match(md.stdout, /### Manual review: a person decides \(1\)/);
  assert.match(md.stdout, /acme\/apps\/blog\/src\/useDebounce\.ts:3/);
  assert.equal(run("--fail-on", "manual-review").status, 1);
  assert.equal(run("--fail-on", "provable").status, 0);
  assert.equal(treeHash(root), before, "PR mode does not touch the repository");
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("ast-layer-pr-")).filter((d) => { try { return fs.statSync(path.join(os.tmpdir(), d)).mtimeMs > Date.now() - 60000; } catch { return false; } }), [], "the base copy is removed");
});

test("security: a ref that looks like an option is refused, and --out never replaces an unrelated folder", async () => {
  const { prFindings } = await import("../src/pr.js");
  const { root } = freshProject();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: root });
  const target = path.join(tmp("al-sec-"), "pwned.tar");
  await assert.rejects(prFindings(root, { base: `--output=${target}` }), /not a git ref/);
  assert.equal(fs.existsSync(target), false);
  const folder = tmp("al-notout-");
  fs.writeFileSync(path.join(folder, "notes.txt"), "keep me");
  assert.throws(() => runScan([root], { out: folder }), /refusing to replace/);
  assert.equal(fs.readFileSync(path.join(folder, "notes.txt"), "utf8"), "keep me");
  // A tracked symlink to a file outside the root is not read.
  const outside = path.join(tmp("al-outside-"), "secret.ts");
  fs.writeFileSync(outside, "export const SECRET_VALUE_FROM_OUTSIDE = () => 1;\n");
  fs.symlinkSync(outside, path.join(root, "apps/blog/src/linked.ts"));
  execFileSync("git", ["add", "-A"], { cwd: root });
  const { discover } = await import("../src/discover.js");
  assert.ok(!discover([root]).files.some((f) => f.key.endsWith("linked.ts")));
  // An empty directory and a previous report are fine.
  const empty = tmp("al-empty-");
  runScan([root], { out: empty });
  runScan([root], { out: empty });
  assert.ok(fs.existsSync(path.join(empty, "report.json")));
});

test("pr --baseline: compares against a saved report; an old report without keys is refused", () => {
  const { root } = freshProject();
  const base = path.join(tmp("al-bl-"), "r");
  runScan([root], { out: base });
  fs.copyFileSync(path.join(root, "apps/shop/src/hooks.ts"), path.join(root, "apps/blog/src/useDebounce.ts"));
  const r = spawnSync(process.execPath, [CLI, "pr", root, "--baseline", path.join(base, "report.json"), "--format", "json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).newFindings, 1);
  const old = path.join(base, "old.json");
  fs.writeFileSync(old, JSON.stringify({ tool: { schema: 1 }, findings: [{ id: "x" }] }));
  const bad = spawnSync(process.execPath, [CLI, "pr", root, "--baseline", old], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no finding keys/);
});

test("architecture rules: a provable replacement whose import breaks a rule is downgraded to manual-review", () => {
  const { root } = freshProject();
  const rulesFile = path.join(root, "ast-layer.rules.json");
  fs.writeFileSync(rulesFile, fs.readFileSync(rulesFile, "utf8").replace('"except": ["apps/mobile", "apps/shop"]', '"except": ["apps/mobile"]'));
  const r = runScan([root], { out: path.join(tmp("al-rdown-"), "r") }).report;
  const f = r.findings.find((x) => x.kind === "duplicate.reinvents-library-export" && x.locations[0].file.endsWith("apps/shop/src/legacy/date.ts"));
  assert.equal(f.class, "manual-review");
  assert.deepEqual(f.evidence.brokenRules, ["no-legacy"]);
  assert.match(f.nextAction, /would break architecture rule "no-legacy"/);
  assert.equal(r.summary.byClass.provable, 2);
});

// 3.6: verified codemods.
test("propose_fix: every provable fix verifies, applies with Edit, adds no diagnostic and removes the finding", async () => {
  const { proposeFix, diagnosticsOf } = await import("../src/fix.js");
  const { analyze } = await import("../src/analyze.js");
  const { root } = freshProject();
  const before = withWritesForbidden(() => analyze([root]));
  const provable = before.report.findings.filter((f) => f.class === "provable");
  assert.equal(provable.length, 3);
  const before0 = treeHash(root);
  const results = provable.map((f) => withWritesForbidden(() => proposeFix([root], f.key)));
  assert.equal(treeHash(root), before0, "propose_fix never writes");
  for (const r of results) {
    assert.equal(r.verified, true, `${r.finding.kind}: ${r.reason}`);
    assert.match(r.diff, /^--- a\//);
    // Apply exactly as an agent would with Edit: each oldString is unique in its file.
    for (const e of r.edits) {
      const text = fs.readFileSync(e.file, "utf8");
      assert.equal(text.split(e.oldString).length, 2, "oldString is unique");
      fs.writeFileSync(e.file, text.replace(e.oldString, e.newString));
    }
  }
  const after = withWritesForbidden(() => analyze([root]));
  // tsc: no file gained a diagnostic.
  for (const f of before.disc.files) {
    const count = (p) => { const m = new Map(); for (const d of diagnosticsOf(p, f.abs)) m.set(d.id, (m.get(d.id) || 0) + 1); return m; };
    const b = count(before.program);
    for (const [id, n] of count(after.program)) assert.ok(n <= (b.get(id) || 0), `${f.key} gained: ${id}`);
  }
  const keys = new Set(after.report.findings.map((f) => f.key));
  for (const f of provable) assert.ok(!keys.has(f.key), `${f.kind} still reported`);
  const beforeKeys = new Set(before.report.findings.map((f) => f.key));
  assert.deepEqual(after.report.findings.filter((f) => !beforeKeys.has(f.key)).map((f) => f.kind), []);
  assert.match(fs.readFileSync(path.join(root, "apps/shop/src/price.ts"), "utf8"), /^export \{ formatCurrency as formatPrice \} from "@acme\/utils";\n$/);
  assert.match(fs.readFileSync(path.join(root, "apps/admin/src/Dashboard.tsx"), "utf8"), /^import \{ formatCurrency \} from "@acme\/utils";/);
});

test("propose_fix: a copy used in its own file is imported, and re-exported under its local name", async () => {
  const { proposeFix } = await import("../src/fix.js");
  const { root } = freshProject();
  const p = path.join(root, "apps/shop/src/price.ts");
  fs.writeFileSync(p, `import { clamp } from "@acme/theme";\n\n${fs.readFileSync(p, "utf8")}\nexport const priceLabel = (n: number) => "Price: " + formatPrice(clamp(n, 0, 1e9));\n`);
  const f = runScan([root], { out: path.join(tmp("al-fx-"), "r") }).report.findings.find((x) => x.kind === "duplicate.reinvents-library-export" && x.locations[0].file.endsWith("shop/src/price.ts"));
  // The file now imports @acme/theme, whose entry has a side-effect import: still provable for @acme/utils.
  assert.equal(f.class, "provable");
  const r = withWritesForbidden(() => proposeFix([root], f.key));
  assert.equal(r.verified, true, r.reason);
  assert.match(r.diff, /\+import \{ formatCurrency as formatPrice \} from "@acme\/utils";/);
  assert.match(r.diff, /\+export \{ formatPrice \};/);
});

test("propose_fix: removing the copy from a copied module shrinks the module finding and still verifies", async () => {
  const { proposeFix } = await import("../src/fix.js");
  const { root } = freshProject();
  const helpers = [
    "export const toCents = (n: number) => Math.round(n * 100);",
    "export const fromCents = (c: number) => c / 100;",
    "export function addTax(n: number, rate: number) { return n + n * rate; }",
    "export function isFree(n: number) { return n === 0 || Number.isNaN(n); }",
    "export const ZERO = { amount: 0, currency: \"USD\" } as const;",
    "export function roundTo(n: number, d: number) { const f = 10 ** d; return Math.round(n * f) / f; }",
  ].join("\n") + "\n";
  for (const rel of ["packages/utils/src/money/currency.ts", "apps/shop/src/price.ts"]) fs.appendFileSync(path.join(root, rel), "\n" + helpers);
  const r0 = runScan([root], { out: path.join(tmp("al-fxm-"), "r") }).report;
  const mod = r0.findings.find((x) => x.kind === "duplicate.module" && x.locations.some((l) => l.file.endsWith("shop/src/price.ts")));
  assert.ok(mod, "the copied module is reported");
  const f = r0.findings.find((x) => x.kind === "duplicate.reinvents-library-export" && x.locations[0].file.endsWith("shop/src/price.ts"));
  assert.equal(f.class, "provable");
  const r = withWritesForbidden(() => proposeFix([root], f.key));
  assert.equal(r.verified, true, r.reason);
  assert.deepEqual(r.newFindings, []);
  assert.deepEqual(r.shrunkFindings.map((x) => [x.kind, x.previousKey]), [["duplicate.module", mod.key]]);
  assert.match(r.reason, /still reported, smaller \(duplicate\.module\)/);
});

test("propose_fix: a broken change is reported as not verified; non-provable findings are refused", async () => {
  const { proposeFix, verifyEdits } = await import("../src/fix.js");
  const { analyze } = await import("../src/analyze.js");
  const { root } = freshProject();
  const before = withWritesForbidden(() => analyze([root]));
  const abs = path.join(root, "apps/shop/src/price.ts");
  const text = fs.readFileSync(abs, "utf8");
  // Forced failure: import a name the library does not export, and drop the local definition.
  const broken = `export { formatMoney as formatPrice } from "@acme/utils";\n`;
  const r = withWritesForbidden(() => verifyEdits([root], before, [{ abs, key: "acme/apps/shop/src/price.ts", rel: "apps/shop/src/price.ts", before: text, after: broken }], { expectGone: before.report.findings.find((f) => f.locations[0].file.endsWith("shop/src/price.ts")).key }));
  assert.equal(r.verified, false);
  assert.match(r.reason, /NOT verified: .*new TypeScript diagnostic/);
  assert.ok(r.newDiagnostics.some((d) => d.file === "acme/apps/shop/src/price.ts" && /formatMoney/.test(d.message)), JSON.stringify(r.newDiagnostics));
  const ag = before.report.findings.find((f) => f.class === "agent-guided" && f.kind === "duplicate.reinvents-library-export");
  const refused = withWritesForbidden(() => proposeFix([root], ag.id));
  assert.equal(refused.supported, false);
  assert.match(refused.reason, /only provable findings/);
});

// 3.7: CSS and i18n.
test("css: same custom properties in two packages are one finding that names the shared home", () => {
  const f = report.findings.find((x) => x.kind === "css.duplicate-token");
  assert.equal(f.class, "manual-review");
  assert.deepEqual(f.evidence.tokens.map((t) => t.name), ["--color-primary", "--color-text"]);
  assert.deepEqual(f.evidence.home, ["@acme/theme"]);
  assert.deepEqual(f.locations.map((l) => `${l.file}:${l.line}`), ["acme/apps/shop/src/styles/tokens.css:2", "acme/packages/theme/src/theme.css:2"]);
  assert.equal(report.findings.filter((x) => x.kind === "css.duplicate-token").length, 1, "--shop-accent and --radius-md are not copies");
});

test("css: identical rule blocks across CSS and SCSS are found after normalization; resets are not", () => {
  const blocks = report.findings.filter((x) => x.kind === "css.duplicate-rule-block");
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].evidence.blocks[0].selectors.map((x) => x.split(" (")[0]), [".panel", ".box"]);
  assert.ok(!JSON.stringify(blocks).includes('"* '), "the `*` reset is skipped");
});

test("i18n: same-language locale files sharing most messages across packages", () => {
  const [f] = report.findings.filter((x) => x.kind === "i18n.duplicate-messages");
  assert.equal(f.evidence.language, "es");
  assert.equal(f.evidence.pairs[0].shared, 12);
  assert.deepEqual(f.locations.map((l) => l.file), ["acme/apps/blog/src/i18n/es.json", "acme/apps/shop/src/locales/es.json"]);
  assert.ok(report.limits.some((l) => /^Styles and messages: 3 CSS\/SCSS file\(s\).* 3 locale JSON file\(s\)/.test(l)));
});

test("css/i18n: the session note has one aggregated line per kind and stays within budget", () => {
  const { root, data } = freshProject();
  const ctx = JSON.parse(hook("hook-session-start", root, data, { source: "startup" }).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /- CSS custom properties redefined with the same value: 1 group\(s\), 2 token\(s\) \(e\.g\. --color-primary, --color-text\)/);
  assert.match(ctx, /- Identical CSS rule blocks: 1 block\(s\)/);
  assert.match(ctx, /- Copied locale messages: 1 group\(s\) of same-language files \(es\)/);
  assert.ok(ctx.length <= 3800, String(ctx.length));
});

// 3.8: local telemetry.
test("stats: sessions, warnings by type, and whether each warned copy was removed or kept", () => {
  const { root, data } = freshProject();
  hook("hook-session-start", root, data, { source: "startup" });
  hook("hook-session-start", root, data, { source: "startup" });
  // A copy the agent then removes (warning followed)...
  const a = path.join(root, "apps/blog/src/useDebounce.ts");
  fs.copyFileSync(path.join(root, "apps/shop/src/hooks.ts"), a);
  hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: a } });
  fs.writeFileSync(a, "export { useDebounce } from \"../../shop/src/hooks\";\n");
  hook("hook-post-edit", root, data, { tool_name: "Edit", tool_input: { file_path: a } });
  // ...one it keeps (no later edit: checked on disk)...
  const b = path.join(root, "apps/blog/src/user.ts");
  fs.writeFileSync(b, GET_ME_VARIANT);
  hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: b } });
  // ...and a forbidden import.
  const c = path.join(root, "apps/blog/src/more.ts");
  fs.writeFileSync(c, 'import { ADMIN_ROUTE } from "admin";\nexport const m = () => ADMIN_ROUTE;\n');
  hook("hook-post-edit", root, data, { tool_name: "Write", tool_input: { file_path: c } });
  const r = spawnSync(process.execPath, [CLI, "stats", "--json", "--since", "1h"], { env: { ...process.env, CLAUDE_PLUGIN_DATA: data }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(r.stdout);
  assert.equal(st.sessions, 2);
  assert.equal(st.sessionsReusingScan, 1);
  assert.equal(st.warningsByType.structural, 1);
  assert.equal(st.warningsByType.similar, 1);
  assert.ok(st.warningsByType["architecture-rule"] >= 1);
  assert.deepEqual(st.details.map((d) => [d.unit, d.outcome]), [["useDebounce", "warning followed"], ["getMe", "copy kept"]]);
  assert.deepEqual(st.outcomes, { followed: 1, kept: 1, unknown: 0 });
  const text = spawnSync(process.execPath, [CLI, "stats"], { env: { ...process.env, CLAUDE_PLUGIN_DATA: data }, encoding: "utf8" }).stdout;
  assert.match(text, /nothing is sent anywhere/);
  assert.match(text, /1 warning followed \(the unit is gone\), 1 copy kept/);
});
