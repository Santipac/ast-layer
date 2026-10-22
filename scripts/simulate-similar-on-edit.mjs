// Usage: node scripts/simulate-similar-on-edit.mjs <scan-out-dir> <root>
// Simulate the post-edit "similar" check: every file is checked against the
// index as if it had just been written, excluding itself and its package.
import fs from "node:fs";
import path from "node:path";
import { loadOut, findEquivalents } from "../src/lookup.js";
import { similarOptions } from "../src/cli.js";
const [out, rootAbs] = process.argv.slice(2);
const { index, report, meta } = loadOut(out);
const label = meta.roots[0].label;
const files = [...new Set(index.units.filter((u) => u.minhash).map((u) => u.file))];
const opts = similarOptions(out, report);
const hits = [];
for (const key of files) {
  const abs = path.join(rootAbs, key.slice(label.length + 1));
  const pkg = index.units.find((u) => u.file === key).package;
  const res = findEquivalents(index, fs.readFileSync(abs, "utf8"), { fileName: path.basename(abs), excludeFile: key, minNodes: report.options.minNodes, similar: opts, excludePackage: pkg });
  for (const r of res) if (r.similar.length && !r.exact.length && !r.near.length) hits.push({ edited: `${key}:${r.line}`, unit: r.unit, pkg, best: r.similar.map((u) => `${u.name} @ ${u.file}:${u.line} (${u.package}) ${u.similarity}`) });
}
console.log(JSON.stringify(hits, null, 1));
console.error(`${files.length} files checked, ${hits.length} similar-on-edit hits`);
