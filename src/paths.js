// Where the project is and where its scan lives. Hooks and the MCP server must
// agree, so both use these functions. Inside Claude Code the scan goes to the
// plugin's data directory, never into the user's repository.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const usable = (v) => (v && !v.includes("${") ? v : null);

export function projectDir(fallbackCwd) {
  return path.resolve(usable(process.env.CLAUDE_PROJECT_DIR) || usable(process.env.AST_LAYER_PROJECT) || fallbackCwd || process.cwd());
}

export function outDirFor(project) {
  if (usable(process.env.AST_LAYER_OUT)) return path.resolve(project, process.env.AST_LAYER_OUT);
  const data = usable(process.env.CLAUDE_PLUGIN_DATA);
  if (data) {
    let real = project;
    try { real = fs.realpathSync(project); } catch {}
    return path.join(data, "scans", crypto.createHash("sha1").update(real).digest("hex").slice(0, 16));
  }
  return path.join(project, ".ast-layer");
}

/** User-scope decisions for one root, in the plugin data dir (null outside Claude Code). */
export function userDecisionsFile(rootAbs) {
  const data = usable(process.env.CLAUDE_PLUGIN_DATA);
  if (!data) return null;
  let real = rootAbs;
  try { real = fs.realpathSync(rootAbs); } catch {}
  return path.join(data, "decisions", crypto.createHash("sha1").update(real).digest("hex").slice(0, 16) + ".json");
}
