// Discovery: turns one or more roots (repos, monorepos, plain folders) into
// packages and source files. Project-agnostic by design: a "package" is any
// directory with a package.json; files belong to the deepest package above them.
// Read-only: only reads the filesystem and runs `git ls-files`.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const SOURCE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
// Files we see but cannot analyze; counted and reported as a limit.
const KNOWN_UNSUPPORTED = [".vue", ".svelte", ".astro", ".mdx", ".marko"];
export const EXCLUDED_DIRS = [
  "node_modules", "dist", "build", "out", ".next", ".turbo", "coverage", ".git",
  ".ast-layer", "storybook-static", ".vercel", ".output", ".nuxt", ".svelte-kit",
  ".cache", ".docusaurus", ".expo", "vendor", "public", "static", "__generated__",
];
const MAX_FILE_BYTES = 400_000;
export const TEST_RE = /(^|\/)(__tests__|__mocks__|__fixtures__|fixtures|tests?|e2e|cypress|playwright|stories)(\/)|\.(test|spec|stories|story|e2e|cy)\.[cm]?[jt]sx?$/;

const posix = (p) => p.split(path.sep).join("/");
// Inputs that are not source but change the result: package manifests, compiler
// configs, and the tool's own per-root files. Their content goes into the scan signature.
export const STYLE_EXT = [".css", ".scss"];
// ISO 639-1 codes. A bare 2-3 letter pattern would also match "src", "app" or "lib".
export const LANGS = new Set("aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(" "));
/** "es", "pt-BR", "pt_br" → normalized language tag, or null. */
export function languageTag(s) {
  const m = /^([a-z]{2})(?:[-_]([A-Za-z]{2}))?$/.exec(s);
  return m && LANGS.has(m[1]) ? (m[2] ? `${m[1]}-${m[2].toUpperCase()}` : m[1]) : null;
}
// A locale file lives under a locales/i18n/lang/translations/messages directory,
// or is named after a language ("es.json", "pt-BR.json").
const LOCALE_DIR_RE = /(^|\/)(locales?|i18n|lang|translations|messages)\//i;
export const isLocaleFile = (rel) => rel.endsWith(".json") && !CONFIG_FILE_RE.test(rel) && (LOCALE_DIR_RE.test(rel) || Boolean(languageTag(rel.split("/").pop().replace(/\.json$/, ""))));
export const CONFIG_FILE_RE = /(^|\/)(package\.json|(tsconfig|jsconfig)(\.[^/]*)?\.json|ast-layer\.(rules|decisions)\.json)$/;

function listFiles(rootAbs) {
  // Prefer git: respects .gitignore and gives a stable set.
  try {
    const out = execFileSync("git", ["-C", rootAbs, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024,
    });
    // Sparse checkouts list files that are not there; a tracked symlink may point outside the root.
    const rootReal = fs.realpathSync(rootAbs);
    const files = out.split("\0").filter(Boolean)
      .map((f) => path.join(rootAbs, f))
      .filter((f) => { try { const real = fs.realpathSync(f); return real.startsWith(rootReal + path.sep) && fs.statSync(real).isFile(); } catch { return false; } });
    return { files, source: "git ls-files" };
  } catch {
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) { if (!EXCLUDED_DIRS.includes(e.name)) walk(path.join(dir, e.name)); }
        else if (e.isFile()) files.push(path.join(dir, e.name));
      }
    };
    walk(rootAbs);
    return { files, source: "filesystem walk" };
  }
}

function readJson(abs) {
  try { return JSON.parse(fs.readFileSync(abs, "utf8")); } catch { return null; }
}

/**
 * `rootLabels` fixes the label of each root (by position) instead of deriving it
 * from the directory name, so a temporary copy of a repo (PR mode) produces the
 * same file keys as the repo itself.
 */
export function discover(rootPaths, { includeTests = false, rootLabels = null } = {}) {
  const roots = [];
  const seenLabels = new Map();
  for (const [i, r] of rootPaths.entries()) {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`root is not a directory: ${r}`);
    let label = (rootLabels && rootLabels[i]) || path.basename(abs) || "root";
    const n = (seenLabels.get(label) || 0) + 1;
    seenLabels.set(label, n);
    if (n > 1) label = `${label}~${n}`;
    roots.push({ label, abs });
  }

  const packages = [];
  const files = [];
  const skipped = { byReason: {}, byExt: {} };
  const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
  const listing = [];
  const configFiles = [];
  const styleFiles = [];
  const localeFiles = [];

  for (const root of roots) {
    const { files: all, source } = listFiles(root.abs);
    listing.push({ root: root.label, source, files: all.length });
    const inExcludedDir = (abs) => posix(path.relative(root.abs, abs)).split("/").slice(0, -1).some((seg) => EXCLUDED_DIRS.includes(seg));

    // Packages: every package.json outside excluded dirs.
    const pkgJsonPaths = all.filter((f) => path.basename(f) === "package.json" && !inExcludedDir(f)).sort();
    const rootPkgs = pkgJsonPaths.map((p) => {
      const dirAbs = path.dirname(p);
      const relDir = posix(path.relative(root.abs, dirAbs)) || ".";
      const json = readJson(p) || {};
      return {
        id: `${root.label}:${relDir}`,
        root: root.label,
        dir: relDir,
        absDir: dirAbs,
        name: typeof json.name === "string" && json.name ? json.name : null,
        json,
      };
    });
    if (!rootPkgs.some((p) => p.dir === ".")) {
      rootPkgs.push({ id: `${root.label}:.`, root: root.label, dir: ".", absDir: root.abs, name: null, json: {}, implicit: true });
    }
    // Deepest package first for ownership lookup.
    const byDepth = [...rootPkgs].sort((a, b) => b.absDir.length - a.absDir.length || a.id.localeCompare(b.id));
    const owner = (abs) => byDepth.find((p) => abs === p.absDir || abs.startsWith(p.absDir + path.sep));

    for (const abs of all) {
      const ext = path.extname(abs).toLowerCase();
      const rel = posix(path.relative(root.abs, abs));
      if (CONFIG_FILE_RE.test(rel) && !inExcludedDir(abs)) configFiles.push({ abs, key: `${root.label}/${rel}` });
      if (KNOWN_UNSUPPORTED.includes(ext)) { bump(skipped.byExt, ext); continue; }
      const asset = STYLE_EXT.includes(ext) ? styleFiles : isLocaleFile(rel) ? localeFiles : null;
      if (asset) {
        if (inExcludedDir(abs) || /\.min\.css$/.test(abs) || (!includeTests && TEST_RE.test(rel))) continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) { bump(skipped.byReason, `larger than ${MAX_FILE_BYTES} bytes`); continue; }
        asset.push({ abs, rel, root: root.label, key: `${root.label}/${rel}`, pkgId: owner(abs).id, size: st.size, mtimeMs: st.mtimeMs });
        continue;
      }
      if (!SOURCE_EXT.includes(ext)) continue;
      if (abs.endsWith(".d.ts") || abs.endsWith(".d.mts") || abs.endsWith(".d.cts")) { bump(skipped.byReason, "declaration file (.d.ts)"); continue; }
      if (inExcludedDir(abs)) { bump(skipped.byReason, "excluded directory"); continue; }
      if (/\.min\.[cm]?js$/.test(abs)) { bump(skipped.byReason, "minified"); continue; }
      let size = 0; let mtimeMs = 0;
      try { const st = fs.statSync(abs); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
      if (size > MAX_FILE_BYTES) { bump(skipped.byReason, `larger than ${MAX_FILE_BYTES} bytes`); continue; }
      const isTest = TEST_RE.test(rel);
      const pkg = owner(abs);
      files.push({ abs, rel, root: root.label, key: `${root.label}/${rel}`, pkgId: pkg.id, isTest, size, mtimeMs });
    }
    packages.push(...rootPkgs);
  }

  files.sort((a, b) => a.key.localeCompare(b.key));
  configFiles.sort((a, b) => a.key.localeCompare(b.key));
  styleFiles.sort((a, b) => a.key.localeCompare(b.key));
  localeFiles.sort((a, b) => a.key.localeCompare(b.key));
  packages.sort((a, b) => a.id.localeCompare(b.id));
  const filesByPkg = new Map();
  for (const f of files) filesByPkg.set(f.pkgId, (filesByPkg.get(f.pkgId) || 0) + 1);
  // Drop implicit root pseudo-packages that own nothing.
  const kept = packages.filter((p) => !p.implicit || filesByPkg.get(p.id));
  const nameCount = new Map();
  for (const p of kept) if (p.name) nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
  for (const p of kept) {
    p.fileCount = filesByPkg.get(p.id) || 0;
    // Colliding names get their location appended so every label is unambiguous.
    p.displayName = p.name ? (nameCount.get(p.name) > 1 ? `${p.name} (${p.id})` : p.name) : p.id;
    const j = p.json || {};
    p.declaredDeps = {
      dependencies: j.dependencies || {},
      devDependencies: j.devDependencies || {},
      peerDependencies: j.peerDependencies || {},
    };
  }
  return { roots, packages: kept, files, configFiles, styleFiles, localeFiles, skipped, listing, includeTests };
}

export function dependsOnDeclared(pkg, name) {
  const d = pkg.declaredDeps;
  return Boolean(d && (name in d.dependencies || name in d.devDependencies || name in d.peerDependencies));
}
