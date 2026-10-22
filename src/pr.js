// PR mode: the findings a change introduces. Head is the working tree; base is
// the tree of a git ref extracted to a temporary directory outside the
// repository (or a saved report.json). Both are analyzed with the same options
// and the same root label, so finding keys are comparable. Nothing is written
// except that temporary copy, which is removed afterwards.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { analyze, TOOL } from "./analyze.js";
import { withWritesForbidden } from "./guard.js";
import { extractGitTree, removeTempTree } from "./writer.js";
import { userDecisionsFile } from "./paths.js";

const CLASSES = ["provable", "agent-guided", "manual-review"];
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).trim();

/**
 * New findings of `root` relative to `base` (a git ref) or `baseline` (a
 * report.json path): those whose key is not in the base, plus those that touch
 * a file changed in `base...HEAD`. Recorded decisions and architecture rules
 * apply, as in any scan of head.
 */
export async function prFindings(rootArg, { base = null, baseline = null, failOn = [], includeTests = false } = {}) {
  if (!base && !baseline) throw new Error("pass --base <git-ref> or --baseline <report.json>");
  const root = path.resolve(rootArg);
  const label = path.basename(root);
  const opts = { includeTests };
  const userDecisionFiles = [{ root: label, abs: userDecisionsFile(root) }].filter((u) => u.abs);
  const t0 = Date.now();
  const head = withWritesForbidden(() => analyze([root], opts, { userDecisionFiles })).report;
  let baseKeys; let changed = null; let baseLabel;
  if (baseline) {
    const b = JSON.parse(fs.readFileSync(path.resolve(baseline), "utf8"));
    if (!b.tool || !(b.tool.schema >= 2) || !b.findings.every((f) => f.key)) throw new Error("the baseline report has no finding keys (it was made before ast-layer 1.0); regenerate it with this version");
    baseKeys = new Set(b.findings.map((f) => f.key));
    baseLabel = `baseline ${path.basename(baseline)}`;
  } else {
    // The ref reaches git as an argument: one that starts with "-" would be read as an option.
    if (typeof base !== "string" || !base || base.startsWith("-")) throw new Error(`not a git ref: ${base}`);
    const sha = git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`not a commit: ${base}`);
    const top = fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
    const sub = path.relative(top, fs.realpathSync(root)).split(path.sep).join("/");
    const tmp = await extractGitTree(top, sha, sub);
    try {
      const baseRoot = sub ? path.join(tmp, sub) : tmp;
      baseKeys = fs.existsSync(baseRoot)
        ? new Set(withWritesForbidden(() => analyze([baseRoot], opts, { rootLabels: [label], userDecisionFiles: [] })).report.findings.map((f) => f.key))
        : new Set();
    } finally { removeTempTree(tmp); }
    changed = new Set(git(root, ["diff", "--name-only", `${sha}...HEAD`]).split("\n").filter(Boolean)
      .map((n) => path.relative(fs.realpathSync(root), path.join(top, n))).filter((r) => r && !r.startsWith(".."))
      .map((r) => `${label}/${r.split(path.sep).join("/")}`));
    baseLabel = base;
  }
  const findings = [];
  for (const f of head.findings) {
    if (f.status === "decided") continue;
    const isNew = !baseKeys.has(f.key);
    const touches = changed ? f.locations.filter((l) => changed.has(l.file)).map((l) => l.file) : [];
    if (!isNew && !touches.length) continue;
    findings.push({ ...f, prReason: isNew ? "new" : "touches a changed file" });
  }
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, findings.filter((f) => f.class === c).length]));
  const failing = failOn.filter((c) => byClass[c]);
  const prLimits = [
    `PR mode: head is the working tree (untracked, non-ignored files included); base is ${baseline ? "a saved report" : "the tree of the ref extracted with git archive (files marked export-ignore are missing from it)"}. A finding is reported when its key is not in the base${changed ? ", or when it touches a file changed in base...HEAD (uncommitted changes count only through new keys)" : ""}. Findings with a recorded decision are left out.`,
  ];
  return { tool: TOOL, base: baseLabel, changedFiles: changed ? changed.size : null, headFindings: head.findings.length, newFindings: findings.length, byClass, failOn, failed: failing.length > 0, findings, limits: [...prLimits, ...head.limits], seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

const CLASS_TITLE = { provable: "Provable: mechanical, apply the next action", "agent-guided": "Agent-guided: the site is certain, the replacement needs a check", "manual-review": "Manual review: a person decides" };

/** Markdown ready for a PR comment. */
export function prMarkdown(r, { max = 50 } = {}) {
  const L = [];
  L.push(`## ast-layer: ${r.newFindings ? `${r.newFindings} finding(s) in this change` : "no new findings in this change"}`, "");
  L.push(`Compared with \`${r.base}\`${r.changedFiles != null ? ` · ${r.changedFiles} changed file(s)` : ""} · ${CLASSES.map((c) => `${r.byClass[c]} ${c}`).join(" · ")}${r.failOn.length ? ` · fails on: ${r.failOn.join(", ")}${r.failed ? " (**failed**)" : ""}` : ""}`, "");
  let shown = 0;
  for (const c of CLASSES) {
    const fs_ = r.findings.filter((f) => f.class === c);
    if (!fs_.length) continue;
    L.push(`### ${CLASS_TITLE[c]} (${fs_.length})`, "");
    for (const f of fs_) {
      if (shown >= max) break;
      shown++;
      const where = f.locations.slice(0, 4).map((l) => `\`${l.file}:${l.line}\``).join(", ") + (f.locations.length > 4 ? ` (+${f.locations.length - 4})` : "");
      L.push(`- **\`${f.kind}\`** ${where}${f.prReason === "new" ? "" : " _(existing finding in a changed file)_"}`);
      L.push(`  - Why: ${f.why}`);
      L.push(`  - Next: ${f.nextAction}`);
      if (f.previousDecision) L.push(`  - Note: a recorded "${f.previousDecision.decision}" decision no longer applies; the code changed.`);
    }
    L.push("");
  }
  if (r.newFindings > shown) L.push(`_${r.newFindings - shown} more finding(s) not shown (--max ${max})._`, "");
  L.push("<details><summary>Limits of this analysis</summary>", "", ...r.limits.map((l) => `- ${l}`), "", "</details>", "");
  return L.join("\n");
}
