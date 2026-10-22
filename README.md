# ast-layer

A deterministic AST layer for coding agents, packaged as a Claude Code plugin.

It analyzes one or more JS/TS repositories (monorepos, micro-frontends, shared libraries) and gives Claude **facts with exact locations**: code duplicated across packages, copies of library exports, imports that bypass a package's public entry, cycles, Module Federation contracts, and your own architecture rules. Each finding has a class (`provable`, `agent-guided` or `manual-review`) that tells the agent what it may do with it. The class is decided before the model sees the code.

What it detects and how to use it is in [`plugin/README.md`](plugin/README.md). Changes by version are in [`CHANGELOG.md`](CHANGELOG.md).

## Installation

The plugin needs its bundle (`plugin/dist/ast-layer.cjs`), which is not versioned. There are two ways to get it.

**From a release:** download `ast-layer-plugin-<version>.zip` from the Releases page and unzip it into a folder. Then:

```bash
claude --plugin-dir <folder>           # for this session only
```

To keep it installed, create a local marketplace with that folder as `plugins/ast-layer` and a `.claude-plugin/marketplace.json` that lists it. Then:

```bash
claude plugin marketplace add <marketplace-folder>
claude plugin install ast-layer@<marketplace-name>
```

**From source:**

```bash
npm ci
npm run build                          # creates plugin/dist/
claude --plugin-dir ./plugin
```

Requirements: Claude Code and Node 18 or later. git is optional: without git, discovery walks the file tree; PR mode needs git.

## What it does on your machine

- **It reads; it does not write.** The analysis runs with disk writes blocked (`src/guard.js`), and a static test checks that the analysis modules have no write path. The only module that writes is `src/writer.js`.
- **Where it writes:**
  - the index, the report and `hook-log.jsonl` go to the plugin's data directory (`$CLAUDE_PLUGIN_DATA`), outside the repository;
  - inside the repository it only writes `ast-layer.decisions.json`, and only when you ask it to remember a decision;
  - PR mode extracts the base ref to a temporary directory outside the repository and removes it afterwards.
- **It never edits your code.** Codemods (`propose_fix`) return a verified diff, and the agent applies it with Edit.
- **No network.** It does not run the analyzed project's code or load its `node_modules`. It only runs `git` (`ls-files`, `rev-parse`, `archive`, `diff`) and, in PR mode, `tar`.
- **Hooks:**
  - `SessionStart` scans the project at the start of each session, or reuses the previous scan when nothing changed;
  - `PostToolUse` compares every file Claude writes with the index;
  - both stay silent if anything fails, and never block the session;
  - `AST_LAYER_SESSION_SCAN=off` turns the session scan off.
- **Telemetry (`stats`) is local:** it reads `hook-log.jsonl` and sends nothing.

See [`SECURITY.md`](SECURITY.md) for the threat model and how to report a vulnerability.

## Layout

- `plugin/`: the plugin (manifest, MCP server, hooks, skills and agent). The bundle goes in `plugin/dist/`.
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
  - `mcp.js` and `cli.js`: the MCP server and the command line.
- `test/`: a fixture (`test/fixtures/acme`) with one case per rule, plus tests for determinism, read-only behavior, incremental analysis, hooks, PR mode, codemods, security and the MCP server over stdio.
- `scripts/`: incremental measurement, a simulation of the "similar" warning, and third-party license generation.
- `examples/`: reports generated on public code.
  - `unkey/web` @ 7d0f002 and `dub` @ c43a4b3. Timings and counts are in [`examples/CORPUS.md`](examples/CORPUS.md).
  - `module-federation-examples` @ 9c4e554: three micro-frontend examples, each app analyzed as a separate repository (0.4 reports).

## Development

```bash
npm ci
npm test          # includes the MCP test, which uses the bundle: run npm run build first
npm run build     # plugin/dist/ast-layer.cjs and THIRD_PARTY_LICENSES.txt
```

## License

MIT, see [`LICENSE`](LICENSE). The bundle includes third-party dependencies under permissive licenses; their texts are generated in `plugin/dist/THIRD_PARTY_LICENSES.txt`.
