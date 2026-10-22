// Verified codemods for provable findings. The change is computed from facts
// the analysis already has and edited at AST node positions (never regex). It
// is verified without touching disk, against a program with the edited files
// overlaid in memory: the edited files and their importers may not gain any
// syntactic or semantic diagnostic, and a re-analysis must drop the finding
// without producing a different one. Nothing is ever written: the agent
// applies the returned diff itself, and only when `verified` is true.
import ts from "typescript";
import { analyze } from "./analyze.js";
import { collectUnits } from "./fingerprint.js";

const K = ts.SyntaxKind;
export const FIXABLE = ["duplicate.reinvents-library-export", "boundary.bypasses-package-entry"];

const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const colOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).character + 1;
const splitRef = (ref) => { const i = ref.lastIndexOf("#"); return [ref.slice(0, i), ref.slice(i + 1)]; };
const hasModifier = (n, kind) => Boolean(n.modifiers && n.modifiers.some((m) => m.kind === kind));

/**
 * Propose a verified fix for one finding (by id or key) of the current code of
 * `rootPaths`. `opts` must be the options of the scan the finding came from.
 */
export function proposeFix(rootPaths, findingRef, { opts = {}, ctx = {} } = {}) {
  const before = analyze(rootPaths, opts, ctx);
  const f = before.report.findings.find((x) => x.id === findingRef || x.key === findingRef);
  if (!f) return { supported: false, verified: false, reason: `no finding ${findingRef} in the current code; rescan and use a current id or key` };
  const finding = { id: f.id, key: f.key, kind: f.kind, class: f.class };
  if (!FIXABLE.includes(f.kind)) return { finding, supported: false, verified: false, reason: `propose_fix only handles ${FIXABLE.join(" and ")}` };
  if (f.class !== "provable") return { finding, supported: false, verified: false, reason: `this finding is ${f.class}; only provable findings get a verified fix, and the class is never upgraded` };
  const absOf = new Map(before.disc.files.map((x) => [x.key, x]));
  let gen;
  try { gen = f.kind === "boundary.bypasses-package-entry" ? fixBypass(before, f, absOf) : fixReinvention(before, f, absOf); }
  catch (e) { return { finding, supported: true, verified: false, reason: `could not generate the change: ${e.message}` }; }
  if (gen.unsupported) return { finding, supported: false, verified: false, reason: gen.unsupported };
  return { finding, supported: true, ...verifyEdits(rootPaths, before, gen.files, { opts, ctx, expectGone: f.key }) };
}

/**
 * Verify edited file contents against the current analysis `before`.
 * `files`: [{ abs, key, rel, before, after }]. Exported so a deliberately
 * broken edit can be checked to fail.
 */
export function verifyEdits(rootPaths, before, files, { opts = {}, ctx = {}, expectGone = null } = {}) {
  const overlay = new Map(files.map((x) => [x.abs, x.after]));
  const after = analyze(rootPaths, opts, { ...ctx, disc: before.disc, oldProgram: before.program, overlay });
  const keyOf = new Map(before.disc.files.map((x) => [x.abs, x.key]));
  const affected = new Set(files.map((x) => x.abs));
  for (const x of files) for (const imp of before.importers.get(x.abs) || []) affected.add(imp);
  const newDiagnostics = [];
  for (const abs of [...affected].sort()) {
    const counts = new Map();
    for (const d of diagnosticsOf(before.program, abs)) counts.set(d.id, (counts.get(d.id) || 0) + 1);
    for (const d of diagnosticsOf(after.program, abs)) {
      const n = counts.get(d.id) || 0;
      if (n) counts.set(d.id, n - 1); else newDiagnostics.push({ file: keyOf.get(abs) || abs, line: d.line, code: d.code, message: d.message });
    }
  }
  const beforeKeys = new Set(before.report.findings.map((x) => x.key));
  const afterKeys = new Set(after.report.findings.map((x) => x.key));
  const findingGone = expectGone ? !afterKeys.has(expectGone) : true;
  const brief = (x) => ({ kind: x.kind, key: x.key, class: x.class, where: `${x.locations[0].file}:${x.locations[0].line}`, why: x.why });
  const newFindings = []; const shrunkFindings = [];
  for (const x of after.report.findings) {
    if (beforeKeys.has(x.key)) continue;
    const was = before.report.findings.find((b) => b.kind === x.kind && b.anchor === x.anchor && shrinks(x, b));
    if (was) shrunkFindings.push({ ...brief(x), previousKey: was.key, previousWhy: was.why });
    else newFindings.push(brief(x));
  }
  const verified = !newDiagnostics.length && findingGone && !newFindings.length;
  const reasons = [];
  if (newDiagnostics.length) reasons.push(`${newDiagnostics.length} new TypeScript diagnostic(s)`);
  if (!findingGone) reasons.push("the finding is still reported after the change");
  if (newFindings.length) reasons.push(`the change creates ${newFindings.length} other finding(s)`);
  const shrunkNote = shrunkFindings.length ? ` ${shrunkFindings.length} existing finding(s) about the same code are still reported, smaller (${shrunkFindings.map((x) => x.kind).join(", ")}); that is not new duplication.` : "";
  return {
    verified,
    reason: verified ? `No new syntactic or semantic diagnostics in the edited files and their importers, the finding disappears and no other finding appears.${shrunkNote}` : `NOT verified: ${reasons.join("; ")}. Do not apply this diff.`,
    diff: files.map((x) => unifiedDiff(x.rel, x.before, x.after)).join(""),
    edits: files.flatMap((x) => editsFor(x)),
    checkedFiles: [...affected].map((a) => keyOf.get(a) || a).sort(),
    newDiagnostics, findingGone, newFindings, shrunkFindings,
  };
}

/**
 * `after` is `before` with less in it: same anchor (same members, files or
 * names), no more locations, and for module copies no pair sharing more
 * definitions than it did. Removing a copied definition from a copied module
 * changes the module finding's key ("4 of 4" becomes "3 of 4") without adding
 * duplication.
 */
function shrinks(after, before) {
  if (after.locations.length > before.locations.length) return false;
  const files = new Set(before.locations.map((l) => l.file));
  if (!after.locations.every((l) => files.has(l.file))) return false;
  if (after.kind !== "duplicate.module") return true;
  const pairKey = (p) => [p.a, p.b].sort().join("\0");
  const was = new Map((before.evidence.pairs || []).map((p) => [pairKey(p), p.shared]));
  return (after.evidence.pairs || []).every((p) => was.has(pairKey(p)) && p.shared <= was.get(pairKey(p)));
}

/** Syntactic and semantic diagnostics of one file, position-free so they can be compared across edits. */
export function diagnosticsOf(program, abs) {
  const sf = program.getSourceFile(abs);
  if (!sf) return [];
  return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    return { id: `${d.code}\0${message}`, code: d.code, message, line: d.file && d.start !== undefined ? lineOf(d.file, d.start) : null };
  });
}

function fileStyle(sf) {
  const imports = sf.statements.filter((s) => s.kind === K.ImportDeclaration);
  const q = imports.length && sf.text[imports[0].moduleSpecifier.getStart(sf)] === "'" ? "'" : '"';
  const semi = imports.length ? imports[0].getText(sf).trimEnd().endsWith(";") : true;
  return { q, semi: semi ? ";" : "" };
}

/** Where a new import line goes: after the last top-level import, or before the first statement after directives. */
function importInsertPos(sf) {
  const imports = sf.statements.filter((s) => s.kind === K.ImportDeclaration);
  if (imports.length) { const end = imports[imports.length - 1].end; return { pos: end, text: (t) => "\n" + t }; }
  const first = sf.statements.find((s) => !(s.kind === K.ExpressionStatement && ts.isStringLiteral(s.expression)));
  if (!first) return { pos: sf.text.length, text: (t) => (sf.text.endsWith("\n") || !sf.text ? "" : "\n") + t + "\n" };
  return { pos: first.getStart(sf), text: (t) => t + "\n\n" };
}

/** A statement's range including its JSDoc, its indentation and one line break after it. */
function statementRange(sf, st) {
  const text = sf.text;
  let start = st.getStart(sf, true);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start))) start = lineStart;
  let end = st.end;
  if (text.startsWith("\r\n", end)) end += 2; else if (text[end] === "\n") end += 1;
  // Do not leave two blank lines where the statement was.
  const prevBlank = start === 0 || text.slice(0, start).endsWith("\n\n");
  if (prevBlank) { if (text.startsWith("\r\n", end)) end += 2; else if (text[end] === "\n") end += 1; }
  return { start, end };
}

function applyEdits(text, edits) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Delete a local copy of a library export and import (and re-export) the library's. */
function fixReinvention(before, f, absOf) {
  const loc = f.locations[0];
  const info = absOf.get(loc.file);
  const program = before.program; const checker = program.getTypeChecker();
  const sf = program.getSourceFile(info.abs);
  const ev = f.evidence;
  const [spec, exportName] = splitRef(ev.library.public[0]);
  const unit = collectUnits(sf).find((u) => u.name === ev.local.name && lineOf(sf, u.bodyNode.getStart(sf)) === loc.line);
  if (!unit) throw new Error(`\`${ev.local.name}\` was not found at ${loc.file}:${loc.line}`);
  let stmt = unit.declNode;
  if (stmt.kind === K.VariableDeclaration) {
    const list = stmt.parent;
    if (list.declarations.length !== 1) return { unsupported: "the definition shares its `const`/`let` statement with other declarations; edit it by hand" };
    stmt = list.parent;
  }
  const isDefault = stmt.kind === K.ExportAssignment || hasModifier(stmt, K.DefaultKeyword);
  const exportedHere = isDefault || hasModifier(stmt, K.ExportKeyword);
  const local = unit.name === "default" ? null : unit.name;
  // Any reference to the definition outside its own statement (calls, `export { x }`, shorthand properties).
  const sym = unit.nameNode ? checker.getSymbolAtLocation(unit.nameNode) : null;
  let used = false;
  const visit = (n) => {
    if (used) return;
    if (n.pos >= stmt.pos && n.end <= stmt.end) return;
    if (n.kind === K.Identifier && sym) {
      let s = null;
      const p = n.parent;
      try {
        if (p && p.kind === K.ExportSpecifier && (p.propertyName || p.name) === n) s = checker.getExportSpecifierLocalTargetSymbol(p);
        else if (p && p.kind === K.ShorthandPropertyAssignment) s = checker.getShorthandAssignmentValueSymbol(p);
        else s = checker.getSymbolAtLocation(n);
      } catch {}
      if (s === sym) { used = true; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const { q, semi } = fileStyle(sf);
  const localName = local || (exportName === "default" ? "_default" : exportName);
  const named = (imported, as) => (imported === as ? imported : `${imported} as ${as}`);
  const edits = [];
  let replacement = "";
  if (exportedHere) {
    if (used) replacement = isDefault ? `export default ${localName}${semi}\n` : `export { ${localName} }${semi}\n`;
    else replacement = `export { ${named(exportName, isDefault ? "default" : localName)} } from ${q}${spec}${q}${semi}\n`;
  }
  const range = statementRange(sf, stmt);
  if (replacement) {
    // The re-export takes the statement's place, so the blank line that
    // separated it from the next statement must stay.
    range.end = Math.min(range.end, stmt.end + (sf.text.startsWith("\r\n", stmt.end) ? 2 : sf.text[stmt.end] === "\n" ? 1 : 0));
  }
  if (used) {
    const existing = sf.statements.find((s) => s.kind === K.ImportDeclaration && s.moduleSpecifier.text === spec && s.importClause && !s.importClause.isTypeOnly && s.importClause.namedBindings && s.importClause.namedBindings.kind === K.NamedImports && s.importClause.namedBindings.elements.length);
    if (existing && exportName !== "default") {
      const els = existing.importClause.namedBindings.elements;
      edits.push({ start: els[els.length - 1].end, end: els[els.length - 1].end, text: `, ${named(exportName, localName)}` });
    } else {
      const line = exportName === "default" ? `import ${localName} from ${q}${spec}${q}${semi}` : `import { ${named(exportName, localName)} } from ${q}${spec}${q}${semi}`;
      const at = importInsertPos(sf);
      if (at.pos >= range.start && at.pos <= range.end) replacement = line + "\n" + (replacement ? "\n" + replacement : "");
      else edits.push({ start: at.pos, end: at.pos, text: at.text(line) });
    }
  }
  edits.push({ start: range.start, end: range.end, text: replacement });
  return { files: [{ abs: info.abs, key: info.key, rel: info.rel, before: sf.text, after: applyEdits(sf.text, edits) }] };
}

/** Point a deep or relative import at the package's public entry. */
function fixBypass(before, f, absOf) {
  const loc = f.locations[0];
  const info = absOf.get(loc.file);
  const sf = before.program.getSourceFile(info.abs);
  let node = null;
  const find = (n) => {
    if (node) return;
    if ((n.kind === K.ImportDeclaration || n.kind === K.ExportDeclaration || n.kind === K.CallExpression || n.kind === K.ImportEqualsDeclaration) && lineOf(sf, n.getStart(sf)) === loc.line && colOf(sf, n.getStart(sf)) === loc.col) { node = n; return; }
    ts.forEachChild(n, find);
  };
  find(sf);
  if (!node) throw new Error(`no import statement at ${loc.file}:${loc.line}:${loc.col}`);
  const bs = f.evidence.bindings;
  const entry = splitRef(bs[0].availableFromEntry)[0];
  const lit = node.kind === K.CallExpression ? node.arguments[0] : node.kind === K.ImportEqualsDeclaration ? node.moduleReference.expression : node.moduleSpecifier;
  const edits = [{ start: lit.getStart(sf) + 1, end: lit.end - 1, text: entry }];
  const renamed = bs.some((b) => splitRef(b.availableFromEntry)[1] !== b.imported);
  if (renamed) {
    const exportOf = (b) => splitRef(b.availableFromEntry)[1];
    const as = (b) => (exportOf(b) === b.local ? b.local : `${exportOf(b)} as ${b.local}`);
    if (node.kind === K.ImportDeclaration && node.importClause && !(node.importClause.namedBindings && node.importClause.namedBindings.kind === K.NamespaceImport)) {
      const ic = node.importClause;
      const typeOnlyLocal = new Set(ic.namedBindings ? ic.namedBindings.elements.filter((e) => e.isTypeOnly).map((e) => e.name.text) : []);
      const def = bs.filter((b) => exportOf(b) === "default").map((b) => b.local);
      const rest = bs.filter((b) => exportOf(b) !== "default").map((b) => (typeOnlyLocal.has(b.local) ? "type " : "") + as(b));
      const clause = [...def, ...(rest.length ? [`{ ${rest.join(", ")} }`] : [])].join(", ");
      edits.push({ start: ic.isTypeOnly ? ic.getStart(sf) + "type ".length : ic.getStart(sf), end: ic.end, text: clause });
    } else if (node.kind === K.ExportDeclaration && node.exportClause && node.exportClause.kind === K.NamedExports) {
      edits.push({ start: node.exportClause.getStart(sf), end: node.exportClause.end, text: `{ ${bs.map(as).join(", ")} }` });
    } else return { unsupported: "the entry exports these bindings under other names and this import form cannot be rewritten safely; edit it by hand" };
  }
  return { files: [{ abs: info.abs, key: info.key, rel: info.rel, before: sf.text, after: applyEdits(sf.text, edits) }] };
}

/** Line operations from a to b: common prefix/suffix, LCS in between. */
function lineOps(A, B) {
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let ea = A.length, eb = B.length; while (ea > p && eb > p && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a = A.slice(p, ea), b = B.slice(p, eb);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = A.slice(0, p).map((l) => [" ", l]);
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([" ", a[i]]); i++; j++; }
    else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) { ops.push(["-", a[i]]); i++; }
    else { ops.push(["+", b[j]]); j++; }
  }
  for (const l of A.slice(ea)) ops.push([" ", l]);
  return ops;
}

function hunks(before, after, context) {
  const ops = lineOps(before.split("\n"), after.split("\n"));
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === " ") { i++; continue; }
    let start = Math.max(0, i - context); let end = i;
    while (end < ops.length) {
      if (ops[end][0] !== " ") { end++; continue; }
      let k = end; while (k < ops.length && ops[k][0] === " ") k++;
      if (k < ops.length && k - end <= 2 * context) { end = k; continue; }
      end = Math.min(ops.length, end + context); break;
    }
    const slice = ops.slice(start, end);
    const aStart = ops.slice(0, start).filter((o) => o[0] !== "+").length + 1;
    const bStart = ops.slice(0, start).filter((o) => o[0] !== "-").length + 1;
    out.push({ aStart, bStart, ops: slice });
    i = end;
  }
  return out;
}

export function unifiedDiff(rel, before, after, context = 3) {
  if (before === after) return "";
  const L = [`--- a/${rel}`, `+++ b/${rel}`];
  for (const h of hunks(before, after, context)) {
    const na = h.ops.filter((o) => o[0] !== "+").length; const nb = h.ops.filter((o) => o[0] !== "-").length;
    L.push(`@@ -${h.aStart},${na} +${h.bStart},${nb} @@`, ...h.ops.map(([t, l]) => t + l));
  }
  return L.join("\n") + "\n";
}

/** Exact old/new strings per hunk, with enough context to be unique in the file (for an Edit tool). */
function editsFor(x) {
  for (let context = 2; context <= 64; context *= 2) {
    const hs = hunks(x.before, x.after, context).map((h) => ({ old: h.ops.filter((o) => o[0] !== "+").map((o) => o[1]).join("\n"), new: h.ops.filter((o) => o[0] !== "-").map((o) => o[1]).join("\n") }));
    if (hs.every((h) => h.old && x.before.split(h.old).length === 2)) return hs.map((h) => ({ file: x.abs, oldString: h.old, newString: h.new }));
  }
  return [{ file: x.abs, oldString: x.before, newString: x.after }];
}
