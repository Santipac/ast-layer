// The analysis layer. It returns data and never writes: the CLI runs it inside
// a write guard, and only src/writer.js can create the report.
import crypto from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { builtinModules } from "node:module";
import { discover, dependsOnDeclared } from "./discover.js";
import { buildProgram, workspaceCandidates, probe } from "./program.js";
import { collectUnits, fingerprint, jaccard, literalOverlap, lshBands, encodeU32 } from "./fingerprint.js";
import { scanSignature } from "./cache.js";
import { RULES_FILE, parseRules, brokenRules, bareName, describeRule } from "./rules.js";
import { DECISIONS_FILE, parseDecisions, applyDecisions } from "./decisions.js";
import { parseStyle, flattenMessages, localeLanguage } from "./assets.js";
import { CONVENTIONAL_NAMES } from "./lookup.js";

export const TOOL = { name: "ast-layer", version: "1.2.1", schema: 2 };
const K = ts.SyntaxKind;
const CLASS_ORDER = { provable: 0, "agent-guided": 1, "manual-review": 2 };
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const hash16 = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const cmpLoc = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col;
const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));
const isNodeBuiltin = (spec) => spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0]);
const FED_CONFIG_RE = /(^|\/)(webpack|rspack|rsbuild|vite|next|modern|module-federation|federation|craco|vue)\.config\.[cm]?[jt]s$/;

/** Shared structure two large units need to count as similar: less when they have the same, non-conventional name. */
export function similarFloor(nameA, nameB, opts) {
  return nameA === nameB && !CONVENTIONAL_NAMES.has(nameA) ? opts.similarSameNameThreshold : opts.similarThreshold;
}

export const DEFAULTS = { cssMinDeclarations: 4, cssMinSharedTokens: 2, i18nMinShared: 10, i18nMinRatio: 0.7, similarMinNodes: 60, similarThreshold: 0.8, similarSameNameThreshold: 0.6, moduleMinShared: 3, moduleMinRatio: 0.75, minNodes: 40, minLines: 5, nearMaxDiffPositions: 5, nearMaxDiffCharRatio: 0.25, nearSmallDiffChars: 24, includeTests: false };

/**
 * `opts` shape the result and are printed in the report. `ctx` never changes the
 * result, only how it is computed or where inputs come from:
 *   disc            a discovery already made for these roots (see `discoverFor`)
 *   rootLabels      fixed root labels (PR mode scans a temporary copy)
 *   oldProgram, sourceFileCache   incremental rebuild (MCP server)
 *   overlay         Map(abs -> text): analyze edited content without writing it
 *   userDecisionFiles  [{ root: label, abs }]: user-scope decisions (plugin data dir)
 */
export function analyze(rootPaths, userOpts = {}, ctx = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const disc = ctx.disc || discoverFor(rootPaths, opts, ctx);
  const readText = (abs) => (ctx.overlay && ctx.overlay.has(abs) ? ctx.overlay.get(abs) : ts.sys.readFile(abs));
  // Federation configs are read first: their remote aliases change how imports resolve.
  const fedConfigs = [];
  for (const f of disc.files) {
    if (!FED_CONFIG_RE.test(f.rel)) continue;
    const sf0 = ts.createSourceFile(f.abs, readText(f.abs) || "", ts.ScriptTarget.ESNext, true);
    const fileKey = f.key;
    fedConfigs.push(...extractFederation(sf0, f, (sf, node) => { const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf)); return { file: fileKey, line: lc.line + 1, col: lc.character + 1 }; }));
  }
  const federatedAliases = new Map();
  for (const c of fedConfigs) for (const alias of Object.keys(c.remotes)) {
    if (!federatedAliases.has(c.pkgId)) federatedAliases.set(c.pkgId, new Set());
    federatedAliases.get(c.pkgId).add(alias);
  }
  const P = buildProgram(disc, { federatedAliases, oldProgram: ctx.oldProgram, sourceFileCache: ctx.sourceFileCache, overlay: ctx.overlay });
  const { program, checker, fileInfo, pkgById } = P;
  const fileSet = new Set(fileInfo.keys());
  const fileByKey = new Map(disc.files.map((f) => [f.key, f]));

  const fileKeyOf = (abs) => (fileInfo.has(abs) ? fileInfo.get(abs).key : null);
  const pkgOfFile = (abs) => (fileInfo.has(abs) ? fileInfo.get(abs).pkgId : null);
  const declKey = (d) => {
    if (!d) return null;
    const sf = d.getSourceFile();
    const k = fileKeyOf(sf.fileName);
    return k ? `${k}#${d.kind === K.SourceFile ? 0 : d.getStart(sf)}` : null;
  };
  const locOf = (sf, node) => {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: fileKeyOf(sf.fileName), line: lc.line + 1, col: lc.character + 1 };
  };
  const safeAliased = (sym) => { try { return checker.getAliasedSymbol(sym); } catch { return null; } };

  function moduleSpecifierOf(decl) {
    for (let n = decl; n; n = n.parent) {
      if ((n.kind === K.ImportDeclaration || n.kind === K.ExportDeclaration) && n.moduleSpecifier) return n.moduleSpecifier.text;
      if (n.kind === K.ImportEqualsDeclaration && n.moduleReference.expression) return n.moduleReference.expression.text;
      if (n.kind === K.VariableDeclaration && n.initializer && n.initializer.kind === K.CallExpression && n.initializer.arguments[0] && ts.isStringLiteralLike(n.initializer.arguments[0])) return n.initializer.arguments[0].text;
    }
    return "?";
  }

  const resolveFree = (sym, id) => {
    if (!sym) return "unresolved:" + id.text;
    if (sym.flags & ts.SymbolFlags.Alias) {
      const t = safeAliased(sym);
      if (t && t.declarations && t.declarations.length) { const k = declKey(t.declarations[0]); if (k) return "decl:" + k; }
      const d0 = sym.declarations && sym.declarations[0];
      if (!d0) return "unresolved:" + id.text;
      const imported = d0.kind === K.ImportClause ? "default" : d0.kind === K.NamespaceImport ? "*" : (d0.propertyName || d0.name || { text: id.text }).text;
      return `ext:${moduleSpecifierOf(d0)}#${imported}`;
    }
    if (sym.declarations && sym.declarations.length) { const k = declKey(sym.declarations[0]); if (k) return "decl:" + k; }
    return "global:" + id.text;
  };

  // ---------- pass 1: per-file facts ----------
  const units = [];
  const unitByDeclKey = new Map();
  const moduleImports = []; // {fromPkg, toPkg, file, line, col, spec, kind, typeOnly, res}
  const bindings = []; // {fromPkg, toPkg, targetKey, importedName, local, refs, loc, viaSpec, kind}
  const starReexports = []; // {fromPkg, toPkg, loc}
  const fileDirective = new Map(); // abs -> "use client" | "use server" | null
  const nameInventory = []; // every top-level function/component/class, any size
  const fileItems = []; // every top-level unit and module constant, for module-copy detection
  const fileExportedDecls = new Set(); // declarations some file exports
  const publicInventory = []; // every export reachable from a package entry
  const stats = { files: 0, parseErrorFiles: 0, dynamicNonLiteral: 0, unresolvedRelative: [], unresolvedWorkspace: [], externalSpecifiers: new Set(), unitsTotal: 0, unitsFingerprinted: 0 };

  for (const f of disc.files) {
    const sf = program.getSourceFile(f.abs);
    if (!sf) continue;
    stats.files++;
    if (program.getSyntacticDiagnostics(sf).length) stats.parseErrorFiles++;
    const fromPkg = f.pkgId;
    fileDirective.set(f.abs, directiveOf(sf));

    const recordImport = (spec, node, kind, typeOnly) => {
      const res = P.resolveSpecifier(spec, f.abs);
      const loc = locOf(sf, node);
      const toPkg = res.kind === "workspace" ? pkgOfFile(res.file) : null;
      if (res.kind === "unresolved-relative") stats.unresolvedRelative.push({ ...loc, spec });
      if (res.kind === "unresolved-workspace") stats.unresolvedWorkspace.push({ ...loc, spec, viaName: res.viaName });
      if (res.kind === "external") stats.externalSpecifiers.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      const rec = { fromPkg, toPkg, ...loc, spec, kind, typeOnly: Boolean(typeOnly), res, isTestFile: f.isTest, fromAbs: f.abs };
      moduleImports.push(rec);
      return rec;
    };

    // Import bindings declared at top level (ESM and top-level CommonJS require).
    const fileBindings = [];
    // A binding is type-only when written as such, or when the declaration it
    // resolves to has no runtime value (interface, type alias). Erased at compile time.
    const isTypeOnlyTarget = (t) => Boolean(t && t.declarations && t.declarations.length && !(t.flags & ts.SymbolFlags.Value));
    const addBinding = (nameNode, importedName, rec, kind, explicitTypeOnly) => {
      const aliasSym = checker.getSymbolAtLocation(nameNode);
      if (!aliasSym) return null;
      const t = safeAliased(aliasSym);
      const tDecl = t && t.declarations && t.declarations[0];
      const targetKey = tDecl ? declKey(tDecl) : null;
      const b = { aliasSym, local: nameNode.text, importedName, rec, kind, targetKey, targetFile: tDecl ? tDecl.getSourceFile().fileName : null, refs: { call: 0, jsx: 0, value: 0 }, nsMembers: new Map(), declNode: nameNode, typeOnly: Boolean(explicitTypeOnly) || isTypeOnlyTarget(t) };
      fileBindings.push(b);
      return b;
    };
    const markTypeOnly = (rec, results) => { if (results.length && results.every((b) => b && b.typeOnly)) rec.typeOnly = true; };

    for (const st of sf.statements) {
      if (st.kind === K.ImportDeclaration && ts.isStringLiteralLike(st.moduleSpecifier)) {
        const ic = st.importClause;
        const rec = recordImport(st.moduleSpecifier.text, st, ic ? "import" : "side-effect", ic && ic.isTypeOnly);
        if (!ic) continue;
        const got = [];
        if (ic.name) got.push(addBinding(ic.name, "default", rec, "default", ic.isTypeOnly));
        if (ic.namedBindings) {
          if (ic.namedBindings.kind === K.NamespaceImport) got.push(addBinding(ic.namedBindings.name, "*", rec, "namespace", ic.isTypeOnly));
          else for (const el of ic.namedBindings.elements) got.push(addBinding(el.name, (el.propertyName || el.name).text, rec, "named", ic.isTypeOnly || el.isTypeOnly));
        }
        markTypeOnly(rec, got);
      } else if (st.kind === K.ExportDeclaration && st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier)) {
        const rec = recordImport(st.moduleSpecifier.text, st, "re-export", st.isTypeOnly);
        if (!st.exportClause) { if (rec.toPkg && rec.toPkg !== fromPkg) starReexports.push({ fromPkg, toPkg: rec.toPkg, file: rec.file, line: rec.line, col: rec.col }); continue; }
        if (st.exportClause.kind === K.NamedExports) {
          const got = [];
          for (const el of st.exportClause.elements) {
            let sym = null;
            try { sym = checker.getExportSpecifierLocalTargetSymbol(el); } catch {}
            const t = sym && sym.flags & ts.SymbolFlags.Alias ? safeAliased(sym) : sym;
            const tDecl = t && t.declarations && t.declarations[0];
            got.push({ typeOnly: st.isTypeOnly || el.isTypeOnly || isTypeOnlyTarget(t) });
            bindings.push({ fromPkg, toPkg: rec.toPkg, targetKey: tDecl ? declKey(tDecl) : null, importedName: (el.propertyName || el.name).text, local: el.name.text, refs: 1, kind: "re-export", loc: { file: rec.file, line: rec.line, col: rec.col }, viaSpec: rec.spec, rec });
          }
          markTypeOnly(rec, got);
        }
      } else if (st.kind === K.ImportEqualsDeclaration && st.moduleReference.kind === K.ExternalModuleReference && st.moduleReference.expression && ts.isStringLiteralLike(st.moduleReference.expression)) {
        const rec = recordImport(st.moduleReference.expression.text, st, "import", st.isTypeOnly);
        addBinding(st.name, "=", rec, "default");
      } else if (st.kind === K.VariableStatement) {
        for (const d of st.declarationList.declarations) {
          const init = d.initializer;
          if (init && init.kind === K.CallExpression && init.expression.kind === K.Identifier && init.expression.text === "require" && init.arguments.length === 1 && ts.isStringLiteralLike(init.arguments[0])) {
            const rec = recordImport(init.arguments[0].text, init, "require", false);
            if (d.name.kind === K.Identifier) addBinding(d.name, "=", rec, "default");
            else if (d.name.kind === K.ObjectBindingPattern) for (const el of d.name.elements) if (el.name.kind === K.Identifier) addBinding(el.name, (el.propertyName || el.name).text, rec, "named");
            init.__handled = true;
          }
        }
      }
    }

    // One walk: dynamic imports, nested requires, and binding-resolved references.
    const byName = new Map();
    for (const b of fileBindings) { if (!byName.has(b.local)) byName.set(b.local, []); byName.get(b.local).push(b); }
    const declNodes = new Set(fileBindings.map((b) => b.declNode));
    const walk = (n) => {
      if (n.kind === K.CallExpression) {
        const arg = n.arguments[0];
        if (n.expression.kind === K.ImportKeyword) {
          if (arg && ts.isStringLiteralLike(arg)) recordImport(arg.text, n, "dynamic-import", false); else stats.dynamicNonLiteral++;
        } else if (!n.__handled && n.expression.kind === K.Identifier && n.expression.text === "require" && n.arguments.length === 1) {
          if (arg && ts.isStringLiteralLike(arg)) recordImport(arg.text, n, "require", false); else stats.dynamicNonLiteral++;
        }
      }
      if (n.kind === K.Identifier && byName.has(n.text) && !declNodes.has(n)) {
        const p = n.parent;
        const isProp = p && ((p.kind === K.PropertyAccessExpression && p.name === n) || (p.kind === K.PropertyAssignment && p.name === n) || (p.kind === K.JsxAttribute && p.name === n) || (p.kind === K.QualifiedName && p.right === n) || p.kind === K.ImportSpecifier || p.kind === K.ImportClause || p.kind === K.NamespaceImport);
        if (!isProp) {
          let sym = checker.getSymbolAtLocation(n);
          if (!sym && p && p.kind === K.ShorthandPropertyAssignment) sym = checker.getShorthandAssignmentValueSymbol(p);
          const b = sym && byName.get(n.text).find((x) => x.aliasSym === sym);
          if (b) {
            if (p && p.kind === K.CallExpression && p.expression === n) b.refs.call++;
            else if (p && (p.kind === K.JsxOpeningElement || p.kind === K.JsxSelfClosingElement || p.kind === K.JsxClosingElement) && p.tagName === n) { if (p.kind !== K.JsxClosingElement) b.refs.jsx++; }
            else b.refs.value++;
            if (b.kind === "namespace" && p && p.kind === K.PropertyAccessExpression && p.expression === n) {
              const ms = checker.getSymbolAtLocation(p.name);
              const mt = ms && ms.flags & ts.SymbolFlags.Alias ? safeAliased(ms) : ms;
              const mk = mt && mt.declarations && mt.declarations[0] ? declKey(mt.declarations[0]) : null;
              if (mk) b.nsMembers.set(mk, p.name.text);
            }
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);

    for (const b of fileBindings) {
      const refsTotal = b.refs.call + b.refs.jsx + b.refs.value;
      const toPkg = b.targetFile ? pkgOfFile(b.targetFile) : null;
      bindings.push({ fromPkg, toPkg, targetKey: b.targetKey, importedName: b.importedName, local: b.local, refs: refsTotal, refKinds: b.refs, kind: b.kind, loc: { file: b.rec.file, line: b.rec.line, col: b.rec.col }, viaSpec: b.rec.spec, rec: b.rec });
      for (const [mk, mname] of b.nsMembers) bindings.push({ fromPkg, toPkg, targetKey: mk, importedName: mname, local: `${b.local}.${mname}`, refs: 1, kind: "namespace-member", loc: { file: b.rec.file, line: b.rec.line, col: b.rec.col }, viaSpec: b.rec.spec, rec: b.rec });
    }

    // Code units and fingerprints.
    const fileUnits = collectUnits(sf);
    const collectUnitsDeclSet = new Set(fileUnits.map((u) => u.declNode));
    for (const u of fileUnits) {
      stats.unitsTotal++;
      if (f.isTest && !opts.includeTests) continue;
      nameInventory.push({ name: u.name, pkgId: fromPkg, file: f.key, line: sf.getLineAndCharacterOfPosition(u.declNode.getStart(sf)).line + 1, declKey: declKey(u.declNode) });
      const fp = fingerprint(u, sf, checker, { resolveFree });
      fileItems.push({ file: f.key, pkgId: fromPkg, name: u.name, exact: fp.exact, near: fp.near, line: fp.line });
      if (fp.nodes < opts.minNodes || fp.lines < opts.minLines) continue;
      stats.unitsFingerprinted++;
      const unit = { abs: f.abs, id: `${f.key}#${u.name}@${fp.line}`, name: u.name, pkgId: fromPkg, file: f.key, line: fp.line, col: fp.col, lines: fp.lines, nodes: fp.nodes, exact: fp.exact, near: fp.near, literals: fp.literals, free: fp.free, declKey: declKey(u.declNode), public: [], exportedAs: [] };
      if (fp.nodes >= opts.similarMinNodes) { unit.shingles = fp.shingles; unit.minhash = fp.minhash; }
      units.push(unit);
      unitByDeclKey.set(unit.declKey, unit);
    }

    // Module-level constants built from object/array literals or calls: part of
    // what makes two files copies of each other, never reported on their own.
    if (!(f.isTest && !opts.includeTests)) for (const st of sf.statements) {
      if (st.kind !== K.VariableStatement) continue;
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (!init || d.name.kind !== K.Identifier) continue;
        const k = init.kind;
        if (k !== K.ObjectLiteralExpression && k !== K.ArrayLiteralExpression && k !== K.CallExpression && k !== K.NewExpression && k !== K.AsExpression && k !== K.SatisfiesExpression) continue;
        if (collectUnitsDeclSet.has(d)) continue;
        const fp = fingerprint({ name: d.name.text, declNode: d, bodyNode: init, nameNode: d.name }, sf, checker, { resolveFree });
        if (fp.nodes < 8) continue;
        fileItems.push({ file: f.key, pkgId: fromPkg, name: d.name.text, exact: fp.exact, near: fp.near, line: fp.line });
      }
    }

    // Exports of this file (who can import the unit at all).
    const modSym = checker.getSymbolAtLocation(sf);
    if (modSym) {
      for (const e of checker.getExportsOfModule(modSym)) {
        const t = e.flags & ts.SymbolFlags.Alias ? safeAliased(e) : e;
        for (const d of [...(e.declarations || []), ...((t && t.declarations) || [])]) {
          const k = declKey(d);
          fileExportedDecls.add(k);
          const u = unitByDeclKey.get(k);
          if (u && u.file === f.key && !u.exportedAs.includes(e.name)) u.exportedAs.push(e.name);
        }
      }
    }

  }

  // ---------- public API of each named package (follows re-export chains) ----------
  const publicByDecl = new Map();
  const entries = new Map(); // pkgId -> [{specifier, file}]
  for (const pkg of disc.packages) {
    if (!pkg.name) continue;
    const specs = [""];
    const exp = pkg.json && pkg.json.exports;
    if (exp && typeof exp === "object" && !Array.isArray(exp)) for (const k of Object.keys(exp).sort()) if (k.startsWith("./") && !k.includes("*") && k !== "./package.json") specs.push(k.slice(2));
    const list = [];
    for (const sub of specs) {
      let file = null;
      for (const c of workspaceCandidates(pkg, sub)) { file = probe(path.resolve(pkg.absDir, c), fileSet); if (file) break; }
      if (file && pkgOfFile(file) === pkg.id) list.push({ specifier: sub ? `${pkg.name}/${sub}` : pkg.name, file });
    }
    entries.set(pkg.id, list);
    for (const { specifier, file } of list) {
      const sf = program.getSourceFile(file);
      const ms = sf && checker.getSymbolAtLocation(sf);
      if (!ms) continue;
      for (const e of checker.getExportsOfModule(ms)) {
        const t = e.flags & ts.SymbolFlags.Alias ? safeAliased(e) : e;
        for (const d of (t && t.declarations) || []) {
          const k = declKey(d);
          if (!k) continue;
          if (!publicByDecl.has(k)) publicByDecl.set(k, []);
          const arr = publicByDecl.get(k);
          if (!arr.some((x) => x.specifier === specifier && x.exportName === e.name)) {
            arr.push({ pkgId: pkg.id, specifier, exportName: e.name });
            const dsf = d.getSourceFile();
            publicInventory.push({ specifier, exportName: e.name, package: pkg.displayName, file: fileKeyOf(dsf.fileName), line: d.kind === K.SourceFile ? 1 : dsf.getLineAndCharacterOfPosition(d.getStart(dsf)).line + 1, typeOnly: !(t.flags & ts.SymbolFlags.Value) });
          }
        }
      }
    }
  }
  for (const u of units) {
    u.public = (publicByDecl.get(u.declKey) || []).filter((p) => p.pkgId === u.pkgId).sort((a, b) => a.specifier.localeCompare(b.specifier) || a.exportName.localeCompare(b.exportName));
    u.exportedAs.sort();
  }

  // ---------- module loading facts ----------
  // Swapping a local definition (or a deep import) for an import from a
  // package entry changes which modules load. These facts decide whether that
  // swap is still mechanical.
  const importsFromFile = new Map();
  for (const m of moduleImports) { if (!importsFromFile.has(m.fromAbs)) importsFromFile.set(m.fromAbs, []); importsFromFile.get(m.fromAbs).push(m); }
  const effectsMemo = new Map();
  const entryEffects = (entryAbs) => {
    if (effectsMemo.has(entryAbs)) return effectsMemo.get(entryAbs);
    const pkgId = pkgOfFile(entryAbs);
    const seen = new Set([entryAbs]); const queue = [entryAbs]; const sideEffects = []; const nodeBuiltins = [];
    while (queue.length) {
      const fAbs = queue.shift();
      for (const m of importsFromFile.get(fAbs) || []) {
        if (m.kind === "side-effect") sideEffects.push({ spec: m.spec, at: `${m.file}:${m.line}` });
        if (!m.typeOnly && m.kind !== "dynamic-import" && m.res.kind === "external" && isNodeBuiltin(m.spec)) nodeBuiltins.push({ spec: m.spec, at: `${m.file}:${m.line}` });
        if (m.typeOnly || m.kind === "dynamic-import" || m.res.kind !== "workspace" || pkgOfFile(m.res.file) !== pkgId || seen.has(m.res.file)) continue;
        seen.add(m.res.file); queue.push(m.res.file);
      }
    }
    const r = { modules: seen.size, sideEffects: sideEffects.sort((a, b) => a.at.localeCompare(b.at)), nodeBuiltins: nodeBuiltins.sort((a, b) => a.at.localeCompare(b.at)) };
    effectsMemo.set(entryAbs, r);
    return r;
  };
  const alreadyImportsAtRuntime = (fileAbs, entryAbs) => (importsFromFile.get(fileAbs) || []).some((m) => !m.typeOnly && m.res.kind === "workspace" && m.res.file === entryAbs);
  // Where the importing code runs, as far as static facts show it.
  const runtimeOf = (fileAbs) => {
    const pkg = pkgById.get(pkgOfFile(fileAbs));
    if (pkg && (dependsOnDeclared(pkg, "react-native") || dependsOnDeclared(pkg, "expo"))) return "React Native (package depends on react-native/expo)";
    if (fileDirective.get(fileAbs) === "use client") return "the browser (module is marked \"use client\")";
    return null;
  };
  /** Reasons why importing `entryAbs` into `fileAbs` changes module loading. `blocking` means it cannot work as is. */
  const loadingChanges = (fileAbs, entryAbs, specifier) => {
    if (alreadyImportsAtRuntime(fileAbs, entryAbs)) return { reasons: [], blocking: false, evidence: { alreadyImportsEntry: true } };
    const eff = entryEffects(entryAbs);
    const reasons = [];
    if (eff.sideEffects.length) reasons.push(`Importing "${specifier}" would load its entry module graph (${eff.modules} modules), which has ${eff.sideEffects.length} side-effect import(s), e.g. ${eff.sideEffects.slice(0, 2).map((e) => `"${e.spec}" at ${e.at}`).join(", ")}; this file does not load that entry today.`);
    const rt = runtimeOf(fileAbs);
    let blocking = false;
    if (eff.nodeBuiltins.length) {
      blocking = Boolean(rt);
      reasons.push(`The entry module graph of "${specifier}" imports Node.js built-ins (${eff.nodeBuiltins.slice(0, 3).map((e) => `"${e.spec}" at ${e.at}`).join(", ")})${rt ? `, and this code runs in ${rt}, where they are not available` : "; check that this code only runs on Node"}.`);
    }
    return { reasons, blocking, evidence: { alreadyImportsEntry: false, entryModules: eff.modules, entrySideEffects: eff.sideEffects.slice(0, 5), entryNodeBuiltins: eff.nodeBuiltins.slice(0, 5), consumerRuntime: rt } };
  };

  // ---------- package graph ----------
  const edges = new Map(); // "from\0to" -> edge
  const edgeOf = (from, to) => {
    const k = `${from}\0${to}`;
    if (!edges.has(k)) edges.set(k, { from, to, importStatements: 0, typeOnlyStatements: 0, testOnlyStatements: 0, boundReferences: 0, samples: [] });
    return edges.get(k);
  };
  for (const m of moduleImports) {
    if (!m.toPkg || m.toPkg === m.fromPkg) continue;
    const e = edgeOf(m.fromPkg, m.toPkg);
    e.importStatements++;
    if (m.typeOnly) e.typeOnlyStatements++;
    if (m.isTestFile) e.testOnlyStatements++;
    if (e.samples.length < 3) e.samples.push({ file: m.file, line: m.line, col: m.col, spec: m.spec });
  }
  for (const b of bindings) if (b.toPkg && b.toPkg !== b.fromPkg && edges.has(`${b.fromPkg}\0${b.toPkg}`)) edges.get(`${b.fromPkg}\0${b.toPkg}`).boundReferences += b.refs;
  const edgeList = [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const runtimeAdj = new Map();
  for (const e of edgeList) if (e.importStatements > e.typeOnlyStatements && e.importStatements > e.testOnlyStatements) {
    if (!runtimeAdj.has(e.from)) runtimeAdj.set(e.from, []);
    runtimeAdj.get(e.from).push(e.to);
  }
  const reaches = (from, to, adj = runtimeAdj) => {
    const seen = new Set([from]); const stack = [from];
    while (stack.length) { const x = stack.pop(); if (x === to) return true; for (const y of adj.get(x) || []) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
    return false;
  };
  const incoming = new Map();
  for (const e of edgeList) incoming.set(e.to, (incoming.get(e.to) || new Set()).add(e.from));

  const findings = [];
  const observations = { packages: [], packageEdges: [], unconsumedPublicExports: [], federation: { containers: [], matchedImports: [], remotesOutsideGroup: [] }, duplication: {} };
  // `id` names a finding at its current position (kept for compatibility).
  // `key` is its identity: what it is about (members, their code hashes, names,
  // packages, specifiers), never line numbers, so it survives edits elsewhere in
  // a file and changes when the code it is about changes. `anchor` is looser
  // (no hashes): it recognizes "the same finding, but the code changed".
  const pushFinding = (f) => {
    f.id = hash(f.kind + "\0" + f.locations.map((l) => `${l.file}:${l.line}:${l.col}`).join("|") + "\0" + (f.idSalt || ""));
    f.key = hash16(f.kind + "\0" + f.stable.join("\n"));
    f.anchor = hash16(f.kind + "\0" + (f.anchorParts || f.stable).join("\n"));
    delete f.idSalt; delete f.stable; delete f.anchorParts;
    f.status = "observation"; findings.push(f);
  };
  const memberStable = (m) => `${m.pkgId}|${m.file}|${m.name}|${m.exact}`;
  const memberAnchor = (m) => `${m.pkgId}|${m.file}|${m.name}`;
  const membersKey = (ms) => ({ stable: ms.map(memberStable).sort(), anchorParts: ms.map(memberAnchor).sort() });
  const pkgLabel = (id) => (pkgById.get(id) ? pkgById.get(id).displayName : id);

  // Architecture rules are read before any classification: a mechanical fix
  // whose import would break a rule is not mechanical (see rulesAgainst).
  const ruleSet = []; const ruleProblems = [];
  for (const r of disc.roots) { const pr = parseRules(readText(path.join(r.abs, RULES_FILE)), r.label); ruleSet.push(...pr.rules); ruleProblems.push(...pr.problems); }
  /** Deny rules that an import of `specifier` (resolving to package `toPkgId`) from package `fromPkgId` would break. */
  const rulesAgainst = (fromPkgId, specifier, toPkgId) => {
    if (!ruleSet.length) return [];
    const fromP = pkgById.get(fromPkgId); const t = pkgById.get(toPkgId);
    return brokenRules(ruleSet, { root: fromP.root, from: { name: fromP.name, dir: fromP.dir }, spec: specifier, target: t && toPkgId !== fromPkgId ? { name: t.name, dir: t.dir } : null, typeOnly: false });
  };

  // ---------- duplication ----------
  const nearGroups = new Map();
  for (const u of units) { if (!nearGroups.has(u.near)) nearGroups.set(u.near, []); nearGroups.get(u.near).push(u); }
  let rejectedNear = 0; let clustersExact = 0; let clustersNear = 0;
  const clusters = [];
  for (const [, members] of [...nearGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const diff = literalDiff(members);
    const allExact = members.every((m) => m.exact === members[0].exact);
    const nearOk = diff.positions.length <= opts.nearMaxDiffPositions && (diff.diffChars <= opts.nearSmallDiffChars || diff.diffChars <= opts.nearMaxDiffCharRatio * Math.max(1, diff.totalChars));
    if (allExact || nearOk) { clusters.push({ members, match: allExact ? "exact" : "near", diff }); allExact ? clustersExact++ : clustersNear++; continue; }
    rejectedNear++;
    const byExact = new Map();
    for (const m of members) { if (!byExact.has(m.exact)) byExact.set(m.exact, []); byExact.get(m.exact).push(m); }
    for (const [, ms] of [...byExact.entries()].sort((a, b) => a[0].localeCompare(b[0]))) if (ms.length >= 2) { clusters.push({ members: ms, match: "exact", diff: literalDiff(ms) }); clustersExact++; }
  }

  const unitLoc = (m) => ({ file: m.file, line: m.line, col: m.col });
  const memberEvidence = (m) => ({ name: m.name, package: pkgLabel(m.pkgId), location: `${m.file}:${m.line}`, lines: m.lines, exportedAs: m.exportedAs, public: m.public.map((p) => `${p.specifier}#${p.exportName}`) });
  const libraries = new Set([...incoming.keys()]);
  /** Free identifiers that resolve to each copy's own module-level declaration (logger, cache, config...). */
  const moduleState = (members) => {
    const names = [...new Set(members.flatMap((m) => Object.keys(m.free)))].sort();
    const out = [];
    for (const n of names) {
      const keys = members.map((m) => m.free[n] || null);
      if (new Set(keys).size < 2) continue;
      if (!members.some((m) => (m.free[n] || "").startsWith(`decl:${m.file}#`))) continue;
      out.push({ name: n, resolvesTo: members.map((m) => ({ copy: `${m.file}:${m.line}`, declaration: (m.free[n] || "unresolved").replace(/^decl:/, "") })) });
    }
    return out;
  };

  for (const c of clusters) {
    const pkgs = [...new Set(c.members.map((m) => m.pkgId))].sort();
    const pub = c.members.filter((m) => m.public.length);
    if (pkgs.length === 1) {
      if (c.match !== "exact") continue;
      if (new Set(c.members.map((m) => m.file)).size < 2) continue;
      const ms = moduleState(c.members);
      pushFinding({
        kind: "duplicate.within-package", class: "agent-guided",
        locations: c.members.map(unitLoc).sort(cmpLoc),
        why: `${c.members.length} structurally identical definitions (${c.members[0].lines} lines each) in different files of ${pkgLabel(pkgs[0])}.`,
        evidence: { match: "exact", members: c.members.map(memberEvidence), moduleStateDifferences: ms },
        ...membersKey(c.members),
        nextAction: ms.length
          ? `The code is identical, but each copy uses its own module-level ${ms.map((d) => `\`${d.name}\``).join(", ")}. Consolidating means passing ${ms.length > 1 ? "those" : "that"} in as a parameter or sharing ${ms.length > 1 ? "them" : "it"} as well; deleting all but one copy would change behavior.`
          : "Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.",
        stopConditions: [...(ms.length ? ["Stop if the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating."] : []), "Stop if the copies are intentionally independent (e.g. generated files, separate deploy targets).", "Stop if a copy is referenced by code you cannot see (scripts, other repos)."],
      });
      continue;
    }
    const pubPkgs = [...new Set(pub.map((m) => m.pkgId))].sort();
    if (pubPkgs.length >= 2) {
      pushFinding({
        kind: "duplicate.multiple-library-exports", class: "manual-review",
        locations: pub.map(unitLoc).sort(cmpLoc),
        why: `The same implementation (${c.match} match) is part of the public API of ${pubPkgs.length} packages: ${pubPkgs.map(pkgLabel).join(", ")}.`,
        evidence: { match: c.match, literalDifferences: c.diff.positions, members: pub.map(memberEvidence) },
        ...membersKey(pub),
        nextAction: "Decide which package owns this API; the other can re-export it or deprecate its copy.",
        stopConditions: ["Changing a public export is an API decision; do not remove either export without approval."],
      });
    }
    if (pubPkgs.length >= 1) {
      for (const m of c.members) {
        if (m.public.length || pubPkgs.includes(m.pkgId)) continue;
        const canon = [...pub].sort((a, b) => (a.exact === m.exact ? 0 : 1) - (b.exact === m.exact ? 0 : 1) || a.pkgId.localeCompare(b.pkgId) || a.file.localeCompare(b.file))[0];
        const cPkg = pkgById.get(canon.pkgId); const mPkg = pkgById.get(m.pkgId);
        const exact = canon.exact === m.exact;
        const pairDiff = literalDiff([m, canon]);
        const names = [...new Set([...Object.keys(m.free), ...Object.keys(canon.free)])].sort();
        const freeDiffs = names.filter((n) => m.free[n] !== canon.free[n]).map((n) => ({ name: n, here: m.free[n] || null, library: canon.free[n] || null }));
        const depDeclared = cPkg.name && dependsOnDeclared(mPkg, cPkg.name);
        const wouldCycle = reaches(canon.pkgId, m.pkgId);
        const exp = canon.public[0];
        const importLine = m.name === exp.exportName || m.name === "default" ? `import { ${exp.exportName} } from "${exp.specifier}"` : `import { ${exp.exportName} as ${m.name} } from "${exp.specifier}"`;
        const entryAbs = ((entries.get(canon.pkgId) || []).find((e) => e.specifier === exp.specifier) || {}).file;
        const loading = entryAbs ? loadingChanges(m.abs, entryAbs, exp.specifier) : { reasons: [], evidence: {} };
        const dirHere = fileDirective.get(m.abs) || null; const dirLib = fileDirective.get(canon.abs) || null;
        let cls; const reasons = [];
        if (dirHere !== dirLib) reasons.push(`The library copy lives in a module marked ${dirLib ? `"${dirLib}"` : "with no directive"}; the local copy's module is ${dirHere ? `marked "${dirHere}"` : "not marked"}.`);
        reasons.push(...loading.reasons);
        if (!exact) reasons.push(pairDiff.positions.length ? `Near match only: ${pairDiff.positions.length} literal value(s) differ (${pairDiff.positions.map((d) => d.values.map((v) => JSON.stringify(v)).join(" vs ")).join("; ")}).` : "Near match only: the code is identical except for type annotations.");
        if (freeDiffs.length) reasons.push(`${freeDiffs.length} free identifier(s) resolve to different declarations than in the library copy.`);
        if (!depDeclared) reasons.push(`${pkgLabel(m.pkgId)} does not declare a dependency on ${cPkg.name}.`);
        const ruleHits = rulesAgainst(m.pkgId, exp.specifier, canon.pkgId);
        if (ruleHits.length) reasons.push(`Importing "${exp.specifier}" here would break architecture rule${ruleHits.length > 1 ? "s" : ""} ${ruleHits.map((r) => `"${r.id}"`).join(", ")} (${RULES_FILE})${ruleHits[0].message ? `: ${ruleHits[0].message}` : "."}`);
        if (wouldCycle) { cls = "manual-review"; reasons.push(`${cPkg.name} already depends (transitively) on ${pkgLabel(m.pkgId)}; importing it would create a package cycle.`); }
        else if (ruleHits.length) cls = "manual-review";
        else if (loading.blocking) cls = "manual-review";
        else if (exact && !freeDiffs.length && depDeclared && dirHere === dirLib && !loading.reasons.length) cls = "provable";
        else cls = "agent-guided";
        pushFinding({
          kind: "duplicate.reinvents-library-export", class: cls,
          locations: [unitLoc(m), unitLoc(canon)],
          why: cls === "provable"
            ? `\`${m.name}\` is identical (structure, literals, types, and the declarations its free identifiers resolve to) to \`${exp.specifier}#${exp.exportName}\`, which ${pkgLabel(m.pkgId)} already depends on.`
            : `\`${m.name}\` matches the public export \`${exp.specifier}#${exp.exportName}\`, but the replacement is not mechanically certain: ${reasons.join(" ")}`,
          evidence: { match: exact ? "exact" : "near", local: memberEvidence(m), library: memberEvidence(canon), literalDifferences: pairDiff.positions, freeIdentifierDifferences: freeDiffs, dependencyDeclared: Boolean(depDeclared), wouldCreateCycle: wouldCycle, brokenRules: ruleHits.map((r) => r.id), moduleLoading: { ...loading.evidence, directiveHere: dirHere, directiveLibrary: dirLib } },
          nextAction: cls === "provable"
            ? `Delete the local definition and use \`${importLine}\`${m.exportedAs.length ? `; keep the local export names (${m.exportedAs.join(", ")}) by re-exporting from the library` : ""}.`
            : cls === "agent-guided"
              ? `Compare both copies at the listed differences. If they are equivalent for this caller, replace with \`${importLine}\`${depDeclared ? "" : ` and declare the dependency on ${cPkg.name}`}. Settle any doubt with the smallest focused test that exercises the differing values.`
              : ruleHits.length
                ? `Do not replace without the team: the import would break architecture rule ${ruleHits.map((r) => `"${r.id}"`).join(", ")}${ruleHits[0].message ? ` (${ruleHits[0].message})` : ""}. Present the copy and the rule; changing either is their decision.`
              : loading.blocking
                ? `Do not replace: the library entry cannot load where this code runs. The library could expose this function from an entry without Node.js built-ins; that is a library API decision.`
                : "Do not replace. Decide how the dependency between these packages should flow first.",
          stopConditions: cls === "provable" ? [] : ["Stop if a differing literal encodes environment, timing, URLs, keys or business rules: that difference may be intentional.", "Stop if a free identifier resolves to module state (a variable, cache or singleton) in this package."],
          idSalt: canon.id,
          stable: [memberStable(m), memberStable(canon), `${exp.specifier}#${exp.exportName}`],
          anchorParts: [memberAnchor(m), `${canon.pkgId}|${canon.name}`],
        });
      }
      continue;
    }
    // Cross-package duplication with no library copy: extraction is a design decision.
    const homes = [...libraries].filter((L) => pkgById.has(L) && pkgById.get(L).name && pkgs.every((p) => p === L || dependsOnDeclared(pkgById.get(p), pkgById.get(L).name) || edges.has(`${p}\0${L}`))).sort();
    const homesNoCycle = homes.filter((L) => !pkgs.some((p) => p !== L && reaches(L, p)));
    const copyInsideHome = homesNoCycle.filter((L) => pkgs.includes(L));
    pushFinding({
      _pkgIds: pkgs,
      kind: "duplicate.cross-package", class: "manual-review",
      locations: c.members.map(unitLoc).sort(cmpLoc),
      why: `${c.members.length} ${c.match === "exact" ? "identical" : "near-identical"} definitions (${c.members[0].lines}+ lines) across ${pkgs.length} packages, and no copy is part of a library's public API.`,
      evidence: {
        match: c.match, packages: pkgs.map(pkgLabel), members: c.members.map(memberEvidence), moduleStateDifferences: moduleState(c.members),
        literalDifferences: c.diff.positions,
        candidateHomes: (copyInsideHome.length ? copyInsideHome : homesNoCycle).map(pkgLabel),
        candidateHomesNote: copyInsideHome.length
          ? `A copy already lives in ${copyInsideHome.map(pkgLabel).join(", ")}, which every other package with a copy already depends on; it is just not exported from the entry point.`
          : homesNoCycle.length
            ? `Every package with a copy already depends on ${homesNoCycle.map(pkgLabel).join(", ")}. This is a dependency fact, not a judgment that the code belongs there.`
            : "No analyzed library is already a dependency of every package with a copy; extracting would add a new dependency edge.",
      },
      ...membersKey(c.members),
      nextAction: copyInsideHome.length
        ? `Decide whether ${copyInsideHome.map(pkgLabel).join(", ")} should expose this. If yes, export it from the entry point and rescan: the other copies will then be classified as replacements of a library export.`
        : "Decide whether this logic should be shared. If yes, move one copy into the candidate home, export it from the entry point, and rescan; this tool will then classify each replacement.",
      stopConditions: ["Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose."],
    });
  }

  // ---------- similar copies: close, but not identical (MinHash + LSH, then exact Jaccard) ----------
  const big = units.filter((u) => u.shingles && u.shingles.length >= 8);
  const buckets = new Map();
  big.forEach((u, idx) => {
    for (const key of lshBands(u.minhash)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(idx);
    }
  });
  // Definitions with the same (non-conventional) name are compared directly, not
  // through LSH, and need less shared structure: the name is evidence of its own.
  const byName = new Map();
  big.forEach((u, idx) => { if (CONVENTIONAL_NAMES.has(u.name)) return; if (!byName.has(u.name)) byName.set(u.name, []); byName.get(u.name).push(idx); });
  const pairSim = new Map();
  for (const list of [...buckets.values(), ...byName.values()]) {
    if (list.length < 2 || list.length > 60) continue; // huge buckets are boilerplate shapes
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = big[list[i]], b = big[list[j]];
      if (a.near === b.near || a.pkgId === b.pkgId) continue; // same near group is already reported; cross-package only
      const k = list[i] < list[j] ? `${list[i]}:${list[j]}` : `${list[j]}:${list[i]}`;
      if (pairSim.has(k)) continue;
      let sim = jaccard(a.shingles, b.shingles);
      // Same shape with different content (icon sets, translated copies) is not a copy:
      // the literal values must overlap too, as the near-match rule requires.
      if (sim < similarFloor(a.name, b.name, opts) || literalOverlap(a, b) < 0.5) sim = 0;
      pairSim.set(k, sim);
    }
  }
  const parent = big.map((_, i) => i);
  const findRoot = (i) => (parent[i] === i ? i : (parent[i] = findRoot(parent[i])));
  const simPairs = [];
  for (const [k, sim] of [...pairSim.entries()].sort()) {
    if (!sim) continue;
    const [i, j] = k.split(":").map(Number);
    simPairs.push({ i, j, sim });
    parent[findRoot(i)] = findRoot(j);
  }
  const comps = new Map();
  for (const p of simPairs) for (const i of [p.i, p.j]) { const r = findRoot(i); if (!comps.has(r)) comps.set(r, new Set()); comps.get(r).add(i); }
  let similarGroups = 0;
  for (const [, set] of [...comps.entries()].sort((a, b) => a[0] - b[0])) {
    const members = [...set].map((i) => big[i]).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    // Pull in the near-identical siblings of every member, so the group is complete.
    const nears = new Set(members.map((m) => m.near));
    for (const u of units) if (nears.has(u.near) && !members.includes(u)) members.push(u);
    members.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const pkgs = [...new Set(members.map((m) => m.pkgId))].sort();
    if (pkgs.length < 2) continue;
    similarGroups++;
    const pairs = simPairs.filter((p) => set.has(p.i) && set.has(p.j)).map((p) => ({ a: `${big[p.i].file}:${big[p.i].line}`, b: `${big[p.j].file}:${big[p.j].line}`, similarity: Math.round(p.sim * 100) / 100 }));
    const sims = pairs.map((p) => p.similarity);
    const pub = members.filter((m) => m.public.length);
    pushFinding({
      kind: "duplicate.similar", class: pub.length ? "agent-guided" : "manual-review",
      locations: members.map(unitLoc).sort(cmpLoc),
      why: `${members.length} definitions across ${pkgs.length} packages share ${Math.round(Math.min(...sims) * 100)}–${Math.round(Math.max(...sims) * 100)}% of their structure but are not identical: statements were added, removed or written differently.${pub.length ? ` One of them is a public export (${pub[0].public[0].specifier}#${pub[0].public[0].exportName}).` : ""}`,
      evidence: { members: members.map(memberEvidence), pairs, packages: pkgs.map(pkgLabel) },
      nextAction: pub.length
        ? `Compare each copy with ${pub[0].public[0].specifier}#${pub[0].public[0].exportName}. Where the differences do not matter for that caller, import the export; settle doubts with a focused test.`
        : "Compare the copies. If they are meant to behave the same, decide whether one shared version should exist; if the differences are intentional, leave them.",
      stopConditions: ["Stop if the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent."],
      idSalt: members.map((m) => m.id).join("|"),
      ...membersKey(members),
    });
  }

  // ---------- module copies: most of one file's top-level definitions match another file's ----------
  const itemsByFile = new Map();
  for (const it of fileItems) { if (!itemsByFile.has(it.file)) itemsByFile.set(it.file, []); itemsByFile.get(it.file).push(it); }
  const filesByNear = new Map();
  for (const it of fileItems) { if (!filesByNear.has(it.near)) filesByNear.set(it.near, new Set()); filesByNear.get(it.near).add(it.file); }
  const simFilePairs = new Set(simPairs.map((p) => [big[p.i].file, big[p.j].file].sort().join("\0")));
  const shared = new Map(); // "fileA\0fileB" -> count of A's items with a match in B (and vice versa, symmetric approx.)
  for (const [near, files] of filesByNear) {
    if (files.size < 2 || files.size > 20) continue; // ubiquitous tiny shapes say nothing
    const fs_ = [...files].sort();
    for (let i = 0; i < fs_.length; i++) for (let j = i + 1; j < fs_.length; j++) {
      const k = fs_[i] + "\0" + fs_[j];
      shared.set(k, (shared.get(k) || 0) + 1);
    }
  }
  for (const k of simFilePairs) shared.set(k, (shared.get(k) || 0) + 1);
  const modParent = new Map();
  const mFind = (x) => { if (!modParent.has(x)) modParent.set(x, x); const p = modParent.get(x); if (p === x) return x; const r = mFind(p); modParent.set(x, r); return r; };
  const modPairs = [];
  for (const [k, n] of [...shared.entries()].sort()) {
    const [a, b] = k.split("\0");
    const na = itemsByFile.get(a).length, nb = itemsByFile.get(b).length;
    if (n < opts.moduleMinShared || n / Math.max(na, nb) < opts.moduleMinRatio) continue;
    modPairs.push({ a, b, shared: n, ratio: Math.round((n / Math.max(na, nb)) * 100) / 100 });
    modParent.set(mFind(a), mFind(b));
  }
  const modComps = new Map();
  for (const p of modPairs) for (const f of [p.a, p.b]) { const r = mFind(f); if (!modComps.has(r)) modComps.set(r, new Set()); modComps.get(r).add(f); }
  for (const [, files] of [...modComps.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const fl = [...files].sort();
    const pkgs = [...new Set(fl.map((f) => itemsByFile.get(f)[0].pkgId))].sort();
    const pairs = modPairs.filter((p) => files.has(p.a) && files.has(p.b));
    const names = (f) => itemsByFile.get(f).map((i) => i.name).sort();
    pushFinding({
      kind: "duplicate.module", class: "manual-review",
      locations: fl.map((f) => ({ file: f, line: 1, col: 1 })),
      why: `${fl.length} files are copies of each other as modules: ${pairs.map((p) => `${p.shared} of ${Math.max(itemsByFile.get(p.a).length, itemsByFile.get(p.b).length)} top-level definitions match between ${p.a.split("/").pop()} and ${p.b.split("/").pop()}`).join("; ")}${pkgs.length > 1 ? `, across ${pkgs.length} packages` : ""}.`,
      evidence: { files: fl.map((f) => ({ file: f, package: pkgLabel(itemsByFile.get(f)[0].pkgId), definitions: names(f) })), pairs },
      nextAction: "Treat these as one module when deciding: share the whole file (one module everyone imports) or keep the copies, rather than deduplicating function by function.",
      stopConditions: ["Stop if the files belong to apps that must deploy and change independently."],
      idSalt: fl.join("|"),
      stable: fl.map((f) => `${f}|${itemsByFile.get(f).map((i) => i.exact).sort().join(",")}`),
      anchorParts: fl,
    });
  }

  // ---------- boundary bypasses (deep / relative cross-package imports) ----------
  const bindingsByRec = new Map();
  for (const b of bindings) { if (!bindingsByRec.has(b.rec)) bindingsByRec.set(b.rec, []); bindingsByRec.get(b.rec).push(b); }
  for (const m of moduleImports) {
    if (!m.toPkg || m.toPkg === m.fromPkg) continue;
    const target = pkgById.get(m.toPkg);
    const isRelative = m.spec.startsWith(".") || m.spec.startsWith("/");
    let bypass = null;
    if (isRelative) bypass = "relative path into another package";
    else if (m.res.viaName && m.spec !== m.res.viaName) {
      const exp = target.json && target.json.exports;
      if (exp && typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."))) {
        const sub = "./" + m.spec.slice(m.res.viaName.length + 1);
        const declared = Object.keys(exp).some((k) => k === sub || (k.includes("*") && sub.startsWith(k.split("*")[0]) && sub.endsWith(k.split("*")[1])));
        if (!declared) bypass = `subpath not declared in ${target.name}'s "exports"`;
      }
    }
    if (!bypass) continue;
    const bs = (bindingsByRec.get(m) || []).filter((b) => b.kind !== "namespace-member");
    const entry = (entries.get(m.toPkg) || []).find((e) => e.specifier === target.name);
    const entryPublic = (k) => (publicByDecl.get(k) || []).find((p) => p.pkgId === m.toPkg && p.specifier === target.name);
    const resolved = bs.map((b) => ({ local: b.local, imported: b.importedName, viaEntry: b.targetKey ? entryPublic(b.targetKey) : null }));
    const allViaEntry = bs.length > 0 && resolved.every((r) => r.viaEntry);
    const depDeclared = target.name && dependsOnDeclared(pkgById.get(m.fromPkg), target.name);
    let cls; let nextAction;
    const loading = entry ? loadingChanges(m.fromAbs, entry.file, target.name) : { reasons: [], evidence: {} };
    if (!target.name || !entry) { cls = "manual-review"; nextAction = `${pkgLabel(m.toPkg)} has no resolvable public entry; decide whether it should expose this module.`; }
    else if (!allViaEntry) { cls = "manual-review"; nextAction = `Some bindings are not part of ${target.name}'s public entry (${resolved.filter((r) => !r.viaEntry).map((r) => r.imported).join(", ") || "side-effect import"}). Exposing them is a library API decision.`; }
    else if (!depDeclared) { cls = "agent-guided"; nextAction = `Every binding is available from "${target.name}", but ${pkgLabel(m.fromPkg)} does not declare that dependency. Declare it, then import from the entry.${loading.reasons.length ? " Also: " + loading.reasons.join(" ") : ""}`; }
    else if (rulesAgainst(m.fromPkg, target.name, m.toPkg).length) { const rh = rulesAgainst(m.fromPkg, target.name, m.toPkg); cls = "manual-review"; nextAction = `Do not switch to "${target.name}" without the team: importing it would break architecture rule ${rh.map((r) => `"${r.id}"`).join(", ")}${rh[0].message ? ` (${rh[0].message})` : ""}. Where this code should come from is their decision.`; }
    else if (loading.blocking) { cls = "manual-review"; nextAction = `Do not switch to "${target.name}": ${loading.reasons.join(" ")} The library could expose these bindings from an entry without Node.js built-ins; that is a library API decision.`; }
    else if (m.kind === "side-effect" || loading.reasons.length) { cls = "agent-guided"; nextAction = `Every binding is available from "${target.name}", but the swap is not mechanical: ${loading.reasons.join(" ") || "this is a side-effect import."} Check that loading the entry is acceptable here (bundle, runtime, CSS), then import from the entry.`; }
    else { cls = "provable"; nextAction = `Import from "${target.name}" instead: ${resolved.map((r) => (r.viaEntry.exportName === r.local ? r.local : `${r.viaEntry.exportName} as ${r.local}`)).join(", ")}. Each binding resolves to the same declaration through the public entry, and the entry adds no side-effect imports to this file.`; }
    pushFinding({
      kind: "boundary.bypasses-package-entry", class: cls,
      locations: [{ file: m.file, line: m.line, col: m.col }],
      why: `${pkgLabel(m.fromPkg)} imports "${m.spec}" (${bypass}), reaching into ${pkgLabel(m.toPkg)} without going through its public entry.`,
      evidence: { moduleLoading: loading.evidence, specifier: m.spec, bypass, resolvedFile: fileKeyOf(m.res.file), bindings: resolved.map((r) => ({ local: r.local, imported: r.imported, availableFromEntry: r.viaEntry ? `${r.viaEntry.specifier}#${r.viaEntry.exportName}` : null })), dependencyDeclared: Boolean(depDeclared) },
      nextAction,
      stopConditions: cls === "provable" ? [] : ["Stop if the internal module is intentionally private to the library."],
      idSalt: m.spec,
      stable: [m.file, m.kind, m.spec, ...resolved.map((r) => `${r.imported}>${r.local}`).sort()],
      anchorParts: [m.file, m.spec],
    });
  }

  // ---------- architecture rules (ast-layer.rules.json at the root of each root) ----------
  let ruleChecks = 0;
  if (ruleSet.length) for (const m of moduleImports) {
    if (m.isTestFile && !opts.includeTests) continue;
    const fromP = pkgById.get(m.fromPkg);
    // What the import points to: another analyzed package, a workspace package
    // that did not resolve, or an external module. Same-package and federated
    // imports have no target, so only `toSpecifier` rules can match them.
    let target = null;
    if (m.toPkg && m.toPkg !== m.fromPkg) { const t = pkgById.get(m.toPkg); target = { name: t.name, dir: t.dir, id: t.id }; }
    else if (m.res.kind === "unresolved-workspace") { const t = P.workspaceByName.get(m.res.viaName); target = t ? { name: t.name, dir: t.dir, id: t.id } : { name: m.res.viaName }; }
    else if (m.res.kind === "external") target = { name: bareName(m.spec) };
    ruleChecks++;
    for (const rule of brokenRules(ruleSet, { root: fromP.root, from: { name: fromP.name, dir: fromP.dir }, spec: m.spec, target, typeOnly: m.typeOnly })) {
      pushFinding({
        kind: "architecture.rule-violation", class: "manual-review",
        locations: [{ file: m.file, line: m.line, col: m.col }],
        why: `${pkgLabel(m.fromPkg)} imports "${m.spec}"${target ? ` (${target.id ? pkgLabel(target.id) : target.name})` : ""}${m.typeOnly ? " (type-only)" : ""}, which architecture rule "${rule.id}" forbids${rule.message ? `: ${rule.message}` : "."}`,
        evidence: { rule: { id: rule.id, from: rule.from, to: rule.to || null, toSpecifier: rule.toSpecifier || null, except: rule.except || [], includeTypeOnly: Boolean(rule.includeTypeOnly), message: rule.message || null }, rulesFile: `${rule.root}/${RULES_FILE}`, specifier: m.spec, fromPackage: pkgLabel(m.fromPkg), toPackage: target ? (target.id ? pkgLabel(target.id) : target.name) : null, typeOnly: m.typeOnly },
        nextAction: `Do not add more imports like this one${rule.message ? ` (${rule.message})` : ""}. Changing this existing import, or the rule, is a team decision: present the rule, this import and where the code could come from instead.`,
        stopConditions: ["Stop if the rule looks outdated: the rules file is the team's decision, so propose changing it instead of working around it."],
        stable: [rule.root, rule.id, m.file, m.spec, String(m.typeOnly)],
      });
    }
  }
  observations.architectureRules = ruleSet.map((r) => ({ root: r.root, id: r.id, from: r.from, to: r.to || null, toSpecifier: r.toSpecifier || null, allow: r.allow, except: r.except || [], includeTypeOnly: Boolean(r.includeTypeOnly), message: r.message || null, text: describeRule(r) }));

  // ---------- package cycles ----------
  for (const scc of tarjan([...new Set([...disc.packages.map((p) => p.id)])].sort(), runtimeAdj)) {
    if (scc.length < 2) continue;
    const inScc = new Set(scc);
    const es = edgeList.filter((e) => inScc.has(e.from) && inScc.has(e.to) && e.importStatements > e.typeOnlyStatements);
    pushFinding({
      kind: "graph.package-cycle", class: "manual-review",
      locations: es.map((e) => e.samples[0]).filter(Boolean).map(({ file, line, col }) => ({ file, line, col })).sort(cmpLoc),
      why: `Runtime import cycle between ${scc.length} packages: ${scc.map(pkgLabel).join(" ↔ ")}.`,
      evidence: { packages: scc.map(pkgLabel), edges: es.map((e) => ({ from: pkgLabel(e.from), to: pkgLabel(e.to), importStatements: e.importStatements, samples: e.samples })) },
      nextAction: "Decide which direction the dependency should flow, then move the shared piece down into a package both can depend on.",
      stopConditions: ["Do not break the cycle by duplicating code."],
      idSalt: scc.join(","),
      stable: scc,
    });
  }

  // ---------- module federation contracts ----------
  const containers = new Map();
  for (const c of fedConfigs) if (c.name && !containers.has(c.name)) containers.set(c.name, c);
  const remotesByPkg = new Map();
  for (const c of fedConfigs) for (const [alias, target] of Object.entries(c.remotes)) {
    if (!remotesByPkg.has(c.pkgId)) remotesByPkg.set(c.pkgId, new Map());
    remotesByPkg.get(c.pkgId).set(alias, { target, config: c });
  }
  for (const c of [...containers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const pkg = pkgById.get(c.pkgId);
    const exposes = Object.entries(c.exposes).sort((a, b) => a[0].localeCompare(b[0])).map(([key, p]) => {
      const abs = typeof p === "string" ? probe(path.resolve(pkg.absDir, p), fileSet) : null;
      return { key, path: p, resolvedFile: abs ? fileKeyOf(abs) : null };
    });
    observations.federation.containers.push({ name: c.name, package: pkgLabel(c.pkgId), config: `${c.loc.file}:${c.loc.line}`, exposes, remotes: c.remotes, shared: c.shared });
    for (const e of exposes) if (typeof e.path === "string" && !e.resolvedFile) {
      pushFinding({
        kind: "federation.expose-file-missing", class: "agent-guided",
        locations: [c.loc],
        why: `Container "${c.name}" exposes "${e.key}" → "${e.path}", which does not resolve to an analyzed source file.`,
        evidence: { container: c.name, expose: e.key, path: e.path },
        nextAction: "Check whether the file moved or is generated at build time; fix the path or the build step.",
        stopConditions: ["Stop if the file is produced by a build step outside the analyzed sources."],
        idSalt: e.key,
        stable: [c.name, c.pkgId, e.key, String(e.path)],
      });
    }
  }
  for (const m of moduleImports) {
    if (m.res.kind !== "federated") continue;
    const remotes = remotesByPkg.get(m.fromPkg);
    if (!remotes) continue;
    const alias = m.spec.split("/")[0];
    if (!remotes.has(alias)) continue;
    const { target } = remotes.get(alias);
    const exposeKey = m.spec === alias ? "." : "./" + m.spec.slice(alias.length + 1);
    const container = target && containers.get(target);
    if (!container) { observations.federation.remotesOutsideGroup.push({ file: m.file, line: m.line, spec: m.spec, remote: target || "<dynamic>" }); continue; }
    const keys = Object.keys(container.exposes);
    const hit = keys.find((k) => k === exposeKey || k.replace(/\.[cm]?[jt]sx?$/, "") === exposeKey);
    if (hit) observations.federation.matchedImports.push({ file: m.file, line: m.line, spec: m.spec, container: target, expose: hit });
    else pushFinding({
      kind: "federation.import-not-exposed", class: "agent-guided",
      locations: [{ file: m.file, line: m.line, col: m.col }],
      why: `"${m.spec}" is a federated import of remote "${target}", but that container does not expose "${exposeKey}" (it exposes: ${keys.sort().join(", ") || "nothing"}).`,
      evidence: { specifier: m.spec, remote: target, exposeKey, containerConfig: `${container.loc.file}:${container.loc.line}`, exposes: keys.sort() },
      nextAction: "Fix the import or add the expose in the remote. The import fails at runtime either way.",
      stopConditions: ["Stop if the remote is versioned separately and a newer deployed version may expose this key."],
      stable: [m.file, m.spec, target],
    });
  }

  // Federated "homes": a container every package with a copy already consumes.
  const consumersOf = new Map(); // container name -> Set(pkgId)
  for (const mi of observations.federation.matchedImports) {
    const pkgId = fileByKey.get(mi.file) ? fileByKey.get(mi.file).pkgId : null;
    if (!pkgId) continue;
    if (!consumersOf.has(mi.container)) consumersOf.set(mi.container, new Set());
    consumersOf.get(mi.container).add(pkgId);
  }
  for (const f of findings) {
    if (!f._pkgIds) continue;
    const pkgs = f._pkgIds; delete f._pkgIds;
    if (!containers.size) continue;
    const fedHomes = [...containers.values()].filter((c) => pkgs.every((p) => p === c.pkgId || (consumersOf.get(c.name) || new Set()).has(p))).map((c) => `${c.name} (${pkgLabel(c.pkgId)})`).sort();
    f.evidence.candidateFederatedHomes = fedHomes;
    f.evidence.candidateHomesNote += fedHomes.length
      ? ` Through Module Federation, every package with a copy already consumes ${fedHomes.join(", ")}; exposing it there is the other option.`
      : " No federation container is consumed by every package with a copy either.";
  }

  // ---------- package name collisions ----------
  for (const name of [...new Set(P.nameCollisions.map((c) => c.name))].sort()) {
    const c = { name };
    const all = disc.packages.filter((p) => p.name === c.name);
    pushFinding({
      kind: "packages.duplicate-name", class: "manual-review",
      locations: all.map((p) => ({ file: `${p.root}/${p.dir === "." ? "" : p.dir + "/"}package.json`, line: 1, col: 1 })),
      why: `${all.length} packages declare the same name "${c.name}". Imports by that name resolve to only one of them (${all[0].id}), and publishing or workspace tooling will conflict.`,
      evidence: { name: c.name, packages: all.map((p) => p.id) },
      nextAction: "Give each package a unique name (often a copy-paste leftover).",
      stopConditions: ["Stop if these are intentionally alternative implementations selected at build time."],
      idSalt: c.name,
      stable: [c.name, ...all.map((p) => p.id)],
    });
  }

  // ---------- dependency version drift ----------
  const sharedNames = new Set(fedConfigs.flatMap((c) => c.shared));
  const ranges = new Map();
  for (const p of disc.packages) for (const field of ["dependencies", "peerDependencies"]) for (const [dep, r] of Object.entries(p.declaredDeps[field])) {
    if (typeof r !== "string" || /^(workspace|catalog|link|file|portal):/.test(r)) continue;
    if (!ranges.has(dep)) ranges.set(dep, new Map());
    const m = ranges.get(dep);
    if (!m.has(r)) m.set(r, new Set());
    m.get(r).add(p.id);
  }
  for (const [dep, m] of [...ranges.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (m.size < 2) continue;
    const byRange = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([r, ids]) => ({ range: r, packages: [...ids].sort().map(pkgLabel) }));
    const ids = [...new Set([...m.values()].flatMap((s) => [...s]))].sort();
    pushFinding({
      kind: "deps.version-drift", class: "manual-review",
      locations: ids.map((id) => ({ file: `${pkgById.get(id).root}/${pkgById.get(id).dir === "." ? "" : pkgById.get(id).dir + "/"}package.json`, line: 1, col: 1 })),
      why: `${dep} is declared with ${m.size} different ranges across ${ids.length} packages${sharedNames.has(dep) ? "; it is also a Module Federation shared dependency, where mismatches can load two copies at runtime" : ""}.`,
      evidence: { dependency: dep, ranges: byRange, federatedShared: sharedNames.has(dep) },
      nextAction: "Decide on one range (or a catalog entry) for this dependency.",
      stopConditions: ["Stop if packages deploy independently and are meant to upgrade on their own schedule."],
      idSalt: dep,
      stable: [dep, JSON.stringify(byRange)],
      anchorParts: [dep],
    });
  }

  // ---------- stylesheets and locale messages ----------
  // Copies are grouped by the set of files that share them: two stylesheets
  // copied wholesale are one finding listing every shared token or block, not
  // one finding per token.
  const dependsOn = (p, L) => p === L || (pkgById.get(L).name && dependsOnDeclared(pkgById.get(p), pkgById.get(L).name)) || edges.has(`${p}\0${L}`);
  const homeOf = (pkgIds) => pkgIds.filter((L) => pkgById.get(L).name && pkgIds.every((p) => dependsOn(p, L))).sort();
  const fileOfKey = new Map([...disc.styleFiles, ...disc.localeFiles].map((f) => [f.key, f]));
  const styleStats = { files: disc.styleFiles.length, parseErrors: [], groupsToken: 0, groupsBlock: 0 };
  const tokenSites = new Map(); const blockSites = new Map();
  for (const f of disc.styleFiles) {
    const st = parseStyle(readText(f.abs) || "", f.abs);
    if (st.error) { styleStats.parseErrors.push(`${f.key} (${st.error})`); continue; }
    for (const t of st.tokens) { const k = `${t.name}\0${t.value}`; if (!tokenSites.has(k)) tokenSites.set(k, []); tokenSites.get(k).push({ file: f.key, pkgId: f.pkgId, line: t.line, name: t.name, value: t.value }); }
    for (const b of st.blocks) {
      if (b.count < opts.cssMinDeclarations || b.reset || b.trivial) continue;
      if (!blockSites.has(b.signature)) blockSites.set(b.signature, []);
      blockSites.get(b.signature).push({ file: f.key, pkgId: f.pkgId, line: b.line, selector: b.selector, count: b.count });
    }
  }
  /** Group shared items by the exact set of files that have them (cross-package items only). */
  const byFileSet = (sites) => {
    const groups = new Map();
    for (const [item, list] of [...sites.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (new Set(list.map((x) => x.pkgId)).size < 2) continue;
      const files = [...new Set(list.map((x) => x.file))].sort();
      const k = files.join("\0");
      if (!groups.has(k)) groups.set(k, { files, items: [] });
      groups.get(k).items.push({ item, list });
    }
    return [...groups.values()];
  };
  const firstLines = (g) => g.files.map((file) => ({ file, line: Math.min(...g.items.flatMap((i) => i.list.filter((x) => x.file === file).map((x) => x.line))), col: 1 }));
  // One shared custom property is usually an intentional override (measured on
  // unkey: the only single-token match re-points --color-background on purpose).
  for (const g of byFileSet(tokenSites).filter((x) => x.items.length >= opts.cssMinSharedTokens)) {
    styleStats.groupsToken++;
    const pkgs = [...new Set(g.files.map((f) => fileOfKey.get(f).pkgId))].sort();
    const homes = homeOf(pkgs);
    const tokens = g.items.map((i) => ({ name: i.list[0].name, value: i.list[0].value }));
    pushFinding({
      kind: "css.duplicate-token", class: "manual-review",
      locations: firstLines(g),
      why: `${tokens.length} custom propert${tokens.length > 1 ? "ies are" : "y is"} defined with the same value in ${pkgs.length} packages (${pkgs.map(pkgLabel).join(", ")}): ${tokens.slice(0, 4).map((t) => `${t.name}: ${t.value}`).join("; ")}${tokens.length > 4 ? `; ${tokens.length - 4} more` : ""}.${homes.length ? ` ${homes.map(pkgLabel).join(", ")} defines ${tokens.length > 1 ? "them" : "it"}, and every other package here already depends on it.` : ""}`,
      evidence: { tokens, files: g.files.map((f) => ({ file: f, package: pkgLabel(fileOfKey.get(f).pkgId) })), home: homes.map(pkgLabel) },
      nextAction: homes.length
        ? `Use the tokens from ${homes.map(pkgLabel).join(", ")} (import its stylesheet once) instead of redefining them; decide with the team whether app-level redefinitions are intentional overrides.`
        : "Decide whether these tokens should live in one shared stylesheet that the packages import; copies drift apart when one changes.",
      stopConditions: ["Stop if a package redefines the token on purpose to theme itself (an override that happens to match today)."],
      stable: [...g.files, ...tokens.map((t) => `${t.name}=${t.value}`)],
      anchorParts: g.files,
    });
  }
  for (const g of byFileSet(blockSites)) {
    styleStats.groupsBlock++;
    const pkgs = [...new Set(g.files.map((f) => fileOfKey.get(f).pkgId))].sort();
    const homes = homeOf(pkgs);
    const blocks = g.items.map((i) => ({ declarations: i.list[0].count, selectors: i.list.map((x) => `${x.selector} (${x.file}:${x.line})`) }));
    pushFinding({
      kind: "css.duplicate-rule-block", class: "manual-review",
      locations: firstLines(g),
      why: `${blocks.length} rule block${blocks.length > 1 ? "s" : ""} with the same ${blocks.length > 1 ? "declarations" : `${blocks[0].declarations} declarations`} (after normalizing order, whitespace and color case) appear${blocks.length > 1 ? "" : "s"} in ${pkgs.length} packages: ${blocks.slice(0, 2).map((b) => b.selectors.map((x) => x.split(" (")[0]).join(" = ")).join("; ")}${blocks.length > 2 ? `; ${blocks.length - 2} more` : ""}.`,
      evidence: { blocks, files: g.files.map((f) => ({ file: f, package: pkgLabel(fileOfKey.get(f).pkgId) })), home: homes.map(pkgLabel) },
      nextAction: homes.length
        ? `${homes.map(pkgLabel).join(", ")} already has this style and the other packages depend on it: decide whether to reuse its class instead of the copy.`
        : "Decide whether this style should be a shared class or component; if the copies are meant to evolve separately, leave them.",
      stopConditions: ["Stop if the selectors style different components that only look alike today."],
      stable: [...g.files, ...g.items.map((i) => i.item)],
      anchorParts: g.files,
    });
  }
  const localeStats = { files: disc.localeFiles.length, noLanguage: 0, parseErrors: [], groups: 0 };
  const locales = [];
  for (const f of disc.localeFiles) {
    const lang = localeLanguage(f.rel);
    if (!lang) { localeStats.noLanguage++; continue; }
    const m = flattenMessages(readText(f.abs) || "");
    if (m.error) { localeStats.parseErrors.push(`${f.key} (${m.error})`); continue; }
    if (m.pairs.size >= opts.i18nMinShared) locales.push({ file: f.key, pkgId: f.pkgId, lang, primary: lang.split("-")[0], pairs: m.pairs });
  }
  const locPairs = [];
  for (let i = 0; i < locales.length; i++) for (let j = i + 1; j < locales.length; j++) {
    const a = locales[i], b = locales[j];
    if (a.pkgId === b.pkgId || a.primary !== b.primary) continue;
    let shared = 0;
    for (const [k, v] of a.pairs) if (b.pairs.get(k) === v) shared++;
    const ratio = shared / Math.min(a.pairs.size, b.pairs.size);
    if (shared >= opts.i18nMinShared && ratio >= opts.i18nMinRatio) locPairs.push({ a: a.file, b: b.file, shared, ratio: Math.round(ratio * 100) / 100, sizes: [a.pairs.size, b.pairs.size] });
  }
  const locParent = new Map();
  const lFind = (x) => { if (!locParent.has(x)) locParent.set(x, x); const p = locParent.get(x); if (p === x) return x; const r = lFind(p); locParent.set(x, r); return r; };
  for (const p of locPairs) locParent.set(lFind(p.a), lFind(p.b));
  const locComps = new Map();
  for (const p of locPairs) for (const f of [p.a, p.b]) { const r = lFind(f); if (!locComps.has(r)) locComps.set(r, new Set()); locComps.get(r).add(f); }
  for (const [, set] of [...locComps.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    localeStats.groups++;
    const files = [...set].sort();
    const pairs = locPairs.filter((p) => set.has(p.a) && set.has(p.b));
    const pkgs = [...new Set(files.map((f) => fileOfKey.get(f).pkgId))].sort();
    const homes = homeOf(pkgs);
    const lang = locales.find((l) => l.file === files[0]).lang;
    pushFinding({
      kind: "i18n.duplicate-messages", class: "manual-review",
      locations: files.map((file) => ({ file, line: 1, col: 1 })),
      why: `${files.length} "${lang}" locale files in ${pkgs.length} packages share most of their messages: ${pairs.map((p) => `${p.shared} identical key/value pairs (${Math.round(p.ratio * 100)}% of the smaller file) between ${p.a.split("/").slice(-2).join("/")} and ${p.b.split("/").slice(-2).join("/")}`).join("; ")}.`,
      evidence: { language: lang, files: files.map((f) => ({ file: f, package: pkgLabel(fileOfKey.get(f).pkgId) })), pairs, home: homes.map(pkgLabel) },
      nextAction: homes.length
        ? `${homes.map(pkgLabel).join(", ")} already has these messages and the other packages depend on it: decide whether to load them from there.`
        : "Decide whether the shared messages should move to one package the others load; copied translations drift when only one copy is updated.",
      stopConditions: ["Stop if the apps ship and translate independently on purpose."],
      stable: [...files, ...pairs.map((p) => `${p.a}|${p.b}|${p.shared}`)],
      anchorParts: files,
    });
  }

  // ---------- observations (ledger, no action) ----------
  for (const p of disc.packages) {
    const consumers = incoming.get(p.id) ? [...incoming.get(p.id)].sort().map(pkgLabel) : [];
    observations.packages.push({ id: p.id, name: p.name, root: p.root, dir: p.dir, files: p.fileCount, role: consumers.length ? "library (imported by other analyzed packages)" : "leaf (not imported by other analyzed packages)", consumers, entries: (entries.get(p.id) || []).map((e) => ({ specifier: e.specifier, file: fileKeyOf(e.file) })), tsconfig: P.pkgOptions.get(p.id) && P.pkgOptions.get(p.id).configFile ? path.relative(p.absDir, P.pkgOptions.get(p.id).configFile) || "tsconfig.json" : null });
  }
  observations.packageEdges = edgeList.map((e) => ({ from: pkgLabel(e.from), to: pkgLabel(e.to), importStatements: e.importStatements, typeOnlyStatements: e.typeOnlyStatements, testOnlyStatements: e.testOnlyStatements, boundReferences: e.boundReferences }));
  const consumed = new Map();
  for (const b of bindings) if (b.targetKey && b.toPkg && b.fromPkg !== b.toPkg) { if (!consumed.has(b.targetKey)) consumed.set(b.targetKey, new Set()); consumed.get(b.targetKey).add(b.fromPkg); }
  const starTargets = new Set(starReexports.map((s) => s.toPkg));
  for (const p of disc.packages) {
    if (!incoming.has(p.id) || !p.name) continue;
    if (starTargets.has(p.id)) { observations.unconsumedPublicExports.push({ package: pkgLabel(p.id), note: "Not computed: another analyzed package re-exports this library with `export *`, so consumption cannot be attributed per symbol.", exports: [] }); continue; }
    const list = [];
    for (const [k, arr] of publicByDecl) {
      const mine = arr.filter((x) => x.pkgId === p.id);
      if (!mine.length || consumed.has(k)) continue;
      const [file, pos] = [k.slice(0, k.lastIndexOf("#")), k.slice(k.lastIndexOf("#") + 1)];
      list.push({ export: mine.map((x) => `${x.specifier}#${x.exportName}`).sort().join(", "), declaration: file, offset: Number(pos) });
    }
    list.sort((a, b) => a.export.localeCompare(b.export));
    if (list.length) observations.unconsumedPublicExports.push({ package: pkgLabel(p.id), note: "No analyzed package imports these. Consumers outside the analyzed roots are invisible to this tool.", count: list.length, exports: list });
  }
  observations.duplication = { unitsTotal: stats.unitsTotal, unitsFingerprinted: stats.unitsFingerprinted, exactClusters: clustersExact, nearClusters: clustersNear, nearGroupsRejectedByLiteralThreshold: rejectedNear, similarGroups, moduleCopies: modComps.size };
  observations.federation.remotesOutsideGroup.sort(cmpLoc);
  // Remote aliases each package resolves through federation (not the workspace): the edit hook needs them.
  observations.federation.remoteAliases = [...federatedAliases.entries()].map(([pkgId, set]) => ({ package: pkgId, aliases: [...set].sort() })).sort((a, b) => a.package.localeCompare(b.package));
  observations.federation.matchedImports.sort(cmpLoc);

  findings.sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class] || a.kind.localeCompare(b.kind) || cmpLoc(a.locations[0] || { file: "", line: 0, col: 0 }, b.locations[0] || { file: "", line: 0, col: 0 }) || a.id.localeCompare(b.id));
  // Two findings about the same thing (e.g. the same deep import twice in one
  // file) would share a key: number the repeats in report order.
  const keySeen = new Map();
  for (const f of findings) { const n = (keySeen.get(f.key) || 0) + 1; keySeen.set(f.key, n); if (n > 1) f.key = `${f.key}~${n}`; }

  // ---------- recorded decisions (ast-layer.decisions.json per root, plus user scope) ----------
  const decisionList = []; const decisionProblems = [];
  for (const r of disc.roots) { const d = parseDecisions(readText(path.join(r.abs, DECISIONS_FILE)), `${r.label}/${DECISIONS_FILE}`, "repo"); decisionList.push(...d.decisions); decisionProblems.push(...d.problems); }
  for (const u of ctx.userDecisionFiles || []) { const d = parseDecisions(readText(u.abs), `user decisions for ${u.root}`, "user"); decisionList.push(...d.decisions); decisionProblems.push(...d.problems); }
  const decisionStats = applyDecisions(findings, decisionList);

  // Only packages meant to be imported: they declare an entry, or another package imports them by name.
  const importedByName = new Set(stats.unresolvedWorkspace.map((u) => u.viaName));
  const unresolvedEntries = disc.packages.filter((p) => p.name && p.fileCount && !(entries.get(p.id) || []).length && (p.json.exports || p.json.main || p.json.module || p.json.types || importedByName.has(p.name)))
    .map((p) => { const j = p.json || {}; const decl = j.exports ? "exports" : j.main ? "main" : j.module ? "module" : null; return `${p.displayName}${decl ? ` (its "${decl}" points to ${JSON.stringify(typeof j[decl] === "string" ? j[decl] : decl === "exports" ? Object.values(j.exports)[0] : j[decl]).slice(0, 60)})` : " (declares no entry)"}`; });
  const limits = [
    "Every record is an observation about the code, not a verdict. A run with no findings is not a readiness or quality result.",
    `Only JavaScript/TypeScript is analyzed (${Object.keys(disc.skipped.byExt).length ? "skipped: " + Object.entries(disc.skipped.byExt).sort().map(([k, v]) => `${v} ${k}`).join(", ") : "no other source languages were seen"}).`,
    `Excluded from analysis: ${Object.entries(disc.skipped.byReason).sort().map(([k, v]) => `${v} × ${k}`).join(", ") || "nothing"}.`,
    `External packages are never resolved, by design (results do not depend on node_modules). ${stats.externalSpecifiers.size} distinct external packages were imported.`,
    `${stats.unresolvedRelative.length} relative import(s) and ${stats.unresolvedWorkspace.length} workspace-package import(s) did not resolve to an analyzed file; bindings through them are unknown.`,
    `${stats.dynamicNonLiteral} dynamic import()/require() call(s) with non-literal specifiers were not followed.`,
    `Duplication: top-level functions, components and classes with at least ${opts.minNodes} AST nodes and ${opts.minLines} lines${opts.includeTests ? "" : ", excluding tests and stories"}. Normalization ignores formatting and comments and renames locally-bound identifiers; free identifiers keep their names. "near" also abstracts literals and types and is only reported when at most ${opts.nearMaxDiffPositions} literal positions differ and the differing characters are at most ${opts.nearSmallDiffChars} or ${Math.round(opts.nearMaxDiffCharRatio * 100)}% of all literal characters. "similar" groups (cross-package only) need ${opts.similarMinNodes}+ AST nodes and ${Math.round(opts.similarThreshold * 100)}% shared structure (5-token shingles over the "near" stream with every local as one token, MinHash candidates), or ${Math.round(opts.similarSameNameThreshold * 100)}% when both definitions have the same name (framework names such as GET, default or Page excluded; compared directly, without MinHash), plus at least half of their literal values in common. A copy that was renamed and rewritten below 80% is not seen. Module copies need ${opts.moduleMinShared}+ matching top-level definitions covering ${Math.round(opts.moduleMinRatio * 100)}% of the larger file. Structural similarity is not semantic equivalence.`,
    "\"provable\" means: identical structure, literals and types, every free identifier resolves to the same declaration, and the dependency already exists. It does not cover behavior that depends on module identity (instanceof across copies, module-level state reached indirectly).",
    "Module Federation configs are read statically from literal objects in *.config.* files; remotes built at runtime are not followed.",
    `Package roles are observed from imports between analyzed packages only. ${P.nameCollisions.length ? `Package name collisions (first wins): ${P.nameCollisions.map((c) => `${c.name} [${c.packages.join(", ")}]`).join("; ")}.` : ""}`.trim(),
    `${stats.parseErrorFiles} file(s) had syntax errors; their facts may be partial.`,
    `Similar code on edit and in find_equivalent: units with ${opts.similarMinNodes}+ AST nodes are compared against the index with the same rule as "similar" groups (${Math.round(opts.similarThreshold * 100)}% shared 5-token shingles after MinHash/LSH candidates, or ${Math.round(opts.similarSameNameThreshold * 100)}% against units with the same name, half of the literal values in common, other packages only when the package is known). LSH can miss a pair of different names near the threshold (about 2% at exactly ${Math.round(opts.similarThreshold * 100)}%).`,
    "Scan reuse: a session start reuses the last scan when its signature matches (path, size and mtime of every analyzed file; content of package.json, tsconfig/jsconfig and ast-layer.*.json files; tool version and options) and no edit was recorded since. A change that keeps a file's size and mtime is only seen by an explicit scan. Incremental rebuilds reuse a file's parse only when its text is unchanged and give the same result as a full scan.",
    ruleSet.length
      ? `Architecture rules: ${ruleSet.length} rule(s) from ${RULES_FILE} in ${[...new Set(ruleSet.map((r) => r.root))].join(", ")}, checked against ${ruleChecks} import statement(s). \`from\`/\`to\` match package names or directories (a bare * matches every package); \`to\` matches analyzed packages and external module names, never Module Federation remotes; type-only imports count only with includeTypeOnly${opts.includeTests ? "" : "; test files are not checked"}. An allow rule that matches an import cancels the deny rules for it.`
      : `No ${RULES_FILE} in any root: no architecture rules were checked.`,
    ...ruleProblems,
    decisionList.length
      ? `Decisions: ${decisionList.length} recorded (${decisionList.filter((d) => d.scope === "repo").length} in ${DECISIONS_FILE}, ${decisionList.filter((d) => d.scope === "user").length} user-scope); ${decisionStats.applied} apply (status "decided": left out of the session note and edit warnings), ${decisionStats.outdated} are outdated because the code changed (the finding is shown again with previousDecision), ${decisionStats.unmatched} match no finding. A decision applies only to the exact finding key it was recorded for.`
      : `No recorded decisions (${DECISIONS_FILE}).`,
    ...decisionProblems,
    `Styles and messages: ${styleStats.files} CSS/SCSS file(s) parsed with postcss/postcss-scss${styleStats.parseErrors.length ? ` (${styleStats.parseErrors.length} could not be parsed: ${styleStats.parseErrors.slice(0, 3).join("; ")})` : ""} and ${localeStats.files} locale JSON file(s)${localeStats.noLanguage ? ` (${localeStats.noLanguage} without a recognizable ISO 639-1 language in the name or path, not compared)` : ""}${localeStats.parseErrors.length ? `; ${localeStats.parseErrors.length} invalid JSON` : ""}. Custom properties count when files in 2+ packages define ${opts.cssMinSharedTokens}+ of the same names with the same normalized values (a single shared property is usually an override; SCSS/Less variables are not read). Rule blocks need ${opts.cssMinDeclarations}+ non-custom declarations, identical after normalizing order, whitespace and color case, in 2+ packages; reset/base selectors (only elements, *, :root), @keyframes steps and blocks whose values are all trivial (0, none, auto...) are skipped. Locale files of the same language in different packages are reported when they share ${opts.i18nMinShared}+ identical key/value pairs covering ${Math.round(opts.i18nMinRatio * 100)}% of the smaller file; the same text under a different key path (global.common.copied vs common.copied) does not count, and apps that share many messages inside large files of their own stay below the ratio. Identical rule blocks can be generic layout (a flex column with a gap) on unrelated selectors. Not seen: CSS-in-JS, utility classes (Tailwind), styles from node_modules; the post-edit hook checks JS/TS only.`,
    "Local telemetry (stats): the hooks append to hook-log.jsonl in the plugin data dir and nothing is sent anywhere. A warned unit counts as \"warning followed\" when no unit with its name or code is in the file at its next edit (or on disk when stats runs; a deleted file counts as followed); a copy that was renamed and changed counts as followed.",
    "Verified fixes (propose_fix / fix) exist only for provable duplicate.reinvents-library-export and boundary.bypasses-package-entry findings. Verification compares syntactic and semantic diagnostics of the edited files and their direct importers before and after, in this tool's program (no lib files, external packages unresolved), and re-runs the analysis: it proves the change adds no error that program can see and removes the finding without creating another. A finding with the same anchor that only got smaller (no more locations; for module copies, no pair sharing more definitions) is not counted as new and is listed in shrunkFindings. It does not run the project's build or tests.",
    "Finding keys are built from what a finding is about (member files, names, packages, code hashes, specifiers), never from line numbers: moving code within a file keeps the key; editing the code, renaming the file or the package changes it.",
    unresolvedEntries.length
      ? `Blind spot: ${unresolvedEntries.length} named package(s) have no public entry that resolves to analyzed source, so copies of their exports cannot be detected and imports of them are not bound: ${unresolvedEntries.join("; ")}.`
      : "Every named package with source files has a public entry that resolves to analyzed source.",
  ];

  // Units large enough for "similar" carry their MinHash in the index; their
  // shingles and literal values (needed for the exact check) go to similar.json.
  const index = units.map((u) => ({ id: u.id, name: u.name, package: pkgLabel(u.pkgId), file: u.file, line: u.line, lines: u.lines, nodes: u.nodes, exact: u.exact, near: u.near, public: u.public.map((p) => `${p.specifier}#${p.exportName}`), ...(u.minhash && u.shingles.length >= 8 ? { minhash: encodeU32(u.minhash) } : {}) })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
  const similarData = Object.fromEntries(big.map((u) => [u.id, { shingles: encodeU32(u.shingles), literals: u.literals.map((l) => l.v) }]).sort((a, b) => a[0].localeCompare(b[0])));

  const summary = { files: stats.files, packages: disc.packages.length, findings: findings.length, byClass: countBy(findings, "class"), byKind: countBy(findings, "kind"), decided: findings.filter((f) => f.status === "decided").length };
  // Who imports each file (internal, for verifying a proposed fix).
  const importers = new Map();
  for (const m of moduleImports) if (m.res.kind === "workspace") { if (!importers.has(m.res.file)) importers.set(m.res.file, new Set()); importers.get(m.res.file).add(m.fromAbs); }
  return {
    disc, importers,
    program: P.program,
    incremental: P.sourceFileStats,
    signature: signatureOf(disc, opts),
    report: { tool: TOOL, options: opts, roots: disc.roots.map((r) => ({ label: r.label, listing: disc.listing.find((l) => l.root === r.label).source })), summary, limits, findings, observations },
    index: {
      tool: TOOL, units: index,
      names: nameInventory.map((n) => ({ name: n.name, package: pkgLabel(n.pkgId), file: n.file, line: n.line, exported: fileExportedDecls.has(n.declKey), public: (publicByDecl.get(n.declKey) || []).filter((p) => p.pkgId === n.pkgId).map((p) => `${p.specifier}#${p.exportName}`).sort() })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name)),
      publicExports: publicInventory.sort((a, b) => a.specifier.localeCompare(b.specifier) || a.exportName.localeCompare(b.exportName) || a.file.localeCompare(b.file)),
    },
    similar: { tool: TOOL, units: similarData },
  };
}

export function discoverFor(rootPaths, opts = {}, ctx = {}) {
  return discover(rootPaths, { includeTests: Boolean(opts.includeTests), rootLabels: ctx.rootLabels });
}

/** The signature of a scan of `disc` with `userOpts` (see cache.js); `extraFiles` are inputs outside the roots. */
export function signatureOf(disc, userOpts = {}, extraFiles = []) {
  return scanSignature(disc, { tool: TOOL, opts: { ...DEFAULTS, ...userOpts } }, extraFiles);
}

function directiveOf(sf) {
  for (const st of sf.statements) {
    if (st.kind !== K.ExpressionStatement || !ts.isStringLiteral(st.expression)) break;
    if (st.expression.text === "use client" || st.expression.text === "use server") return st.expression.text;
  }
  return null;
}

function countBy(arr, k) {
  const m = {};
  for (const x of arr) m[x[k]] = (m[x[k]] || 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])));
}

function literalDiff(members) {
  const n = Math.min(...members.map((m) => m.literals.length));
  const positions = [];
  let diffChars = 0;
  const totalChars = Math.max(...members.map((m) => m.literals.reduce((s, l) => s + l.len, 0)));
  for (let i = 0; i < n; i++) {
    const vals = members.map((m) => m.literals[i].v);
    if (new Set(vals).size > 1) {
      positions.push({ position: i, values: [...new Set(vals)].sort() });
      diffChars += Math.max(...members.map((m) => m.literals[i].len));
    }
  }
  return { positions, diffChars, totalChars };
}

function tarjan(nodes, adj) {
  let index = 0; const st = []; const on = new Set(); const idx = new Map(); const low = new Map(); const out = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++; st.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); out.push(c.sort()); }
  };
  for (const v of nodes) if (!idx.has(v)) strong(v);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

function extractFederation(sf, f, locOf) {
  const out = [];
  const propName = (p) => (p.name && (p.name.kind === K.Identifier || ts.isStringLiteralLike(p.name)) ? p.name.text : null);
  const strVal = (e) => (e && ts.isStringLiteralLike(e) ? e.text : null);
  const visit = (n) => {
    if (n.kind === K.ObjectLiteralExpression) {
      const props = new Map();
      for (const p of n.properties) if (p.kind === K.PropertyAssignment && propName(p)) props.set(propName(p), p.initializer);
      if (props.has("name") && (props.has("remotes") || props.has("exposes")) && strVal(props.get("name"))) {
        const exposes = {}; const remotes = {}; let shared = [];
        const ex = props.get("exposes");
        if (ex && ex.kind === K.ObjectLiteralExpression) for (const p of ex.properties) if (p.kind === K.PropertyAssignment && propName(p)) {
          let v = strVal(p.initializer);
          if (!v && p.initializer.kind === K.ObjectLiteralExpression) { const imp = p.initializer.properties.find((q) => propName(q) === "import"); v = imp ? strVal(imp.initializer) : null; }
          exposes[propName(p)] = v || "<dynamic>";
        }
        const re = props.get("remotes");
        if (re && re.kind === K.ObjectLiteralExpression) for (const p of re.properties) if (p.kind === K.PropertyAssignment && propName(p)) {
          let v = strVal(p.initializer);
          if (!v && p.initializer.kind === K.TemplateExpression) v = p.initializer.head.text;
          if (!v && p.initializer.kind === K.ObjectLiteralExpression) { const ext = p.initializer.properties.find((q) => propName(q) === "external" || propName(q) === "entry"); v = ext ? strVal(ext.initializer) : null; }
          remotes[propName(p)] = v && v.includes("@") ? v.split("@")[0] : propName(p);
        }
        const sh = props.get("shared");
        if (sh && sh.kind === K.ObjectLiteralExpression) shared = sh.properties.map(propName).filter(Boolean);
        else if (sh && sh.kind === K.ArrayLiteralExpression) shared = sh.elements.map(strVal).filter(Boolean);
        out.push({ name: strVal(props.get("name")), pkgId: f.pkgId, loc: locOf(sf, n), exposes, remotes, shared: [...new Set(shared)].sort() });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
