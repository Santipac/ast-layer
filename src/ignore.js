// Paths the scan and the post-edit hook leave out. Some files copy code on
// purpose: a parity test keeps the old implementation to compare it with the
// library, a fixture or a generated file duplicates by design. Warning about
// them is noise, so a path pattern can be recorded once ("ignore") in the
// decisions file instead of answering the same warning on every edit.
// Read-only: reads the decisions files and matches paths.
import fs from "node:fs";
import path from "node:path";
import { compileGlob } from "./rules.js";
import { DECISIONS_FILE, parseDecisions } from "./decisions.js";
import { userDecisionsFile } from "./paths.js";

/** Always ignored: tests that compare a copy with the shared implementation. */
export const BUILTIN_IGNORE = ["*.parity.test.*", "*.parity.spec.*"];

/**
 * A pattern with no "/" matches the file name in any directory
 * (`*.parity.test.*`); one with a "/" matches the path from the root
 * (`packages/*\/legacy/**`). `**` crosses directories, `*` does not.
 */
export function globMatchesPath(glob, rel) {
  const g = glob.replace(/^\.\//, "");
  if (!g.includes("/")) return compileGlob(g).test(rel.slice(rel.lastIndexOf("/") + 1));
  return compileGlob(g).test(rel);
}

function readText(abs) {
  try { return fs.readFileSync(abs, "utf8"); } catch { return null; }
}

/** Ignore patterns for one root: built-in, the repo's decisions file, the user's. */
export function ignoreFor(rootAbs) {
  const out = BUILTIN_IGNORE.map((glob) => ({ glob, scope: "built-in" }));
  const repo = parseDecisions(readText(path.join(rootAbs, DECISIONS_FILE)), DECISIONS_FILE, "repo");
  out.push(...repo.ignore);
  const userFile = userDecisionsFile(rootAbs);
  if (userFile) out.push(...parseDecisions(readText(userFile), "user decisions", "user").ignore);
  return out;
}

/** The first pattern that matches `rel` (posix, relative to the root), or null. */
export function ignoredBy(patterns, rel) {
  return patterns.find((p) => globMatchesPath(p.glob, rel)) || null;
}
