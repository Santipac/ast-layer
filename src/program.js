// One TypeScript Program for the whole analyzed group (all roots), with
// per-package module resolution. One checker means a symbol has one identity
// across packages and repos, which is what makes cross-package binding
// resolution possible. External packages are never resolved, by design:
// results do not depend on whether node_modules is installed.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const RESOLVE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function readTsconfig(pkg, workspaceByName, rootAbs) {
  // Nearest tsconfig/jsconfig from the package dir up to its root.
  let dir = pkg.absDir;
  for (;;) {
    for (const n of ["tsconfig.json", "jsconfig.json"]) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return parseConfig(p, workspaceByName);
    }
    if (dir === rootAbs || !dir.startsWith(rootAbs)) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { options: {}, configFile: null, errors: 0 };
}

function parseConfig(configPath, workspaceByName) {
  const host = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [], // we only need options, never the file list
    fileExists: (f) => fs.existsSync(f),
    readFile: (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return undefined; } },
  };
  const read = ts.readConfigFile(configPath, host.readFile);
  if (read.error || !read.config) return { options: {}, configFile: configPath, errors: 1 };
  // Rewrite `extends` that point at workspace packages (not installed) to their real files.
  const cfg = read.config;
  const fix = (e) => {
    if (typeof e !== "string" || e.startsWith(".") || path.isAbsolute(e)) return e;
    for (const [name, pkg] of workspaceByName) {
      if (e === name) return path.join(pkg.absDir, "tsconfig.json");
      if (e.startsWith(name + "/")) {
        const rest = e.slice(name.length + 1);
        const p = path.join(pkg.absDir, rest);
        return fs.existsSync(p) ? p : p.endsWith(".json") ? p : p + ".json";
      }
    }
    return e;
  };
  if (cfg.extends) cfg.extends = Array.isArray(cfg.extends) ? cfg.extends.map(fix) : fix(cfg.extends);
  const parsed = ts.parseJsonConfigFileContent(cfg, host, path.dirname(configPath), undefined, configPath);
  return { options: parsed.options, configFile: configPath, errors: parsed.errors.length };
}

// Candidate source files for a workspace package specifier ("@org/ui" or "@org/ui/button").
function workspaceCandidates(pkg, subpath) {
  const j = pkg.json || {};
  const out = [];
  const add = (rel) => { if (typeof rel === "string") out.push(rel); };
  const leaves = (v) => {
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.flatMap(leaves);
    if (v && typeof v === "object") {
      const order = ["source", "development", "types", "import", "module", "default", "require", "node", "browser"];
      const keys = [...order.filter((k) => k in v), ...Object.keys(v).filter((k) => !order.includes(k)).sort()];
      return keys.flatMap((k) => leaves(v[k]));
    }
    return [];
  };
  const key = subpath ? `./${subpath}` : ".";
  const exp = j.exports;
  if (exp) {
    if (typeof exp === "string" || Array.isArray(exp)) { if (!subpath) leaves(exp).forEach(add); }
    else if (typeof exp === "object") {
      const isConditions = !Object.keys(exp).some((k) => k.startsWith("."));
      if (isConditions) { if (!subpath) leaves(exp).forEach(add); }
      else {
        if (exp[key] !== undefined) leaves(exp[key]).forEach(add);
        // wildcard patterns "./*" or "./components/*"
        for (const k of Object.keys(exp).sort()) {
          if (!k.includes("*")) continue;
          const [pre, post] = k.split("*");
          if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
            const star = key.slice(pre.length, key.length - post.length);
            leaves(exp[k]).forEach((t) => add(t.split("*").join(star)));
          }
        }
      }
    }
  }
  if (!subpath) { add(j.source); add(j.types); add(j.typings); add(j.module); add(j.main); }
  // Map built outputs back to sources: ./dist/x.js -> ./src/x.ts
  const mapped = [];
  for (const c of out) {
    mapped.push(c);
    const noExt = c.replace(/\.d\.[cm]?ts$/, "").replace(/\.[cm]?jsx?$/, "").replace(/\.[cm]?tsx?$/, "");
    // Built output (dist/, build/, dist/esm/, ...) maps back to a source root:
    // src/, lib/ or the package root, whichever holds analyzed files.
    const built = /^(\.\/)?(dist|build|lib|out|esm|cjs)\/((esm|cjs|es|mjs|types|module|commonjs)\/)?/;
    if (built.test(noExt)) for (const root of ["./src/", "./lib/", "./"]) mapped.push(noExt.replace(built, root));
    mapped.push(noExt);
  }
  if (subpath) mapped.push(`./src/${subpath}`, `./lib/${subpath}`, `./${subpath}`);
  else mapped.push("./src/index", "./lib/index", "./index", "./src/main", "./main");
  return [...new Set(mapped)];
}

function probe(absBase, fileSet) {
  if (fileSet.has(absBase)) return absBase;
  const stripped = absBase.replace(/\.[cm]?[jt]sx?$/, "");
  for (const e of RESOLVE_EXT) if (fileSet.has(stripped + e)) return stripped + e;
  for (const e of RESOLVE_EXT) if (fileSet.has(path.join(absBase, "index" + e))) return path.join(absBase, "index" + e);
  return null;
}

/**
 * Incremental and in-memory inputs (all optional, none changes the result):
 * - `oldProgram` + `sourceFileCache`: SourceFiles whose text did not change
 *   are handed back as the same objects, so TypeScript reuses their parse and
 *   bind. Module names are always re-resolved, so added or deleted files count.
 * - `overlay`: Map(abs -> text) that replaces a file's content without touching
 *   disk (used to verify a proposed fix).
 */
export function buildProgram(disc, { federatedAliases = new Map(), oldProgram, sourceFileCache, overlay } = {}) {
  const fileSet = new Set(disc.files.map((f) => f.abs));
  const fileInfo = new Map(disc.files.map((f) => [f.abs, f]));
  const pkgById = new Map(disc.packages.map((p) => [p.id, p]));
  const rootAbsByLabel = new Map(disc.roots.map((r) => [r.label, r.abs]));
  // Workspace package names. If two packages share a name (e.g. separate repos),
  // the first by id wins and the collision is reported.
  const workspaceByName = new Map();
  const nameCollisions = [];
  for (const p of disc.packages) {
    if (!p.name) continue;
    if (workspaceByName.has(p.name)) nameCollisions.push({ name: p.name, packages: [workspaceByName.get(p.name).id, p.id] });
    else workspaceByName.set(p.name, p);
  }
  const namesByLength = [...workspaceByName.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));

  const pkgOptions = new Map();
  let tsconfigErrors = 0;
  for (const p of disc.packages) {
    const r = readTsconfig(p, workspaceByName, rootAbsByLabel.get(p.root));
    tsconfigErrors += r.errors;
    pkgOptions.set(p.id, {
      configFile: r.configFile,
      options: {
        ...r.options,
        allowJs: true, noEmit: true, noLib: true, types: [], skipLibCheck: true,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext,
        resolveJsonModule: false, allowImportingTsExtensions: true,
      },
    });
  }

  const resolutions = new Map(); // containingFile -> Map(specifier -> resolution)
  const resolveCache = new Map();
  const readText = (f) => (overlay && overlay.has(f) ? overlay.get(f) : ts.sys.readFile(f));
  const moduleHost = { fileExists: (f) => fileSet.has(f), readFile: readText, directoryExists: ts.sys.directoryExists, realpath: (f) => f, getCurrentDirectory: () => "/" };

  function resolveSpecifier(spec, containingFile) {
    const info = fileInfo.get(containingFile);
    const pkgId = info ? info.pkgId : null;
    const ck = `${pkgId}\0${path.dirname(containingFile)}\0${spec}`;
    if (resolveCache.has(ck)) return resolveCache.get(ck);
    let res;
    const isRelative = spec.startsWith(".") || spec.startsWith("/");
    // 0) Module Federation remote declared by the importing package: resolved at
    //    runtime by the federation container, never by the local workspace.
    const fed = !isRelative && federatedAliases.get(pkgId);
    if (fed && fed.has(spec.split("/")[0])) res = { kind: "federated", alias: spec.split("/")[0], module: spec };
    // 1) workspace package by name
    const wsName = !res && !isRelative && namesByLength.find((n) => spec === n || spec.startsWith(n + "/"));
    if (wsName) {
      const target = workspaceByName.get(wsName);
      const sub = spec === wsName ? "" : spec.slice(wsName.length + 1);
      let hit = null;
      for (const c of workspaceCandidates(target, sub)) {
        hit = probe(path.resolve(target.absDir, c), fileSet);
        if (hit) break;
      }
      res = hit ? { kind: "workspace", file: hit, viaName: wsName } : { kind: "unresolved-workspace", viaName: wsName };
    }
    // 2) relative or tsconfig paths/baseUrl, scoped to the containing package's options
    if (!res) {
      const opts = (pkgOptions.get(pkgId) || { options: {} }).options;
      const r = ts.resolveModuleName(spec, containingFile, opts, moduleHost);
      const f = r.resolvedModule && r.resolvedModule.resolvedFileName;
      if (f && fileSet.has(f)) res = { kind: "workspace", file: f };
      else if (isRelative) {
        const p = probe(path.resolve(path.dirname(containingFile), spec), fileSet);
        res = p ? { kind: "workspace", file: p } : { kind: "unresolved-relative" };
      } else if (f) res = { kind: "outside-scope" };
      else res = { kind: "external", module: spec };
    }
    resolveCache.set(ck, res);
    if (!resolutions.has(containingFile)) resolutions.set(containingFile, new Map());
    resolutions.get(containingFile).set(spec, res);
    return res;
  }

  const options = pkgOptions.size ? { ...pkgOptions.values().next().value.options, paths: undefined, baseUrl: undefined } : {};
  const host = ts.createCompilerHost(options, true);
  host.writeFile = () => { throw new Error("read-only: program host refused a write"); };
  // TypeScript can ask for the same file twice while reusing an old program: count files, not calls.
  const reusedFiles = new Set(); const parsedFiles = new Set();
  host.readFile = readText;
  host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
    const text = readText(fileName);
    if (text === undefined) { if (onError) onError(`cannot read ${fileName}`); return undefined; }
    // Reuse is decided by content, not by mtime. Overlaid files are never cached.
    const cacheable = sourceFileCache && !(overlay && overlay.has(fileName));
    const hit = cacheable && sourceFileCache.get(fileName);
    if (hit && hit.text === text) { reusedFiles.add(fileName); return hit.sf; }
    const sf = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    parsedFiles.add(fileName);
    if (cacheable) sourceFileCache.set(fileName, { text, sf });
    return sf;
  };
  // Resolution is ours and cheap; always redo it so new and deleted files count.
  host.hasInvalidatedResolutions = () => true;
  host.resolveModuleNameLiterals = (literals, containingFile) => literals.map((lit) => {
    const r = resolveSpecifier(lit.text, containingFile);
    if (r.kind === "workspace") {
      const ext = path.extname(r.file);
      const extension = { ".ts": ts.Extension.Ts, ".tsx": ts.Extension.Tsx, ".mts": ts.Extension.Mts, ".cts": ts.Extension.Cts, ".js": ts.Extension.Js, ".jsx": ts.Extension.Jsx, ".mjs": ts.Extension.Mjs, ".cjs": ts.Extension.Cjs }[ext] || ts.Extension.Ts;
      return { resolvedModule: { resolvedFileName: r.file, extension, isExternalLibraryImport: false } };
    }
    return { resolvedModule: undefined };
  });
  host.resolveTypeReferenceDirectiveReferences = (refs) => refs.map(() => ({ resolvedTypeReferenceDirective: undefined }));

  const program = ts.createProgram({ rootNames: disc.files.map((f) => f.abs), options, host, oldProgram });
  if (sourceFileCache) for (const k of [...sourceFileCache.keys()]) if (!fileSet.has(k)) sourceFileCache.delete(k);
  const checker = program.getTypeChecker();
  return { program, checker, resolveSpecifier, resolutions, workspaceByName, nameCollisions, pkgById, fileInfo, pkgOptions, tsconfigErrors, readText, sourceFileStats: { reused: [...reusedFiles].filter((f) => !parsedFiles.has(f)).length, parsed: parsedFiles.size } };
}

export { workspaceCandidates, probe };
