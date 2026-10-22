// Recorded decisions about findings ("keep these copies separate", "false
// positive"...). A decision names a finding by its key, so it applies only while
// the code it was about is unchanged; when the key changes but the anchor still
// matches, the finding comes back with a note that the decision is outdated.
// Read-only: parses text and annotates findings. Writing a decision is done by
// the CLI/MCP through writer.js, and only when the user asks for it.
import { z } from "zod";

export const DECISIONS_FILE = "ast-layer.decisions.json";
export const DECISION_VALUES = ["keep-separate", "extract-later", "accepted-copy", "false-positive"];

const Decision = z.object({
  findingKey: z.string().min(1),
  anchor: z.string().optional(),
  kind: z.string().optional(),
  decision: z.enum(DECISION_VALUES),
  note: z.string().optional(),
  about: z.string().optional(),
  recordedAt: z.string().optional(),
});
const DecisionsFile = z.object({ version: z.literal(1), decisions: z.array(Decision) });

/** Parse a decisions file. Never throws; a malformed file yields no decisions and a problem. */
export function parseDecisions(text, where, scope) {
  if (text === undefined || text === null) return { decisions: [], problems: [] };
  let json;
  try { json = JSON.parse(text); } catch (e) { return { decisions: [], problems: [`${where} is not valid JSON (${e.message}); its decisions were not applied.`] }; }
  const r = DecisionsFile.safeParse(json);
  if (!r.success) return { decisions: [], problems: [`${where} does not match the decisions format (${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}); its decisions were not applied.`] };
  return { decisions: r.data.decisions.map((d) => ({ ...d, scope })), problems: [] };
}

/**
 * Annotate findings in place. A key match makes the finding `decided`; an
 * anchor match with a different key records `previousDecision` (outdated) and
 * leaves the finding active. User-scope decisions win over repo ones for the same key.
 */
export function applyDecisions(findings, decisions) {
  const byKey = new Map(); const byAnchor = new Map();
  for (const d of [...decisions].sort((a, b) => (a.scope === "user" ? 1 : 0) - (b.scope === "user" ? 1 : 0))) {
    byKey.set(d.findingKey, d);
    if (d.anchor) byAnchor.set(d.anchor, d);
  }
  const used = new Set();
  let applied = 0; let outdated = 0;
  for (const f of findings) {
    const d = byKey.get(f.key);
    if (d) {
      f.status = "decided";
      f.decision = { decision: d.decision, note: d.note || null, scope: d.scope };
      used.add(d); applied++;
      continue;
    }
    const old = byAnchor.get(f.anchor);
    if (old && old.findingKey !== f.key) {
      f.previousDecision = { decision: old.decision, note: old.note || null, scope: old.scope, outdated: true, reason: "the code this decision was about changed (the finding key is different)" };
      used.add(old); outdated++;
    }
  }
  const unmatched = decisions.filter((d) => !used.has(d) && !findings.some((f) => f.key === d.findingKey));
  return { applied, outdated, unmatched: unmatched.length };
}
