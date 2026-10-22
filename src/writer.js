// The only write path in the tool. Analysis code never imports this module.
// Files are written to a staging directory and swapped in with rename, so a
// reader never sees a half-written report.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** An output directory this tool may replace: absent, empty, or holding a previous report. */
function replaceable(abs) {
  if (!fs.existsSync(abs)) return true;
  if (!fs.statSync(abs).isDirectory()) return false;
  const names = fs.readdirSync(abs);
  return !names.length || names.includes("report.json") || names.includes("meta.json");
}

export function writeReport(outDir, files) {
  const abs = path.resolve(outDir);
  // The whole directory is swapped, so a mistaken --out must never be an unrelated folder.
  if (!replaceable(abs)) throw new Error(`refusing to replace ${abs}: it exists and is not an ast-layer output directory`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const staging = `${abs}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // Keep the directory out of git and out of future scans.
  fs.writeFileSync(path.join(staging, ".gitignore"), "*\n");
  for (const name of Object.keys(files).sort()) fs.writeFileSync(path.join(staging, name), files[name]);
  const old = `${abs}.old-${process.pid}`;
  if (fs.existsSync(abs)) fs.renameSync(abs, old);
  fs.renameSync(staging, abs);
  fs.rmSync(old, { recursive: true, force: true });
  return abs;
}

/** Write one file atomically (temporary file + rename). */
export function writeFileAtomic(absFile, content) {
  const abs = path.resolve(absFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
  return abs;
}

/**
 * Record that `fileKey` changed after the last scan (post-edit hook). The next
 * scan reads the list to know the index is stale; writeReport replaces the
 * directory and with it the list.
 */
export function markStale(outDir, fileKey) {
  const p = path.join(path.resolve(outDir), "stale.json");
  let files = [];
  try { files = JSON.parse(fs.readFileSync(p, "utf8")).files || []; } catch {}
  if (files.includes(fileKey)) return;
  writeFileAtomic(p, JSON.stringify({ files: [...files, fileKey].sort() }) + "\n");
}

/**
 * Extract the tree of `ref` (only `subdir` of it, when given) into a new
 * temporary directory outside the repository, for PR mode. Returns the
 * directory. The caller removes it with removeTempTree.
 */
export async function extractGitTree(repoTop, ref, subdir = "") {
  if (!ref || ref.startsWith("-")) throw new Error(`not a git ref: ${ref}`);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ast-layer-pr-"));
  const top = fs.realpathSync(repoTop);
  if (dir === top || dir.startsWith(top + path.sep)) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error("refusing to extract inside the repository"); }
  const args = ["-C", top, "archive", "--format=tar", ref, ...(subdir ? ["--", subdir] : [])];
  await new Promise((resolve, reject) => {
    const git = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    git.stderr.on("data", (d) => { err += d; });
    tar.stderr.on("data", (d) => { err += d; });
    git.stdout.pipe(tar.stdin);
    let pending = 2; let failed = false;
    const done = (who) => (code) => {
      if (code !== 0 && !failed) { failed = true; reject(new Error(`${who} failed (${code}): ${err.trim().slice(0, 300)}`)); }
      if (--pending === 0 && !failed) resolve();
    };
    git.on("error", reject); tar.on("error", reject);
    git.on("close", done("git archive")); tar.on("close", done("tar"));
  }).catch((e) => { fs.rmSync(dir, { recursive: true, force: true }); throw e; });
  return dir;
}

/** Remove a directory created by extractGitTree (and nothing else). */
export function removeTempTree(dir) {
  const real = fs.realpathSync(dir);
  if (!path.basename(real).startsWith("ast-layer-pr-") || path.dirname(real) !== fs.realpathSync(os.tmpdir())) throw new Error(`not a PR-mode temporary directory: ${dir}`);
  fs.rmSync(real, { recursive: true, force: true });
}
