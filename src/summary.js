// The note added to Claude's context at session start: a short digest of the scan
// plus the rule for acting on each kind of fact. An agent that only knows a
// copy exists still copies it; the rule has to travel with the fact.

const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// "header-app (repo:apps/faq)" -> "header-app@apps/faq": colliding names stay unambiguous but short.
const label = (p) => p.replace(/^(.+) \([^:()]+:([^()]+)\)$/, "$1@$2");

export const ACTION_RULES = [
  "ast-layer rules for acting on these facts:",
  "1. If what you are about to create already exists as a public export of a library the package depends on: import it instead of writing it.",
  "2. If it already exists as a copy in another app or package and no library has it: do not create another copy. Tell the user where the copies are and ask whether to extract it to a shared package or to copy it anyway; copy only if the user says so.",
  "3. Provable findings: apply the next action exactly. Agent-guided: check the listed difference before replacing. Manual-review: present the decision; do not edit.",
].join("\n");

/** One short reason why a library-copy finding is not provable. */
export function shortReason(f) {
  const ev = f.evidence || {};
  if (f.class === "provable") return "provable: import it";
  const r = [];
  if (ev.wouldCreateCycle) r.push("importing would create a package cycle");
  if ((ev.brokenRules || []).length) r.push(`the import breaks architecture rule ${ev.brokenRules.join(", ")}`);
  const ml = ev.moduleLoading || {};
  if (ml.consumerRuntime && (ml.entryNodeBuiltins || []).length) r.push("the library entry needs Node.js built-ins");
  if ((ev.freeIdentifierDifferences || []).length) {
    const names = ev.freeIdentifierDifferences.map((d) => d.name);
    r.push(`${names.length} free identifier(s) resolve to its own declarations (${short(names.join(", "), 60)})`);
  }
  if ((ev.literalDifferences || []).length) r.push(`${ev.literalDifferences.length} literal value(s) differ`);
  else if (ev.match === "near") r.push("types differ");
  if (ml.directiveHere !== undefined && ml.directiveHere !== ml.directiveLibrary) r.push("different \"use client\"/\"use server\" directive");
  if (ml.alreadyImportsEntry === false && (ml.entrySideEffects || []).length) r.push("the library entry has side-effect imports");
  if (ev.dependencyDeclared === false) r.push("dependency not declared");
  return `${f.class}: ${r.join("; ") || "check before replacing"}`;
}

/**
 * Lines are added by priority while they fit: header, provable findings,
 * architecture rules, duplicated code, the remaining sections; the tools line
 * and ACTION_RULES always close the note. Findings with a recorded decision
 * are left out.
 */
export function sessionSummary(report, { maxChars = 3800, maxProvable = 5, maxDetailed = 10, maxNames = 60, maxRules = 8 } = {}) {
  const active = report.findings.filter((f) => f.status !== "decided");
  const decided = report.findings.length - active.length;
  const count = (c) => active.filter((f) => f.class === c).length;
  const head = `[ast-layer] Scan of this workspace: ${report.summary.files} JS/TS files, ${report.summary.packages} packages. Findings: ${["provable", "agent-guided", "manual-review"].map((c) => `${count(c)} ${c}`).join(", ")}${decided ? ` (${decided} more with a recorded decision, not listed)` : ""}.`;
  const sections = [];

  const provable = active.filter((f) => f.class === "provable").slice(0, maxProvable);
  if (provable.length) sections.push(["Provable findings (mechanical; the next action is exact):", ...provable.map((f) => `- ${f.id} ${f.locations[0].file}:${f.locations[0].line} — ${short(f.nextAction, 220)}`)]);

  sections.push(architectureLines(report, active, maxRules));

  // Code that already exists in more than one place, with the class that says what to do.
  // Provable findings listed above with their exact action are not repeated here.
  const listedProvable = new Set(provable);
  const dups = active
    .filter((f) => ["duplicate.cross-package", "duplicate.reinvents-library-export", "duplicate.similar", "duplicate.module"].includes(f.kind) && !listedProvable.has(f))
    .map((f) => {
      const ev = f.evidence;
      const stale = f.previousDecision ? ` (a recorded "${f.previousDecision.decision}" decision no longer applies: the code changed)` : "";
      if (f.kind === "duplicate.reinvents-library-export") {
        return { size: ev.library.lines, names: [ev.local.name], text: `${ev.local.name} (${label(ev.local.package)}) ${ev.match === "exact" ? "=" : "≈"} ${ev.library.public[0]} [${shortReason(f)}]${stale}` };
      }
      if (f.kind === "duplicate.module") {
        const files = ev.files.map((x) => `${x.file.split("/").slice(-2).join("/")} (${label(x.package)})`);
        return { size: 400 * ev.files.length, module: true, names: [...new Set(ev.files.flatMap((x) => x.definitions))], text: `whole module copied: ${files.join(", ")} [manual-review: share or keep the module as a whole]${stale}` };
      }
      if (f.kind === "duplicate.similar") {
        const names = [...new Set(ev.members.map((m) => m.name))];
        const pk = [...new Set(ev.members.map((m) => label(m.package)))];
        return { size: ev.members[0].lines * ev.members.length, names, text: `${names.join("/")} — similar, not identical, in ${pk.join(", ")} [${f.class}: compare before reusing]${stale}` };
      }
      const names = [...new Set(ev.members.map((m) => m.name))];
      const pk = [...new Set(ev.members.map((m) => label(m.package)))];
      return { size: ev.members[0].lines * ev.members.length, names, text: `${names.join("/")} — copies in ${pk.join(", ")}; no library copy [manual-review: do not add another copy]${stale}` };
    })
    .sort((a, b) => b.size - a.size || a.text.localeCompare(b.text));
  const seen = new Set();
  const detailed = [];
  for (const d of dups) { if (seen.has(d.text)) continue; seen.add(d.text); detailed.push(d); if (detailed.length >= maxDetailed) break; }
  if (detailed.length) sections.push([`Code that already exists in more than one package (${dups.length} findings; largest ${detailed.length}):`, ...detailed.map((d) => `- ${d.text}`)]);

  sections.push(assetLines(active));

  // Names of single definitions first (largest first), then the definitions of
  // copied modules; the line is cut to the space left rather than dropped.
  const notListed = dups.filter((d) => !detailed.includes(d));
  const rest = [...new Set([...notListed.filter((d) => !d.module), ...notListed.filter((d) => d.module)].flatMap((d) => d.names))].filter((n) => n !== "default");
  const blind = report.limits.find((l) => l.startsWith("Blind spot"));
  const blindLine = blind ? short(blind, 300) : null;
  // The blind-spot line comes after the names and keeps its place.
  if (rest.length) sections.push((room) => namesLine(rest, room - (blindLine ? blindLine.length + 1 : 0), maxNames));

  if (blindLine) sections.push([blindLine]);

  const tools = "Tools: `search_names` (does something with this name or purpose exist, across every package and public export), `findings` (known duplicates by name, package or file), `find_equivalent` (copies and similar code).";
  const budget = maxChars - ACTION_RULES.length - 1;
  const out = [short(head, 400)];
  let used = out[0].length + 1 + tools.length;
  for (const sec of sections) {
    const lines = typeof sec === "function" ? [sec(budget - used - 1)].filter(Boolean) : sec;
    for (const line of lines) {
      if (used + line.length + 1 > budget) break;
      out.push(line); used += line.length + 1;
    }
  }
  out.push(tools);
  return `${out.join("\n")}\n${ACTION_RULES}`;
}

/** As many names as fit in `room` characters, in order, saying how many were left out. */
function namesLine(names, room, max) {
  const head = "Other names that already exist in more than one package: ";
  const tail = (left) => `${left ? `, and ${left} more` : ""}. \`findings\` with the name returns locations and class.`;
  let n = Math.min(names.length, max);
  const line = (k) => head + names.slice(0, k).join(", ") + tail(names.length - k);
  while (n > 0 && line(n).length > room) n--;
  return n ? line(n) : null;
}

/** One aggregated line per kind for stylesheet and locale copies (never one line per finding). */
function assetLines(active) {
  const of = (k) => active.filter((f) => f.kind === k);
  const pk = (fs) => [...new Set(fs.flatMap((f) => f.evidence.files.map((x) => label(x.package))))];
  const home = (fs) => [...new Set(fs.flatMap((f) => f.evidence.home || []).map(label))];
  const out = [];
  const tokens = of("css.duplicate-token");
  if (tokens.length) {
    const names = [...new Set(tokens.flatMap((f) => f.evidence.tokens.map((t) => t.name)))];
    out.push(`- CSS custom properties redefined with the same value: ${tokens.length} group(s), ${names.length} token(s) (e.g. ${names.slice(0, 3).join(", ")}) across ${short(pk(tokens).join(", "), 120)}${home(tokens).length ? `; already defined in ${home(tokens).join(", ")}, which the others depend on` : ""}.`);
  }
  const blocks = of("css.duplicate-rule-block");
  if (blocks.length) out.push(`- Identical CSS rule blocks: ${blocks.reduce((n, f) => n + f.evidence.blocks.length, 0)} block(s) in ${blocks.length} group(s) of files across ${short(pk(blocks).join(", "), 120)}.`);
  const msgs = of("i18n.duplicate-messages");
  if (msgs.length) out.push(`- Copied locale messages: ${msgs.length} group(s) of same-language files (${[...new Set(msgs.map((f) => f.evidence.language))].join(", ")}) across ${short(pk(msgs).join(", "), 120)}${home(msgs).length ? `; a copy lives in ${home(msgs).join(", ")}` : ""}.`);
  return out.length ? ["Styles and messages copied between packages (manual-review; reuse before copying again; `findings` kind css/i18n):", ...out] : [];
}

/** One compact line per violated rule, then the rules nothing breaks yet (so new imports can respect them). */
function architectureLines(report, active, maxRules) {
  const rules = (report.observations && report.observations.architectureRules) || [];
  if (!rules.length) return [];
  const violations = active.filter((f) => f.kind === "architecture.rule-violation");
  const byRule = new Map();
  for (const v of violations) { const id = v.evidence.rule.id; if (!byRule.has(id)) byRule.set(id, []); byRule.get(id).push(v); }
  const lines = ["Architecture rules (ast-layer.rules.json; ↛ = must not import): never write an import a rule forbids; if the task needs one, name the rule and ask the user. Existing violations are manual-review."];
  for (const r of rules.filter((x) => byRule.has(x.id)).slice(0, maxRules)) {
    const vs = byRule.get(r.id);
    const e = vs[0];
    lines.push(`- ${short(r.text, 140)}${r.message ? ` "${short(r.message, 100)}"` : ""}: ${vs.length} violation(s), e.g. ${e.locations[0].file}:${e.locations[0].line} → "${e.evidence.specifier}"`);
  }
  const clean = rules.filter((x) => !byRule.has(x.id));
  if (clean.length) lines.push(`- No violations: ${clean.slice(0, maxRules).map((r) => short(r.text, 120) + (r.message ? ` "${short(r.message, 80)}"` : "")).join("; ")}${clean.length > maxRules ? `; ${clean.length - maxRules} more` : ""}.`);
  return lines;
}
