// Runtime guard: while the analysis runs, every filesystem write API throws.
// Read-only is enforced, not promised.
import fs from "node:fs";

const SYNC = ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "copyFileSync", "cpSync", "symlinkSync", "linkSync", "truncateSync", "chmodSync", "chownSync", "utimesSync", "openSync"];
const ASYNC = ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "rename", "copyFile", "cp", "symlink", "link", "truncate", "chmod", "chown", "utimes"];

export function withWritesForbidden(fn) {
  const saved = [];
  const deny = (name) => () => { throw new Error(`read-only analysis: fs.${name} is forbidden`); };
  for (const n of SYNC) if (fs[n]) { saved.push([fs, n, fs[n]]); fs[n] = n === "openSync" ? guardedOpen(fs[n]) : deny(n); }
  for (const n of ASYNC) {
    if (fs[n]) { saved.push([fs, n, fs[n]]); fs[n] = deny(n); }
    if (fs.promises[n]) { saved.push([fs.promises, n, fs.promises[n]]); fs.promises[n] = deny("promises." + n); }
  }
  saved.push([fs, "createWriteStream", fs.createWriteStream]);
  fs.createWriteStream = deny("createWriteStream");
  try { return fn(); } finally { for (const [obj, n, f] of saved) obj[n] = f; }
}

function guardedOpen(orig) {
  return (p, flags, ...rest) => {
    const f = flags === undefined ? "r" : flags;
    if (typeof f === "string" && f !== "r" && f !== "rs" && f !== "sr") throw new Error(`read-only analysis: fs.openSync(${p}, "${f}") is forbidden`);
    if (typeof f === "number" && (f & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))) throw new Error("read-only analysis: write flags are forbidden");
    return orig(p, flags, ...rest);
  };
}
