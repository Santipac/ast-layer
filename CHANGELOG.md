# Changelog

## 1.2.1

Security review before publishing the repository.

- **`pr --base` validates the ref.** A ref that starts with `-` is refused, and the ref is resolved to a SHA before it reaches `git archive` and `git diff`. Before, a ref such as `--output=…`, which the model can pass through `pr_findings`, reached git as an option.
- **`--out` never replaces an unrelated folder.** `writeReport` swaps the whole output directory. It now does so only when the directory is absent, empty, or holds a previous report (`report.json` or `meta.json`); otherwise it fails without touching anything.
- **Globs in `ast-layer.rules.json` are matched without regular expressions.** The file comes from the analyzed repository. A pattern such as `**/**/…*x` made the generated RegExp backtrack for minutes and hung the session-start hook until its timeout. Globs are now matched with dynamic programming (pattern × text), and the schema caps their size: globs up to 300 characters, up to 100 `except` entries per rule, up to 500 rules.
- **Symlinks:** a tracked symlink that points outside the root is no longer read.
- **Third-party licenses:** the build writes `plugin/dist/THIRD_PARTY_LICENSES.txt` with the license of the 14 packages inside the bundle. All are permissive (MIT, ISC, BSD-3-Clause, Apache-2.0).
- **The repository has a `LICENSE` (MIT), a `SECURITY.md`, and English documentation.**

## 1.2.0

- **`findings` no longer inlines the full evidence on every query.**
  - New `evidence` parameter, with three values:
    - `summary`: copies with their package and lines; literal, free-identifier and module-state differences; the first 3 similarity pairs, numbered by copy; `candidateHomes`, `home` and `brokenRules`. No hashes or module-loading details.
    - `full`: the complete evidence of the first 5, as in 1.1.
    - `none`.
  - **Defaults:** `summary` for the first 10 results when filtering by `name` or `file`; `none` for broad filters (`package`, `kind`, `class`).
  - With a summary, the copies replace `where`, which repeated them.
  - Every MCP response is compact JSON, without indentation.
- **Effect:** in a workspace of 4 micro-frontends, broad queries are 23–35% smaller than in 1.1, and smaller than in 1.0. In agent runs, the cost of tasks that explore many findings went back to the 1.0 level, with the same score.

## 1.1.0

- **`propose_fix` no longer rejects its own correct diff.** When the removed copy is also part of a copied module, the `duplicate.module` goes from "4 of 4" to "3 of 4" and its `key` changes. Verification used to count it as a new finding. Now a finding with the same `anchor` that only got smaller (no new locations and, for modules, no pair sharing more definitions) goes to `shrunkFindings` and does not block `verified`.
- **"similar" no longer breaks when a variable is added, and the same name lowers the bar to 60%.**
  - **Cause:** locals are numbered by first use. Adding one variable (for example `const url = new URL(...)`) renumbered every later one and changed almost every shingle after it. A copy with a single changed line scored 0.40 Jaccard. The similarity stream now uses one token for every local. `exact` and `near` do not change, so finding keys stay the same.
  - **With that alone, that copy reaches 0.64**, still below 0.8. Lowering the general threshold does not work: between 0.6 and 0.65 there are pairs with different names that are not copies (SVG icons in dub, for example). So there is a new threshold, `similarSameNameThreshold: 0.6`, that applies only when both definitions have the same name, excluding framework names (`CONVENTIONAL_NAMES`). Those pairs are compared directly, without depending on LSH. It applies in the scan, in `find_equivalent` and in the post-edit hook.
  - **Noise, reviewed by hand:** 27 of 27 new pairs in the samples were real copies. On unkey 3 new pairs appear, all real; dub does not change. Some pairs with different names that sat right at 0.80–0.81 are lost.
- **Fewer calls for the same answer.**
  - `search_names` takes `queries` (up to 6 searches in one call), and marks with `duplicateFindings` (`key`, kind and class) the hits that are copies of a known duplicate.
  - The skill asks for one call with the name and the concept together.
- **The names line of the session note is cut instead of dropped.** As many names as fit, ending with ", and N more", and the blind-spot line that follows keeps its room. Names are now ordered by size, single definitions first and then definitions of copied modules. They used to be alphabetical, so cutting the list always dropped the names at the end of the alphabet.

## 1.0.0

- **Stable finding identity (3.0).** Every finding has a `key`, computed from its kind and what it is about (files, names, packages and the members' `exact` hashes, specifiers, ranges), never line numbers. Adding or removing lines above a copy changes `id` but not `key`; editing the copy changes `key`. It also has an `anchor`, a looser identity without hashes, which recognizes "the same finding, but the code changed". `finding` accepts an id or a key. `id` is kept for compatibility.
- **Incremental analysis (3.1).**
  - Every scan stores in `meta.json` a signature of everything that affects its result: path, size and mtime of each file; the content of package.json, tsconfig/jsconfig and `ast-layer.*.json`; version and options.
  - `hook-session-start` reuses the report when the signature matches and no edits were recorded.
  - The MCP server keeps the last `ts.Program` and rebuilds with `oldProgram`, reusing every SourceFile whose text did not change. `scan` reports `incremental.reusedFiles`, `parsedFiles` and `editedSinceLastScan`.
  - `hook-post-edit` marks the index as stale (`stale.json`).
  - A test checks that incremental and full analysis give identical bytes after editing, adding and deleting files.
- **Similar code on edit and in lookups (3.2).**
  - `find_equivalent`, `equivalent` (CLI) and `hook-post-edit` add **similar** matches against the index, with the same rule as `duplicate.similar` groups: Jaccard ≥ 0.8 over shingles, units of 60+ nodes, literal guard ≥ 0.5, other packages only.
  - `index.json` stores the MinHash of large units; shingles and literals go to `similar.json`, loaded only when there are candidates.
  - The post-edit warning says "similar, not identical" with its rule: compare before reusing; if it is the same thing, rules 1 and 2 apply.
  - `find_equivalent` now returns `{ matches, note }`.
- **Your own architecture rules (3.3).**
  - Optional `ast-layer.rules.json` per root, validated with zod. A malformed file is reported in `limits` and never crashes the scan.
  - New kind `architecture.rule-violation` (`manual-review`).
  - Violated rules go to the session note with one compact line each, and the rules with no violations in a separate line.
  - The post-edit hook warns when a new import breaks a rule.
- **Session note with a budget:** lines are added by priority (provable, rules, duplicates, names, blind spot) while they fit. The tools line and `ACTION_RULES` always close the note, and the total never exceeds 3800 characters.
- **Recorded decisions (3.4).**
  - MCP tool `record_decision` and command `decide`, with `keep-separate`, `extract-later`, `accepted-copy` or `false-positive`, a note, and `scope` `repo` or `user`.
  - `scope: repo` writes `ast-layer.decisions.json` at the root, only through `writer.js` and only on request. `scope: user` writes to `$CLAUDE_PLUGIN_DATA/decisions/`.
  - Findings with a decision get `status: "decided"` and leave the session note and `findings`, unless `includeDecided`.
  - When the `key` changes because the code changed, the finding comes back with `previousDecision.outdated`. For that, each decision also stores the `anchor`.
  - The `ast-layer` and `plan-task` skills use Engram (`mem_save` / `mem_search`, topic `ast-layer/decision/<key>`) when it is available.
- **PR mode (3.5).**
  - `ast-layer pr --base <ref> [--format md|json] [--fail-on …] [--max N]`, or `--baseline <report.json>` when there is no git.
  - The base is extracted with `git archive` to a temporary directory outside the repository, through `writer.js`, and removed afterwards. Base and head are scanned with the same options and the same root label.
  - It reports findings with a new `key` plus those that touch changed files; decisions and rules apply.
  - The output is markdown for a PR comment, and the exit code is 1 with `--fail-on`.
  - MCP tool `pr_findings`, and a GitHub Action example in the README.
- **`report.json` moves to `schema: 2`.** Findings add `key`, `anchor`, `decision` / `previousDecision`, and `summary.decided`.
- **Verified codemods (3.6).**
  - `propose_fix(id)` (MCP) and `fix <id|key>` (CLI), only for `provable` findings of `duplicate.reinvents-library-export` and `boundary.bypasses-package-entry`.
  - Edits use AST positions: delete the definition and import or re-export, or change the specifier and rename bindings when needed.
  - Verification uses a `ts.Program` with an in-memory overlay: diagnostics of the edited files and their importers before and after, and a re-analysis (the finding disappears and no other appears).
  - It returns a unified diff, `edits` for Edit, and `verified`. It never writes.
- **Rules over classes:** a `provable` replacement whose import would break an architecture rule is downgraded to `manual-review` (`evidence.brokenRules`). This applies to library copies and boundary bypasses.
- **CSS and i18n JSON (3.7).**
  - Discovery adds `.css`/`.scss` (including `.module.*`) and locale JSON, recognized by folder or by a file name with an ISO 639-1 code. The same directories are excluded, with the same size limit.
  - postcss and postcss-scss are bundled.
  - New kinds, all `manual-review`, grouped by file set: `css.duplicate-token` (names the shared home), `css.duplicate-rule-block` and `i18n.duplicate-messages`.
  - The session note gets one aggregated line per kind.
  - In the session note, `provable` findings already listed with their action are not repeated in the duplicates list.
- **Local telemetry (3.8).** `ast-layer stats [--since 7d] [--json]` and the MCP tool `stats`, which read `hook-log.jsonl`:
  - sessions, and how many reused the scan;
  - post-edit runs and warnings, by type;
  - files warned;
  - the outcome of each warning: followed, or copy kept.

  `hook-post-edit` now logs the project, the file's unit inventory and the warned units (name, type and hash). Nothing is sent.
- **Wrap-up (3.9).**
  - Version 1.0.0 in `TOOL.version`, `plugin.json` and `package.json`. `report.json` uses `schema: 2`.
  - Tool and command tables updated in `SKILL.md`, `plan-task`, `task-scout` and the READMEs.
  - A real run on dub and unkey (`examples/CORPUS.md`): no regression in the 0.x kinds. It fixed reading of Tailwind v4 tokens (`@theme`) and raised the `css.duplicate-token` threshold to 2 tokens per group, after measured noise.
  - Measurement scripts in `scripts/`.
