// Usage: node scripts/third-party-licenses.mjs <esbuild-metafile> <output>
// Writes the license text of every npm package bundled into the plugin.
import fs from "node:fs";
import path from "node:path";
const [metafile, outFile] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(metafile, "utf8"));
const roots = new Set();
for (const input of Object.keys(meta.inputs)) {
  const m = /(^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) roots.add(input.slice(0, m.index + m[0].length - 1));
}
const sections = [];
for (const dir of [...roots].sort()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : `License: ${pkg.license || "unknown"} (no license file in the package)`;
  sections.push(`${pkg.name}@${pkg.version} (${pkg.license || "unknown"})\n${"-".repeat(72)}\n${text}`);
}
fs.writeFileSync(outFile, `Third-party software bundled in ast-layer.cjs\n\n${sections.join("\n\n\n")}\n`);
console.log(`${sections.length} bundled packages -> ${outFile}`);
