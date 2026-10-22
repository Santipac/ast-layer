// Architecture rules: an optional `ast-layer.rules.json` at the root of each
// analyzed root states which package may import which. The rules are the
// team's decisions; this module only reads them and checks imports against them.
// Read-only: it parses text it is given and never touches the filesystem.
import path from "node:path";
import ts from "typescript";
import { z } from "zod";

export const RULES_FILE = "ast-layer.rules.json";

const Glob = z.string().min(1).max(300);
const Rule = z.strictObject({
  id: z.string().min(1),
  from: Glob,
  to: Glob.optional(),
  toSpecifier: Glob.optional(),
  allow: z.boolean(),
  except: z.array(Glob).max(100).optional(),
  message: z.string().optional(),
  includeTypeOnly: z.boolean().optional(),
}).refine((r) => r.to || r.toSpecifier, { message: "a rule needs `to` or `toSpecifier`" });

const RulesFile = z.strictObject({ $schema: z.string().optional(), rules: z.array(Rule).max(500) });

/**
 * Parse one root's rules file. Never throws: a malformed file yields no rules
 * and a problem that the report prints as a limit.
 */
export function parseRules(text, rootLabel) {
  if (text === undefined || text === null) return { rules: [], problems: [] };
  let json;
  try { json = JSON.parse(text); } catch (e) { return { rules: [], problems: [`${rootLabel}/${RULES_FILE} is not valid JSON (${e.message}); no rules from it were applied.`] }; }
  const r = RulesFile.safeParse(json);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { rules: [], problems: [`${rootLabel}/${RULES_FILE} does not match the rules format (${issues}); no rules from it were applied.`] };
  }
  const seen = new Set(); const problems = []; const rules = [];
  for (const rule of r.data.rules) {
    if (seen.has(rule.id)) { problems.push(`${rootLabel}/${RULES_FILE}: rule id "${rule.id}" is repeated; only the first one was applied.`); continue; }
    seen.add(rule.id);
    rules.push({ root: rootLabel, ...rule });
  }
  return { rules, problems };
}

const globCache = new Map();
/**
 * `**` matches across "/", `*` and `?` within one segment; a bare `*` or `**`
 * matches everything. Matching is dynamic programming over pattern x text, not
 * a RegExp: the patterns come from the analyzed repository, and a regex built
 * from `**\/**\/…` backtracks for minutes on a long path.
 */
export function compileGlob(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  const toks = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { toks.push("SEGS"); i += 2; } else { toks.push("ANY"); i++; }
    } else if (c === "*") toks.push("STAR");
    else if (c === "?") toks.push("ONE");
    else toks.push({ c });
  }
  const all = glob === "*" || glob === "**";
  const test = (str) => {
    if (all) return true;
    const s = String(str); const n = s.length; const m = toks.length;
    // next[j]: tokens i+1.. match s[j..]; cur[j]: tokens i.. match s[j..].
    let next = new Uint8Array(n + 1); next[n] = 1;
    for (let i = m - 1; i >= 0; i--) {
      const t = toks[i]; const cur = new Uint8Array(n + 1);
      let slashAhead = 0; // SEGS: some "/" at k >= j with next[k + 1]
      for (let j = n; j >= 0; j--) {
        if (t === "STAR") cur[j] = next[j] || (j < n && s[j] !== "/" && cur[j + 1]) ? 1 : 0;
        else if (t === "ANY") cur[j] = next[j] || (j < n && cur[j + 1]) ? 1 : 0;
        else if (t === "SEGS") { if (j < n && s[j] === "/" && next[j + 1]) slashAhead = 1; cur[j] = next[j] || slashAhead ? 1 : 0; }
        else if (t === "ONE") cur[j] = j < n && s[j] !== "/" && next[j + 1] ? 1 : 0;
        else cur[j] = j < n && s[j] === t.c && next[j + 1] ? 1 : 0;
      }
      next = cur;
    }
    return next[0] === 1;
  };
  const out = { test };
  globCache.set(glob, out);
  return out;
}

/** A package (or external module) matches a glob by its name or by its directory relative to its root. */
export function matchesTarget(glob, target) {
  if (!target) return false;
  const re = compileGlob(glob);
  return Boolean((target.name && re.test(target.name)) || (target.dir && re.test(target.dir)));
}

/**
 * The deny rules an import breaks. `imp` = { root, from: {name, dir}, spec,
 * target: {name, dir} | null (null when the import resolves to no package),
 * typeOnly }. An allow rule that matches the same import cancels the denials.
 */
export function brokenRules(rules, imp) {
  const applies = (rule) => {
    if (rule.root !== imp.root) return false;
    if (!matchesTarget(rule.from, imp.from)) return false;
    if ((rule.except || []).some((g) => matchesTarget(g, imp.from))) return false;
    if (imp.typeOnly && !rule.includeTypeOnly) return false;
    if (rule.to && !matchesTarget(rule.to, imp.target)) return false;
    if (rule.toSpecifier && !compileGlob(rule.toSpecifier).test(imp.spec)) return false;
    return true;
  };
  const hits = rules.filter(applies);
  if (hits.some((r) => r.allow)) return [];
  return hits.filter((r) => !r.allow);
}

/** Compact description of a rule: "id (from ↛ to)", for the session note and messages. */
export function describeRule(rule) {
  const target = [rule.to, rule.toSpecifier && `"${rule.toSpecifier}"`].filter(Boolean).join(" via ");
  return `${rule.id} (${rule.from} ${rule.allow ? "→ may import" : "↛"} ${target}${rule.except && rule.except.length ? `, except ${rule.except.join(", ")}` : ""}${rule.includeTypeOnly ? ", types too" : ""})`;
}

/** Import specifiers of a source text, with whether each is type-only. Used by the post-edit hook. */
export function importsOfText(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
  const out = [];
  const K = ts.SyntaxKind;
  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  for (const st of sf.statements) {
    if ((st.kind === K.ImportDeclaration || st.kind === K.ExportDeclaration) && st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier)) {
      const ic = st.importClause;
      const named = ic && ic.namedBindings && ic.namedBindings.kind === K.NamedImports ? ic.namedBindings.elements : [];
      const typeOnly = Boolean((ic && ic.isTypeOnly) || st.isTypeOnly || (ic && !ic.name && named.length && named.every((e) => e.isTypeOnly)));
      out.push({ spec: st.moduleSpecifier.text, line: at(st), typeOnly });
    }
  }
  const walk = (n) => {
    if (n.kind === K.CallExpression && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === K.ImportKeyword || (n.expression.kind === K.Identifier && n.expression.text === "require"))) out.push({ spec: n.arguments[0].text, line: at(n), typeOnly: false });
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** The package that owns a file key ("<root>/<rel>"), by the longest package directory prefix. */
export function ownerOfKey(packages, key) {
  let best = null;
  for (const p of packages) {
    const prefix = p.dir === "." ? `${p.root}/` : `${p.root}/${p.dir}/`;
    if (key.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, pkg: p };
  }
  return best ? best.pkg : null;
}

/** Bare package name of an external specifier ("@scope/name/sub" -> "@scope/name"). */
export const bareName = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/** What an import from `fromKey` points to, using package names and paths only (no tsconfig paths). */
export function targetOfSpec(packages, fromKey, spec) {
  if (spec.startsWith(".")) {
    const key = path.posix.normalize(path.posix.join(path.posix.dirname(fromKey), spec));
    const p = ownerOfKey(packages, key.endsWith("/") ? key : key + "/x");
    return p ? { name: p.name, dir: p.dir, id: p.id } : null;
  }
  const byName = packages.filter((p) => p.name && (spec === p.name || spec.startsWith(p.name + "/"))).sort((a, b) => b.name.length - a.name.length)[0];
  if (byName) return { name: byName.name, dir: byName.dir, id: byName.id };
  if (spec.startsWith("/")) return null;
  return { name: bareName(spec), dir: null, external: true };
}
