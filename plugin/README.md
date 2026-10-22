# AST Layer: a Claude Code plugin

A deterministic, read-only layer between the agent and JS/TS code. It turns one or more repositories into an ordered list of **facts with exact locations**, and gives each fact a class that says what the agent may do with it:

| Class | Meaning | What the agent does |
|---|---|---|
| `provable` | The change is mechanically safe | Applies the `nextAction` exactly |
| `agent-guided` | The site is certain; the replacement needs a check | Works inside the finding, settles doubts with a minimal test, respects the stop conditions |
| `manual-review` | It depends on intent | Does not touch code; presents the decision to a person |

The class is decided **before** the model sees the code, and the agent cannot upgrade it.

## What it detects

- **`duplicate.reinvents-library-export`**: a local copy of something a workspace library already exports. The public API is computed by following re-export chains to the original declaration.
- **`duplicate.cross-package`**: the same code in several packages or micro-frontends, with no copy in any library. It includes a "candidate home": a library every package with a copy already depends on, or a Module Federation container they all consume.
- **`duplicate.within-package`** and **`duplicate.multiple-library-exports`**.
- **`duplicate.similar`**: definitions in different packages that share most of their structure but are not identical (see below).
- **`duplicate.module`**: whole files that are copies of each other, reported as one module rather than function by function.
- **`boundary.bypasses-package-entry`**: deep imports or relative paths that reach into another package without going through its public entry.
- **`graph.package-cycle`**: cycles between packages, counting runtime edges only. A type-only import does not count, even when it is not written as `import type`.
- **`federation.import-not-exposed`** and **`federation.expose-file-missing`**: broken Module Federation contracts between host and remotes.
- **`deps.version-drift`**: different ranges of the same dependency, flagged when it is a federation `shared` dependency.
- **`packages.duplicate-name`**: two packages with the same name.
- **CSS and i18n messages** (all `manual-review`):
  - **`css.duplicate-token`**: two or more custom properties with the same names and normalized values in 2+ packages. If a package the others already import defines them, the finding names it as the home.
  - **`css.duplicate-rule-block`**: a block of 4+ declarations, identical across packages after normalizing order, whitespace and color case. Resets (element-only, `*` or `:root` selectors), `@keyframes` steps and trivial blocks are skipped.
  - **`i18n.duplicate-messages`**: same-language locale files in different packages that share 10+ identical key/value pairs covering at least 70% of the smaller file. They are recognized by folder (`locales/`, `i18n/`, `lang/`, `translations/`, `messages/`) or by name (`es.json`, `pt-BR.json`).
  - **Parser:** CSS and SCSS are read with postcss and postcss-scss, bundled.
  - **Session note:** one aggregated line per kind, not one per finding.
- **`architecture.rule-violation`**: an import that breaks a rule in `ast-layer.rules.json` (see below). Always `manual-review`.

Every finding has an `id`, which depends on its position and is kept for compatibility, and a `key`, which is its identity. The `key` is computed from what the finding is about (files, names, packages and a hash of each member's code), never line numbers:
- adding lines above a copy changes the `id` but not the `key`;
- editing the copy changes the `key`.

### Recorded decisions

When the user decides something about a finding ("these copies stay separate", "it is a false positive"), the agent records it with `record_decision`, or you do with `ast-layer decide <key> --decision keep-separate|extract-later|accepted-copy|false-positive [--note …] [--scope repo|user]`.

- **`scope: repo`** (the default) writes `ast-layer.decisions.json` at the repository root, to share it with the team through git. It is the plugin's only write inside the repository, and it only happens on request.
- **`scope: user`** keeps the decision in the plugin's data directory.
- **Effect:** the finding gets `status: "decided"` and leaves the session note and `findings` (unless `includeDecided`); post-edit warnings mention the decision instead of proposing an extraction again.
- **When the finding's code changes, its `key` changes:** the decision stops applying and the finding comes back with `previousDecision.outdated`.
- **Engram, optional:** when the session has its tools, the agent also saves the decision under the topic key `ast-layer/decision/<key>` and searches for it before planning.

### Your own architecture rules

Optional: an `ast-layer.rules.json` at the top of each root.

```json
{
  "rules": [
    { "id": "apps-no-cross-import", "from": "apps/*", "to": "apps/*", "allow": false, "message": "Apps do not import from each other; use @acme/ui." },
    { "id": "no-legacy", "from": "*", "to": "@acme/legacy-ui", "allow": false, "except": ["apps/admin"] },
    { "id": "ui-no-utils-internals", "from": "@acme/ui", "toSpecifier": "@acme/utils/src/**", "allow": false }
  ]
}
```

- **`from` / `to`:** globs over the package name or its directory relative to the root. A bare `*` matches any package. `to` also matches external package names.
- **`toSpecifier`:** a glob over the import's literal specifier.
- **`except`:** source packages exempted from the rule.
- **`"allow": true`:** cancels the denials that match the same import.
- **Type-only imports** are ignored unless `"includeTypeOnly": true`.
- **Not checked:** test files, and Module Federation remote imports against `to` (only against `toSpecifier`).
- **Malformed file:** it is validated with zod. If it is invalid, the problem is reported in `limits` and no rule from that file applies.

Violations appear:
- in the session note, one line per violated rule, together with the rules that have no violations;
- in the post-edit warning, when a new import breaks a rule.

### How it decides that two functions are "the same"

- Normalization uses the TypeScript compiler's binding resolution, not text. Locally bound identifiers are renamed, formatting and comments disappear, and `function f(){}` / `const f = () => {}` normalize the same at the unit root.
- **exact**: same structure, same literals and same types.
- **near**: same structure; a few literals or types differ. The report shows exactly which values differ.
- **similar**: 80% of the structure in common (5-token shingles, MinHash/LSH candidates), or 60% when both definitions have the same name, excluding framework names such as `GET`, `default` or `Page`. At least half of the literal values must be shared. Cross-package only.
- A copy is **`provable`** only when all of these hold:
  - it is exact;
  - every free identifier resolves to the same declaration as in the library copy;
  - the dependency is already declared;
  - both modules have the same `"use client"` / `"use server"` directive;
  - importing the library entry adds no side-effect imports (such as CSS) to the file.

## Installation

Requires Node.js 18 or later on the `PATH`. The analyzer is bundled in `dist/ast-layer.cjs`, so no `npm install` is needed.

```bash
claude --plugin-dir ./plugin        # try it locally
claude plugin validate ./plugin     # validate
```

To keep it installed or share it with a team, add it to a plugin marketplace.

## What it adds to Claude Code

- **MCP server `ast-layer`** with these tools:
  - `scan`: analyzes one or more roots. It keeps the TypeScript program in memory: the next `scan` reuses unchanged files and gives the same result as a full scan.
  - `findings`: filters by class, kind, name, package or file. Filtered by `name` or `file`, the first 10 results carry an evidence summary (copies with their package, differences, where a shared version could live). Broad filters (`package`, `kind`, `class`) return no evidence. `evidence: "full"` inlines the complete evidence of the first 5, and `finding` returns the whole record. `includeDecided` also returns findings with a recorded decision.
  - `finding`: the complete evidence of one finding, by id or key.
  - `search_names`: searches names and concept words across every unit and public export. It takes several searches in one call (`queries`), and each hit that is a copy of a known duplicate carries `duplicateFindings` with its `key` and class.
  - `find_equivalent`: answers "does this code already exist?". It finds identical and near-identical copies, and similar code.
  - `package_graph`: packages, roles, edges, federation and exports nobody consumes.
  - `propose_fix`: the verified diff for a provable finding. It never writes.
  - `pr_findings`: the findings a change introduces, compared with a git ref or a saved report.
  - `record_decision`: records a decision about a finding, only when the user asks.
  - `stats`: local hook telemetry.
- **Skill `ast-layer`**: tells Claude when to use the layer and how to act on each class.
- **Skill `/ast-layer:plan-task <task>`**: builds a fact-based implementation plan. For each piece it decides between reusing, exposing an existing copy, extracting, or writing something new.
- **Subagent `task-scout`**: does the same exploration in a separate context and returns the plan.
- **`SessionStart` hook**: scans the project when the session starts and adds an `[ast-layer]` note to Claude's context with:
  - the provable findings;
  - the architecture rules;
  - the duplicates with their class;
  - the other names that already exist in more than one package (single definitions first, largest first; when they do not all fit, the list ends with "and N more");
  - the rules for acting on each case.

  If nothing changed since the last scan (same signature of files, configuration, version and options, and no recorded edits), it reuses the report without scanning again. The index lives in the plugin's data directory, never in the repository. `AST_LAYER_SESSION_SCAN=off` turns the scan off.
- **`PostToolUse` hook**: after each Claude `Write` or `Edit`, it compares the new or changed functions with the index of the last scan and warns Claude in the same turn when:
  - they match existing code: identical, near-identical or **similar** (always in another package);
  - they have the same name as an existing definition;
  - an import breaks an architecture rule.

  Each warning carries the rule that applies. It also marks the index as stale (`stale.json`). If anything fails, it does nothing.
- **Hook log and `stats`:** every hook run appends one line to `hook-log.jsonl` in the plugin's data directory. `ast-layer stats [--since 7d] [--json]` (or the `stats` MCP tool) shows:
  - sessions, and how many reused the scan;
  - post-edit warnings by type (structural, similar, same-name, architecture-rule);
  - the files warned;
  - the outcome of each warning: "warning followed" when the warned unit is gone at the next edit of that file (or from the file on disk when queried), or "copy kept".

  Everything stays local; nothing is sent anywhere.

Troubleshooting: the index is keyed by the project's real path. If you replay a hook through a symlink to the workspace, the path changes and the hook scans again.

## Use without Claude (CLI and CI)

```bash
node plugin/dist/ast-layer.cjs scan .                              # one repo or monorepo
node plugin/dist/ast-layer.cjs scan ../shell ../mfe-a ../mfe-b     # several repos as one group
node plugin/dist/ast-layer.cjs findings --class provable
node plugin/dist/ast-layer.cjs equivalent --file src/utils/price.ts
node plugin/dist/ast-layer.cjs fix <id-or-key>                     # verified diff (does not write)
node plugin/dist/ast-layer.cjs pr --base origin/main               # findings the branch introduces
node plugin/dist/ast-layer.cjs decide <key> --decision keep-separate --note "each app owns its hook"
node plugin/dist/ast-layer.cjs stats --since 7d
```

### Verified codemods

`propose_fix(id)` (MCP) and `ast-layer fix <id|key>` (CLI) work only for `provable` findings of `duplicate.reinvents-library-export` and `boundary.bypasses-package-entry`.

- **The change** is generated from facts already computed and edited at AST node positions, never with regexes:
  - delete the local copy, import (or merge into the existing import of) the library's, and re-export under the local name if it was exported;
  - or point the specifier at the public entry.
- **Verification, without writing to disk:** a TypeScript program overlays the edited files in memory, and three things are required:
  - the edited files and their importers gain no syntactic or semantic diagnostic;
  - the finding disappears;
  - no other finding appears. A finding about the same code that only got smaller does not count as new (for example, a `duplicate.module` going from "4 of 4" to "3 of 4" matching definitions when the copy is removed); it is listed in `shrunkFindings`.
- **Output:** a unified diff, the `edits` (`oldString` / `newString`, unique in the file) to apply with Edit, and `verified`. When `verified` is false, it also lists the new diagnostics or findings.
- **The plugin never applies the change.** The skill tells the agent to apply it only when `verified: true`.
- **Architecture rules:** if the import a fix would need breaks a rule, the finding is no longer `provable`; it becomes `manual-review`.

### PR mode

```bash
node plugin/dist/ast-layer.cjs pr --base origin/main                 # markdown for a PR comment
node plugin/dist/ast-layer.cjs pr --base origin/main --format json --fail-on provable,agent-guided
node plugin/dist/ast-layer.cjs pr --baseline main-report.json        # without git: against a saved report.json
```

- **Base:** extracted with `git archive <ref>` to a temporary directory outside the repository, removed afterwards. The ref is resolved to a commit SHA first; values that start with `-` are refused.
- **Head:** the working tree.
- **Comparison:** both are scanned with the same options and the same root label. It reports findings whose `key` is not in the base, plus findings that touch files changed in `git diff --name-only <ref>...HEAD`.
- **Decisions and rules:** recorded decisions and architecture rules apply.
- **Options:**
  - `--fail-on`: exit code 1 when there are findings of those classes.
  - `--max N`: how many are listed.
- **MCP:** the `pr_findings` tool returns the same.

A GitHub Action that comments the result on the PR:

```yaml
name: ast-layer
on: pull_request
jobs:
  ast-layer:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # git archive origin/main needs the history
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: ast-layer pr
        id: ast
        run: |
          set +e
          node tools/ast-layer/dist/ast-layer.cjs pr --base origin/${{ github.base_ref }} --fail-on provable > ast-layer.md
          echo "exit=$?" >> "$GITHUB_OUTPUT"
      - name: Comment on the PR
        env: { GH_TOKEN: "${{ github.token }}" }
        run: gh pr comment ${{ github.event.pull_request.number }} --body-file ast-layer.md --edit-last || gh pr comment ${{ github.event.pull_request.number }} --body-file ast-layer.md
      - if: steps.ast.outputs.exit != '0'
        run: exit 1
```

In this example, `tools/ast-layer/dist/ast-layer.cjs` is the plugin's bundle copied into the repository. The file has no dependencies, so no `npm install` is needed.

The output goes to `.ast-layer/`:
- `REPORT.md`: for reading.
- `report.json`: the findings.
- `index.json`: each unit's fingerprints, with the MinHash of the large ones.
- `similar.json`: shingles and literals of the large units, for similarity lookups.
- `meta.json`: commit, duration and scan signature.
- `stale.json`: files edited after the scan, written by the post-edit hook.

For the same code, `report.json`, `index.json`, `similar.json` and `REPORT.md` are byte-identical across runs, so they can be compared in CI. `report.json` uses `schema: 2` since 1.0. `--out` only replaces a directory that is absent, empty, or holds a previous report.

## Read-only by construction

- While the analysis runs, every `fs` write API throws.
- Only `writer.js` writes: the scan goes to a staging directory first and is published with a rename. It also writes, atomically, `stale.json`, the decisions file (only when the user asks) and the temporary copy of the PR-mode base, outside the repository and removed afterwards.
- The tests check that the content, mode and `mtime` of analyzed files do not change, that two runs produce identical bytes, and that the analysis modules have no write path.

## Limits (printed in every report)

- It analyzes JavaScript and TypeScript, plus CSS/SCSS and locale JSON, the latter only to find copies. `.vue`, `.svelte`, `.astro` and `.mdx` files are counted and reported, not analyzed.
- **"Similar" is not "equivalent":** similar matches ask for a comparison before reuse. A copy that was renamed **and** rewritten below 80% shared structure is not detected; with the same name, 60% is enough. Framework names (`GET`, `default`, `Page`, …) never get the lower bar.
- **Codemod verification** guarantees that no new errors appear in the analyzer's own program, which has no lib files and no external packages. It does not run the project's build or tests.
- External packages are never resolved, on purpose: the result does not depend on `node_modules` being installed.
- Federation remotes built at runtime, and consumers outside the analyzed roots, are invisible.
- Structural similarity is not semantic equivalence. A report with no findings is not a quality verdict.

## Development

```bash
npm ci
npm test        # 62 tests: fixtures, determinism, read-only, incremental, hooks, rules, decisions, PR mode, codemods, CSS/i18n, stats, security, MCP server over stdio
npm run build   # rebuilds plugin/dist/ast-layer.cjs and THIRD_PARTY_LICENSES.txt
```
