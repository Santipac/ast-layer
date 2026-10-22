// "Does something equivalent already exist?" — answered from the fingerprint
// index of the last scan. Used by the CLI, the MCP server and the edit hook.
import fs from "node:fs";
import path from "node:path";
import { fingerprintStandalone, jaccard, literalOverlap, lshBands, decodeU32 } from "./fingerprint.js";

export function loadOut(outDir) {
  const dir = path.resolve(outDir);
  const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
  if (!fs.existsSync(path.join(dir, "report.json"))) throw new Error(`no report in ${dir}; run a scan first`);
  return { dir, report: read("report.json"), index: read("index.json"), meta: fs.existsSync(path.join(dir, "meta.json")) ? read("meta.json") : { roots: [] } };
}

/** Map an absolute file path to the "<root>/<rel>" key used in reports. */
export function keyForFile(meta, absFile) {
  const abs = path.resolve(absFile);
  const root = (meta.roots || []).filter((r) => abs === r.abs || abs.startsWith(r.abs + path.sep)).sort((a, b) => b.abs.length - a.abs.length)[0];
  return root ? `${root.label}/${path.relative(root.abs, abs).split(path.sep).join("/")}` : null;
}

/** Shingles and literal values of the index's large units (similar.json), loaded on first use. */
export function similarLoader(outDir) {
  let cache = null;
  return () => {
    if (cache) return cache;
    cache = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(path.join(path.resolve(outDir), "similar.json"), "utf8"));
      for (const [id, v] of Object.entries(data.units || {})) cache.set(id, { shingles: decodeU32(v.shingles), literals: v.literals });
    } catch { /* older scan without similar.json: no similar matches */ }
    return cache;
  };
}

/**
 * Structural matches of `code` against the index: identical, near-identical
 * (literals or types differ), and, when `similar` is given, similar (same
 * Jaccard threshold, size floor and literal guard the scan uses for
 * duplicate.similar). Similar matches are cross-package only when
 * `excludePackage` names the package the code lives in.
 */
export function findEquivalents(index, code, { fileName = "snippet.tsx", excludeFile = null, minNodes = 0, onlyChanged = false, similar = null, excludePackage = null } = {}) {
  const fps = fingerprintStandalone(code, fileName).filter((u) => u.nodes >= minNodes);
  const prior = excludeFile ? index.units.filter((u) => u.file === excludeFile) : [];
  const others = index.units.filter((u) => u.file !== excludeFile);
  const rank = (u) => (u.public.length ? 0 : 1);
  const sort = (a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.line - b.line;
  let byBand = null;
  const results = [];
  for (const fp of fps) {
    if (onlyChanged && prior.some((u) => u.exact === fp.exact)) continue;
    const exact = others.filter((u) => u.exact === fp.exact);
    const near = others.filter((u) => u.exact !== fp.exact && u.near === fp.near);
    let sim = [];
    if (similar && fp.nodes >= similar.minNodes && fp.shingles.length >= 8) {
      if (!byBand) {
        byBand = new Map();
        for (const u of others) if (u.minhash) for (const b of lshBands(decodeU32(u.minhash))) { if (!byBand.has(b)) byBand.set(b, []); byBand.get(b).push(u); }
      }
      const candidates = new Set(lshBands(fp.minhash).flatMap((b) => byBand.get(b) || []));
      // Same-name units are always candidates, as in the scan (groups of at most 60).
      const sameName = CONVENTIONAL_NAMES.has(fp.name) ? [] : others.filter((u) => u.minhash && u.name === fp.name);
      if (sameName.length < 60) for (const u of sameName) candidates.add(u);
      const data = candidates.size ? similar.load() : null;
      for (const u of candidates) {
        if (u.near === fp.near || (excludePackage && u.package === excludePackage)) continue;
        const d = data.get(u.id);
        if (!d) continue;
        const j = jaccard(fp.shingles, d.shingles);
        const floor = u.name === fp.name && !CONVENTIONAL_NAMES.has(fp.name) ? similar.sameNameThreshold ?? similar.threshold : similar.threshold;
        if (j < floor || literalOverlap(fp, d) < 0.5) continue;
        sim.push({ ...u, similarity: Math.round(j * 100) / 100 });
      }
      sim = sim.sort((a, b) => b.similarity - a.similarity || sort(a, b)).slice(0, 10);
    }
    if (!exact.length && !near.length && !sim.length) continue;
    results.push({ unit: fp.name, line: fp.line, lines: fp.lines, exact: exact.sort(sort).slice(0, 10), near: near.sort(sort).slice(0, 10), similar: sim });
  }
  return results;
}

export function describeMatches(results, { header = "" } = {}) {
  const out = [];
  if (header) out.push(header);
  for (const r of results) {
    for (const [kind, list] of [["identical", r.exact], ["near-identical (literals or types differ)", r.near], ["similar, not identical,", r.similar || []]]) {
      for (const u of list) {
        const where = `${u.file}:${u.line} (${u.package}${u.similarity ? `; ${Math.round(u.similarity * 100)}% of the structure in common` : ""})`;
        out.push(u.public.length
          ? `\`${r.unit}\` (line ${r.line}) is ${kind} to \`${u.name}\` at ${where}, which is a public export: ${u.public.join(", ")}.`
          : `\`${r.unit}\` (line ${r.line}) is ${kind} to \`${u.name}\` at ${where}.`);
      }
    }
  }
  return out.join("\n");
}

// ---------- name-based lookup (behavior that may exist under the same or a similar name) ----------

const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./]+/g, " ").toLowerCase().split(/\s+/).filter(Boolean);
// Framework conventions: the same name in two packages says nothing about duplication.
export const CONVENTIONAL_NAMES = new Set([
  "default", "App", "Page", "Layout", "Home", "Index", "Loading", "Error", "NotFound", "Template", "Head", "Root", "Providers", "Provider",
  "getServerSideProps", "getStaticProps", "getStaticPaths", "generateMetadata", "generateStaticParams", "middleware", "loader", "action",
  "GET", "POST", "PUT", "PATCH", "DELETE", "handler", "main", "config", "setup", "init", "render", "styles", "useStyles", "Wrapper", "Container",
]);

/** Search names of every top-level unit and every public export. All query words must appear. */
export function searchNames(index, query, { limit = 25 } = {}) {
  const q = words(query);
  if (!q.length) return [];
  const hits = [];
  const seen = new Set();
  for (const e of index.publicExports || []) {
    const w = words(e.exportName).join(" ");
    if (!q.every((t) => w.includes(t))) continue;
    const key = `${e.file}:${e.line}:${e.exportName}`;
    if (seen.has(key)) continue; seen.add(key);
    hits.push({ name: e.exportName, where: `${e.file}:${e.line}`, package: e.package, import: e.typeOnly ? `import type { ${e.exportName} } from "${e.specifier}"` : `import { ${e.exportName} } from "${e.specifier}"`, public: true });
  }
  for (const n of index.names || []) {
    const w = words(n.name).join(" ");
    if (!q.every((t) => w.includes(t))) continue;
    if (n.public.length && hits.some((h) => h.where === `${n.file}:${n.line}`)) continue;
    hits.push({ name: n.name, where: `${n.file}:${n.line}`, package: n.package, public: false });
  }
  const exactFirst = (h) => (words(h.name).join(" ") === q.join(" ") ? 0 : 1);
  return hits.sort((a, b) => (a.public ? 0 : 1) - (b.public ? 0 : 1) || exactFirst(a) - exactFirst(b) || a.where.localeCompare(b.where)).slice(0, limit);
}

/** Units in a file whose name already exists in another package (or as a public export). Heuristic, never proof. */
export function nameMatches(index, unitNames, { excludeFile = null, excludePackage = null, ignorePrior = false } = {}) {
  const prior = new Set(ignorePrior ? [] : (index.names || []).filter((n) => n.file === excludeFile).map((n) => n.name));
  const out = [];
  for (const name of [...new Set(unitNames)].sort()) {
    if (CONVENTIONAL_NAMES.has(name) || prior.has(name)) continue;
    // Only definitions other code can import: a file-internal helper with the same name is noise.
    const same = (index.names || []).filter((n) => n.name === name && n.file !== excludeFile && n.exported !== false && (n.package !== excludePackage || n.public.length));
    const pub = (index.publicExports || []).filter((e) => e.exportName === name && !same.some((n) => `${n.file}:${n.line}` === `${e.file}:${e.line}`));
    if (same.length || pub.length) out.push({ name, existing: [...same.map((n) => ({ where: `${n.file}:${n.line}`, package: n.package, public: n.public })), ...pub.map((e) => ({ where: `${e.file}:${e.line}`, package: e.package, public: [`${e.specifier}#${e.exportName}`] }))].slice(0, 6) });
  }
  return out;
}
