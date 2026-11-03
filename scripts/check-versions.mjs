// The version must be the same in every manifest, in the analyzer and in the changelog.
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p) => JSON.parse(read(p));
const found = {
  "package.json": json("package.json").version,
  "plugin/.claude-plugin/plugin.json": json("plugin/.claude-plugin/plugin.json").version,
  ".claude-plugin/marketplace.json": json(".claude-plugin/marketplace.json").plugins.find((p) => p.name === "ast-layer").version,
  "src/analyze.js (TOOL)": /version: "([^"]+)"/.exec(read("src/analyze.js"))[1],
  "CHANGELOG.md (latest)": /^## (\S+)/m.exec(read("CHANGELOG.md"))[1],
};
const versions = new Set(Object.values(found));
if (versions.size !== 1) {
  for (const [where, v] of Object.entries(found)) console.error(`${where}: ${v}`);
  console.error("versions differ");
  process.exit(1);
}
console.log(`version ${[...versions][0]} everywhere`);
