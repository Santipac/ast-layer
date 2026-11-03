// Local telemetry: what the hooks did, read from $CLAUDE_PLUGIN_DATA/hook-log.jsonl.
// Nothing leaves the machine. Read-only.
import fs from "node:fs";
import path from "node:path";
import { fingerprintStandalone } from "./fingerprint.js";

const UNIT_TYPES = ["structural", "similar", "same-name"];

/** "7d", "24h", "30m" or an ISO date → epoch ms (null when absent). */
export function sinceMs(since, now = Date.now()) {
  if (!since) return null;
  const m = /^(\d+)\s*([dhm])$/.exec(String(since).trim());
  if (m) return now - Number(m[1]) * { d: 86400000, h: 3600000, m: 60000 }[m[2]];
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`--since takes 7d, 24h, 30m or a date (got ${since})`);
  return t;
}

export function readHookLog(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * A warned unit was "followed" when it is gone from the file at the next
 * post-edit of that file (or, without one, from the file on disk now), and
 * "kept" when a unit with the same name or the same code is still there. A
 * file that no longer exists is "file deleted", not "followed": scratch files
 * and throwaway tests get deleted whether or not the warning was read.
 * Warnings about files outside the project (logged by versions before 1.3)
 * are counted apart and left out of the outcomes.
 */
export function computeStats(entries, { since = null } = {}) {
  const from = sinceMs(since);
  const inRange = entries.filter((e) => !from || Date.parse(e.at) >= from);
  const sessions = inRange.filter((e) => e.hook === "session-start");
  const runs = inRange.filter((e) => e.hook === "post-edit");
  const skipped = {};
  for (const e of runs) if (e.skipped) skipped[e.skipped] = (skipped[e.skipped] || 0) + 1;
  const outside = (e) => typeof e.file === "string" && (e.file.startsWith("..") || path.isAbsolute(e.file));
  const outsideProject = runs.filter((e) => !e.skipped && e.emitted && outside(e)).length;
  const edits = runs.filter((e) => !e.skipped && !outside(e));
  const emitted = edits.filter((e) => e.emitted);
  const byType = Object.fromEntries([...UNIT_TYPES, "architecture-rule"].map((t) => [t, 0]));
  const outcome = { followed: 0, fileDeleted: 0, kept: 0, unknown: 0 };
  const files = new Set();
  const details = [];
  const fileKey = (e) => `${e.project || ""}\0${e.file}`;
  for (const [i, e] of edits.entries()) {
    if (!e.emitted) continue;
    files.add(fileKey(e));
    const warned = e.warned || [];
    for (const w of warned) byType[w.type] = (byType[w.type] || 0) + 1;
    const unitWarnings = warned.filter((w) => UNIT_TYPES.includes(w.type));
    if (!unitWarnings.length) continue;
    const next = edits.slice(i + 1).find((x) => fileKey(x) === fileKey(e) && x.units);
    let units = next ? next.units : null; let source = next ? "next edit" : null;
    if (!units && e.project) {
      const abs = path.resolve(e.project, e.file);
      if (!fs.existsSync(abs)) { units = []; source = "file deleted"; }
      else { try { units = fingerprintStandalone(fs.readFileSync(abs, "utf8"), path.basename(abs)).map((u) => ({ name: u.name, exact: u.exact })); source = "file now"; } catch { units = null; } }
    }
    for (const w of unitWarnings) {
      if (!units) { outcome.unknown++; details.push({ file: e.file, unit: w.unit, type: w.type, outcome: "unknown" }); continue; }
      if (source === "file deleted") { outcome.fileDeleted++; details.push({ file: e.file, unit: w.unit, type: w.type, outcome: "file deleted" }); continue; }
      const kept = units.some((u) => u.name === w.unit || (w.exact && u.exact === w.exact));
      outcome[kept ? "kept" : "followed"]++;
      details.push({ file: e.file, unit: w.unit, type: w.type, outcome: kept ? "copy kept" : "warning followed", seenIn: source });
    }
  }
  return {
    since: since || null,
    sessions: sessions.length,
    sessionsReusingScan: sessions.filter((e) => e.cached).length,
    postEditRuns: runs.length,
    postEditSkipped: skipped,
    warningsOutsideProject: outsideProject,
    warningsEmitted: emitted.length,
    filesWarned: files.size,
    warningsByType: byType,
    outcomes: outcome,
    details,
  };
}

export function statsText(s) {
  const L = [];
  L.push(`ast-layer stats${s.since ? ` (since ${s.since})` : ""}, from the local hook log (nothing is sent anywhere)`);
  L.push(`Sessions: ${s.sessions} (${s.sessionsReusingScan} reused an unchanged scan)`);
  const skippedTotal = Object.values(s.postEditSkipped).reduce((a, b) => a + b, 0);
  L.push(`Post-edit runs: ${s.postEditRuns}${skippedTotal ? ` (${skippedTotal} skipped: ${Object.entries(s.postEditSkipped).sort().map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}; warnings emitted: ${s.warningsEmitted} in ${s.filesWarned} file(s)`);
  if (s.warningsOutsideProject) L.push(`  ${s.warningsOutsideProject} older warning(s) about files outside the project (scratch files) are left out below`);
  L.push(`  by type: ${Object.entries(s.warningsByType).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  L.push(`Warned units: ${s.outcomes.followed} warning followed (the unit was removed from the file), ${s.outcomes.fileDeleted} file deleted (not counted as followed), ${s.outcomes.kept} copy kept, ${s.outcomes.unknown} unknown`);
  for (const d of s.details.slice(0, 20)) L.push(`  - ${d.file} \`${d.unit}\` (${d.type}): ${d.outcome}${d.seenIn ? `, ${d.seenIn}` : ""}`);
  return L.join("\n") + "\n";
}
