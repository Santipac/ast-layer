// Rendering. Pure functions: data in, strings out.

export function stableStringify(v, indent = 2) {
  const norm = (x) => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])]));
    return x;
  };
  return JSON.stringify(norm(v), null, indent) + "\n";
}

const CLASS_TITLE = {
  provable: "Provable — mechanically certain, no judgment needed",
  "agent-guided": "Agent-guided — the site is certain, the replacement needs a check",
  "manual-review": "Manual review — depends on intent; a person decides",
};

export function toMarkdown(report, { maxPerClass = 40 } = {}) {
  const r = report;
  const L = [];
  L.push(`# ast-layer report`, "");
  L.push(`Roots: ${r.roots.map((x) => `\`${x.label}\``).join(", ")} · ${r.summary.files} files · ${r.summary.packages} packages · ${r.summary.findings} findings`, "");
  L.push("Every finding below is an observation with an exact location. Its class says whether acting on it is mechanical, needs a focused check, or needs a human decision.", "");
  L.push("## Limits (printed on every run)", "");
  for (const l of r.limits) L.push(`- ${l}`);
  L.push("");
  L.push("## Summary", "", "| Class | Findings |", "|---|---|");
  for (const c of ["provable", "agent-guided", "manual-review"]) L.push(`| ${c} | ${r.summary.byClass[c] || 0} |`);
  L.push("", "| Kind | Findings |", "|---|---|");
  for (const [k, v] of Object.entries(r.summary.byKind)) L.push(`| \`${k}\` | ${v} |`);
  L.push("");
  for (const c of ["provable", "agent-guided", "manual-review"]) {
    const fs = r.findings.filter((f) => f.class === c);
    if (!fs.length) continue;
    L.push(`## ${CLASS_TITLE[c]}`, "");
    for (const f of fs.slice(0, maxPerClass)) {
      L.push(`### \`${f.kind}\` · ${f.id}`, "", `- **Key:** \`${f.key}\``);
      L.push(`- **Where:** ${f.locations.slice(0, 8).map((l) => `\`${l.file}:${l.line}:${l.col}\``).join(", ")}${f.locations.length > 8 ? ` (+${f.locations.length - 8} more)` : ""}`);
      L.push(`- **Why:** ${f.why}`);
      if (f.evidence && f.evidence.candidateHomesNote) L.push(`- **Candidate home:** ${f.evidence.candidateHomesNote}`);
      if (f.evidence && f.evidence.literalDifferences && f.evidence.literalDifferences.length) L.push(`- **Differing literals:** ${f.evidence.literalDifferences.slice(0, 5).map((d) => d.values.map((v) => JSON.stringify(v)).join(" vs ")).join("; ")}`);
      L.push(`- **Next action:** ${f.nextAction}`);
      for (const s of f.stopConditions || []) L.push(`- **Stop if:** ${s.replace(/^Stop if /, "")}`);
      L.push("");
    }
    if (fs.length > maxPerClass) L.push(`_${fs.length - maxPerClass} more ${c} findings in report.json._`, "");
  }
  const o = r.observations;
  L.push("## Observations (ledger, no action implied)", "");
  L.push("### Packages", "", "| Package | Files | Role | Consumers |", "|---|---|---|---|");
  for (const p of o.packages) L.push(`| \`${p.name || p.id}\` | ${p.files} | ${p.role.split(" (")[0]} | ${p.consumers.length ? p.consumers.map((c) => `\`${c}\``).join(", ") : "—"} |`);
  L.push("");
  if (o.packageEdges.length) {
    L.push("### Package graph", "", "| From | To | Import statements | Type-only | Bound references |", "|---|---|---|---|---|");
    for (const e of o.packageEdges) L.push(`| \`${e.from}\` | \`${e.to}\` | ${e.importStatements} | ${e.typeOnlyStatements} | ${e.boundReferences} |`);
    L.push("");
  }
  if (o.federation.containers.length) {
    L.push("### Module Federation", "");
    for (const c of o.federation.containers) L.push(`- \`${c.name}\` (${c.package}, ${c.config}) exposes ${c.exposes.map((e) => `\`${e.key}\``).join(", ") || "nothing"}; remotes ${Object.keys(c.remotes).map((k) => `\`${k}\``).join(", ") || "none"}; shared ${c.shared.map((s) => `\`${s}\``).join(", ") || "none"}`);
    L.push(`- Federated imports matched to an expose: ${o.federation.matchedImports.length}. Remotes outside the analyzed group: ${o.federation.remotesOutsideGroup.length}.`, "");
  }
  if (o.unconsumedPublicExports.length) {
    L.push("### Public exports with no consumer in the analyzed group", "");
    for (const u of o.unconsumedPublicExports) L.push(`- \`${u.package}\`: ${u.count != null ? `${u.count} export(s)` : u.note}${u.count != null ? ` — e.g. ${u.exports.slice(0, 6).map((e) => `\`${e.export.split(", ")[0]}\``).join(", ")}` : ""}`);
    L.push("");
  }
  const d = o.duplication;
  L.push("### Duplication scan", "", `${d.unitsFingerprinted} of ${d.unitsTotal} top-level units were large enough to fingerprint; ${d.exactClusters} exact and ${d.nearClusters} near clusters; ${d.nearGroupsRejectedByLiteralThreshold} near groups rejected because their literals differ too much (e.g. icon sets).`, "");
  return L.join("\n");
}
