// Scan signature: a hash of everything a scan's result depends on. When it
// matches the signature stored with the last scan, that scan can be reused as
// is. Read-only: it only stats and reads files.
import crypto from "node:crypto";
import fs from "node:fs";

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");

/**
 * `settings` is whatever else shapes the result (tool version, options).
 * Source files count by size and mtime (a stat per file, no read); config files
 * (package.json, tsconfig, ast-layer.*.json) and `extraFiles` count by content.
 */
export function scanSignature(disc, settings, extraFiles = []) {
  const h = crypto.createHash("sha1");
  h.update(JSON.stringify(settings));
  h.update("\0roots");
  for (const r of disc.roots) h.update(`\n${r.label}\0${r.abs}`);
  for (const group of ["files", "styleFiles", "localeFiles"]) {
    h.update(`\0${group}`);
    for (const f of disc[group] || []) h.update(`\n${f.key}\0${f.size}\0${f.mtimeMs}`);
  }
  h.update("\0configs");
  for (const f of [...(disc.configFiles || []), ...extraFiles.map((abs) => ({ abs, key: abs }))]) {
    let content = "<missing>";
    try { content = sha(fs.readFileSync(f.abs)); } catch {}
    h.update(`\n${f.key}\0${content}`);
  }
  return h.digest("hex");
}
