// Usage: node scripts/measure-incremental.mjs <root> <file-inside-root>
// Full scan, then append a line to <file> (restored afterwards), incremental
// rebuild with oldProgram, and a full scan to compare: prints timings and
// whether both results are byte-identical.
import fs from "node:fs";
import { analyze } from "../src/analyze.js";
import { withWritesForbidden } from "../src/guard.js";
import { stableStringify } from "../src/report.js";
const [root, file] = process.argv.slice(2);
const cache = new Map();
let t = Date.now();
const a = withWritesForbidden(() => analyze([root], {}, { sourceFileCache: cache }));
const full1 = Date.now() - t;
const orig = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, orig + "\nexport const __astLayerProbe = 1;\n");
try {
  t = Date.now();
  const inc = withWritesForbidden(() => analyze([root], {}, { oldProgram: a.program, sourceFileCache: cache }));
  const incMs = Date.now() - t;
  t = Date.now();
  const full = withWritesForbidden(() => analyze([root], {}));
  const fullMs = Date.now() - t;
  console.log(JSON.stringify({ firstFullMs: full1, incrementalMs: incMs, fullAfterEditMs: fullMs, reused: inc.incremental.reused, parsed: inc.incremental.parsed, identicalReport: stableStringify(inc.report) === stableStringify(full.report), identicalIndex: stableStringify(inc.index, 0) === stableStringify(full.index, 0) }));
} finally { fs.writeFileSync(file, orig); }
