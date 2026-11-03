# ast-layer

A deterministic AST layer for coding agents, packaged as a Claude Code plugin.

It analyzes one or more JS/TS repositories (monorepos, micro-frontends, shared libraries) and gives Claude **facts with exact locations**: code duplicated across packages, copies of library exports, imports that bypass a package's public entry, cycles, Module Federation contracts, and your own architecture rules. Each finding has a class (`provable`, `agent-guided` or `manual-review`) that tells the agent what it may do with it. The class is decided before the model sees the code.

What it detects and how to use it is in [`plugin/README.md`](plugin/README.md). Changes by version are in [`CHANGELOG.md`](CHANGELOG.md).

## Installation

In Claude Code (2.1.275 or later):

```
/plugin install ast-layer --marketplace Santipac/ast-layer
```

Or in two steps, which also works on earlier versions:

```
/plugin marketplace add Santipac/ast-layer
/plugin install ast-layer@ast-layer
```

The repository is its own marketplace (`.claude-plugin/marketplace.json`) and the built bundle (`plugin/dist/`) is committed, so nothing is built on install. Updates arrive with `/plugin marketplace update ast-layer`.

**From source:**

```bash
npm ci
npm run build                          # rebuilds plugin/dist/
claude --plugin-dir ./plugin
```

Requirements: Claude Code and Node.js 18 or later. Node does not have to be on the `PATH` Claude Code sees: the plugin finds it through nvm, fnm, volta, asdf, mise, Homebrew or your shell, or through `AST_LAYER_NODE` (see [Node.js](plugin/README.md#nodejs)). macOS and Linux; on Windows, use WSL. git is optional: without git, discovery walks the file tree; PR mode needs git.

## What it does on your machine

- **It reads; it does not write.** The analysis runs with disk writes blocked (`src/guard.js`), and a static test checks that the analysis modules have no write path. The only module that writes is `src/writer.js`.
- **Where it writes:**
  - the index, the report and `hook-log.jsonl` go to the plugin's data directory (`$CLAUDE_PLUGIN_DATA`), outside the repository;
  - inside the repository it only writes `ast-layer.decisions.json`, and only when you ask it to remember a decision or to ignore a path pattern;
  - PR mode extracts the base ref to a temporary directory outside the repository and removes it afterwards.
- **It never edits your code.** Codemods (`propose_fix`) return a verified diff, and the agent applies it with Edit.
- **No network.** It does not run the analyzed project's code or load its `node_modules`. It only runs `git` (`ls-files`, `rev-parse`, `archive`, `diff`) and, in PR mode, `tar`. To find Node.js, the launcher (`plugin/bin/ast-layer`) checks the usual install locations and, only when Node is in none of them, asks your shell once (`$SHELL -lc` / `-ic 'command -v node'`, which loads your profile and rc files); the path it finds is cached in the plugin's data directory.
- **Hooks:**
  - `SessionStart` scans the project at the start of each session, or reuses the previous scan when nothing changed;
  - `PostToolUse` compares every file Claude writes with the index, except files outside the project, tests the scan leaves out, parity tests and ignored paths;
  - both stay silent if anything fails, and never block the session;
  - `AST_LAYER_SESSION_SCAN=off` turns the session scan off.
- **Telemetry (`stats`) is local:** it reads `hook-log.jsonl` and sends nothing.

See [`SECURITY.md`](SECURITY.md) for the threat model and how to report a vulnerability.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace that lists the plugin.
- `plugin/`: the plugin (manifest, MCP server, hooks, skills and agent).
  - `bin/ast-layer`: the launcher the MCP server and the hooks start through; it finds Node.js.
  - `dist/`: the bundle, committed; CI checks that it matches the sources.
- `src/`: the analyzer.
  - `discover.js`: finds packages and files in one or more roots.
  - `program.js`: builds a single TypeScript program with per-package resolution.
  - `fingerprint.js`: binding-aware normalized fingerprints and the similarity sketch.
  - `analyze.js`: extracts the facts and classifies the findings.
  - `cache.js`: the scan signature that lets SessionStart reuse a scan.
  - `rules.js`: architecture rules (`ast-layer.rules.json`).
  - `decisions.js`: recorded decisions (`ast-layer.decisions.json`).
  - `assets.js`: CSS/SCSS tokens and blocks, and locale messages.
  - `fix.js`: codemods verified in memory.
  - `pr.js`: PR mode.
  - `stats.js`: local hook telemetry.
  - `guard.js` and `writer.js`: read-only mode and the only write path.
  - `summary.js`: the session-start note.
  - `lookup.js`: lookups against the index (equivalents, names).
  - `ignore.js`: path patterns left out of scans and edit warnings.
  - `mcp.js` and `cli.js`: the MCP server and the command line.
- `test/`: a fixture (`test/fixtures/acme`) with one case per rule, plus tests for determinism, read-only behavior, incremental analysis, hooks, PR mode, codemods, security and the MCP server over stdio.
- `scripts/`: incremental measurement, a simulation of the "similar" warning, third-party license generation, and the version check CI runs.
- `examples/`: reports generated on public code.
  - `unkey/web` @ 7d0f002 and `dub` @ c43a4b3. Timings and counts are in [`examples/CORPUS.md`](examples/CORPUS.md).
  - `module-federation-examples` @ 9c4e554: three micro-frontend examples, each app analyzed as a separate repository (0.4 reports).

## Development

```bash
npm ci
npm test          # includes the MCP test, which uses the bundle: run npm run build first
npm run build     # plugin/dist/ast-layer.cjs and THIRD_PARTY_LICENSES.txt
```

A change to `src/` needs `npm run build` and the rebuilt `plugin/dist/` in the same commit: CI fails when the committed bundle differs from what the sources build.

Releasing: bump the version in `package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `TOOL` in `src/analyze.js`, add the `CHANGELOG.md` entry (`node scripts/check-versions.mjs` checks they agree), build, commit and tag `v<version>`.

## License

MIT, see [`LICENSE`](LICENSE). The bundle includes third-party dependencies under permissive licenses; their texts are generated in `plugin/dist/THIRD_PARTY_LICENSES.txt`.
