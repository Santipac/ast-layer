---
description: Use before creating a new file, function, hook, component or util in a JS/TS repo that has sibling apps, micro-frontends or shared @scope packages; when a request says duplicated, copy, already exists, reuse, unify, extract or shared library; before resolving a duplication or applying a refactor across packages; when adding an import across packages; before opening or reviewing a PR; when the user records a decision about duplicated code; and when asked about architecture or what depends on what. Gives deterministic facts (existing and similar copies, library exports, architecture rules, boundaries, cycles, federation contracts, copied CSS tokens and locale messages) classified provable / agent-guided / manual-review, verified fixes for provable ones, and the findings a change introduces.
---

# AST layer

The `ast-layer` plugin computes facts about the code with a read-only, deterministic analyzer (TypeScript compiler API, binding resolution, resolved imports). Treat them as evidence, not opinion, and do not re-derive what they already state.

## 0. What you already have

At session start the plugin scans the project and adds a note marked `[ast-layer]` to your context: counts by class, the provable findings with their exact action, the team's architecture rules, the code (and the CSS and locale messages) that already exists in more than one package with its class, and the rules for acting on each case. Findings with a recorded decision are left out of it. Read it before planning; the rules in it apply even if you never open this skill.

The MCP tools may be deferred. If you only see their names, load them first with `ToolSearch` (query `ast-layer`), or delegate the research to the `task-scout` agent, which has them.

| Tool | Answers |
|---|---|
| `search_names` | Does something with this name or purpose already exist anywhere, including public library exports? Takes several `queries` in one call. Returns the import line for exports, and `duplicateFindings` when a hit is one of the copies of a known duplicate. |
| `findings` / `finding` | Known duplicates, boundary bypasses, cycles, architecture-rule violations and contract problems, filtered by name, class, kind, package or file. Filtered by `name` or `file`, the first 10 results carry an evidence summary (copies with their package, differences, candidate homes), enough to present a decision; broad filters (`package`, `kind`, `class`) return none. `finding` (id or key) has the full record; `evidence: "full"` inlines it for the first 5. Prefer a few specific queries over many broad ones. |
| `find_equivalent` | Is this draft or file a copy of existing code (identical, near-identical) or similar to it (80%+ of the structure, or 60%+ against a definition with the same name; another package)? A re-implementation written from a description will not match. |
| `package_graph` | Which packages depend on which, what each library exports, and federation containers. |
| `scan` | Rescan after changes, or analyze several repos as one group (pass every path in `roots`). Incremental: unchanged files are reused. |
| `propose_fix` | For a `provable` library-copy or boundary-bypass finding: a verified diff (TypeScript diagnostics before/after, finding gone, nothing new; a module copy that only got smaller is listed in `shrunkFindings` and does not block). Never writes. |
| `pr_findings` | Which findings does this change introduce, compared with a git ref (default `origin/main`) or a saved report? Use before opening or reviewing a PR. |
| `stats` | Local hook telemetry (sessions, warnings by type, whether warned copies were removed). Only when the user asks how the plugin is doing. |
| `record_decision` | Only when the user asks to remember a decision about a finding (keep-separate, extract-later, accepted-copy, false-positive). |

## 1. Before writing new code

1. Call `search_names` once, with `queries` holding the name you would give the thing and two or three concept words (`["useConfirmDialog", "confirmation dialog"]`).
2. Call `findings` for the package or folder you are about to change.
3. Decide, citing what the tools returned:
   - **A public export exists** and the package already depends on that library: import it. The tool gives the line.
   - **A copy exists in another app or package, but not in a library:** do not add another copy. Tell the user where the copies are; sharing them is the user's decision.
   - **Nothing found:** write it. A name search that finds nothing is weak evidence, so say what you searched for.
   - **The user explicitly asked for a copy** ("copy it from Profile"): do it. The facts and warnings are there to inform, not to block a request; mention the existing copies once and do not undo the copy.

After an edit, the plugin's hook may add an `[ast-layer]` note that the new code is identical to, similar to, or has the same name as existing code, or that an import breaks an architecture rule, together with the rule for that case:
- **identical / near-identical:** a fact; follow its rule (import the public export, or remove the new copy and ask the user).
- **similar, not identical:** compare both before reusing or keeping it; if they do the same thing, the identical rule applies.
- **same name:** a lead to check.
- **architecture rule:** the team wrote `ast-layer.rules.json`; remove the forbidden import or ask the user. Never write an import a listed rule forbids; if the task needs one, name the rule and ask first.

Stylesheets and locale files are scanned too: `css.duplicate-token`, `css.duplicate-rule-block` and `i18n.duplicate-messages` (all manual-review). Before adding CSS custom properties, a style block or translations to an app, check whether a shared package already defines them (the session note names the home) and reuse it instead of copying.

Findings have an `id` (positional) and a `key` (stable across line shifts; changes when the code it is about changes). Cite the key when something must survive edits.

## 2. Acting on findings: the class decides what you may do

The class was set before any model saw the code. **Never upgrade it**, and never describe a change as provable unless the finding says so.

| Class | What you do |
|---|---|
| `provable` | Apply exactly the `nextAction` and nothing else. Its preconditions are already verified (same declarations, dependency declared, no new side effects), so you do not need to re-check them. For library copies and boundary bypasses, call `propose_fix` and apply its `edits` with Edit **only if `verified: true`**; if it is false, do not apply it, report the reason (new diagnostics or findings) and fall back to presenting the finding. Rescan afterwards. |
| `agent-guided` | Act only inside the finding. Inspect the listed differences: literal values, free identifiers, module-level state, module-loading facts, missing dependency. Settle any doubt with the smallest focused test or runtime observation. If a stop condition applies, stop and report. |
| `manual-review` | Do not change code. Present the decision: the copies, the differences, the candidate home and what each option implies. |

## 3. Decisions the user already made

A finding with a recorded decision has `status: "decided"`. It is left out of the session note, of `findings` (unless `includeDecided`), and edit warnings say when they touch it. **Do not propose again what a decision settled** (for example, extracting copies marked `keep-separate`). If a finding shows `previousDecision` with `outdated: true`, the code changed since the decision: mention the old decision and ask whether it still holds.

Record a decision with `record_decision` **only when the user asks for it**, with their reason as the `note`:
- `scope: "repo"` (default) writes `ast-layer.decisions.json` at the repository root, so it is shared with the team through git. Say so.
- `scope: "user"` keeps it private.

**Engram (optional).** If the session has Engram memory tools (`mem_save` / `mem_search`, e.g. `mcp__engram__mem_save` or `mcp__plugin_engram_engram__mem_save`):
- after recording a decision, also call `mem_save` with `topic_key: "ast-layer/decision/<findingKey>"`, the decision and the note;
- before planning a task, call `mem_search` with `ast-layer/decision` and the names involved.

Without Engram, the decisions file is enough.

## 4. Reporting

Cite findings by id and `file:line`. Keep facts from the tool separate from your own judgment. When the tool cannot see something (another language, a blind-spot package, external consumers, runtime-built remotes), its limits say so; repeat that limit instead of guessing.

## CLI fallback

If the MCP server is not available, the same facts come from the bundled CLI (`node "${CLAUDE_PLUGIN_ROOT}/dist/ast-layer.cjs" <command>`):

| Command | Does |
|---|---|
| `scan . --out .ast-layer` | Scan; then read `.ast-layer/REPORT.md`. |
| `findings --out .ast-layer [--name n] [--class c] [--include-decided]` | Query findings. |
| `equivalent --file path --out .ast-layer` | Copies and similar code of a file. |
| `fix <id-or-key> --out .ast-layer` | Verified diff for a provable finding (never writes). |
| `pr --base origin/main` | Findings this branch introduces (markdown; `--format json`, `--fail-on`). |
| `decide <key> --decision keep-separate --note "…"` | Record a decision, only when the user asks. |
| `stats --since 7d` | Local hook telemetry. |
