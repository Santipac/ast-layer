# ast-layer report

Roots: `web` · 2981 files · 27 packages · 37 findings

Every finding below is an observation with an exact location. Its class says whether acting on it is mechanical, needs a focused check, or needs a human decision.

## Limits (printed on every run)

- Every record is an observation about the code, not a verdict. A run with no findings is not a readiness or quality result.
- Only JavaScript/TypeScript is analyzed (skipped: 14 .mdx).
- Excluded from analysis: 1 × declaration file (.d.ts).
- External packages are never resolved, by design (results do not depend on node_modules). 91 distinct external packages were imported.
- 5 relative import(s) and 2 workspace-package import(s) did not resolve to an analyzed file; bindings through them are unknown.
- 1 dynamic import()/require() call(s) with non-literal specifiers were not followed.
- Duplication: top-level functions, components and classes with at least 40 AST nodes and 5 lines, excluding tests and stories. Normalization ignores formatting and comments and renames locally-bound identifiers; free identifiers keep their names. "near" also abstracts literals and types and is only reported when at most 5 literal positions differ and the differing characters are at most 24 or 25% of all literal characters. "similar" groups (cross-package only) need 60+ AST nodes and 80% shared structure (5-token shingles over the "near" stream with every local as one token, MinHash candidates), or 60% when both definitions have the same name (framework names such as GET, default or Page excluded; compared directly, without MinHash), plus at least half of their literal values in common. A copy that was renamed and rewritten below 80% is not seen. Module copies need 3+ matching top-level definitions covering 75% of the larger file. Structural similarity is not semantic equivalence.
- "provable" means: identical structure, literals and types, every free identifier resolves to the same declaration, and the dependency already exists. It does not cover behavior that depends on module identity (instanceof across copies, module-level state reached indirectly).
- Module Federation configs are read statically from literal objects in *.config.* files; remotes built at runtime are not followed.
- Package roles are observed from imports between analyzed packages only.
- 0 file(s) had syntax errors; their facts may be partial.
- Similar code on edit and in find_equivalent: units with 60+ AST nodes are compared against the index with the same rule as "similar" groups (80% shared 5-token shingles after MinHash/LSH candidates, or 60% against units with the same name, half of the literal values in common, other packages only when the package is known). LSH can miss a pair of different names near the threshold (about 2% at exactly 80%).
- Scan reuse: a session start reuses the last scan when its signature matches (path, size and mtime of every analyzed file; content of package.json, tsconfig/jsconfig and ast-layer.*.json files; tool version and options) and no edit was recorded since. A change that keeps a file's size and mtime is only seen by an explicit scan. Incremental rebuilds reuse a file's parse only when its text is unchanged and give the same result as a full scan.
- No ast-layer.rules.json in any root: no architecture rules were checked.
- No recorded decisions (ast-layer.decisions.json).
- Styles and messages: 6 CSS/SCSS file(s) parsed with postcss/postcss-scss and 0 locale JSON file(s). Custom properties count when files in 2+ packages define 2+ of the same names with the same normalized values (a single shared property is usually an override; SCSS/Less variables are not read). Rule blocks need 4+ non-custom declarations, identical after normalizing order, whitespace and color case, in 2+ packages; reset/base selectors (only elements, *, :root), @keyframes steps and blocks whose values are all trivial (0, none, auto...) are skipped. Locale files of the same language in different packages are reported when they share 10+ identical key/value pairs covering 70% of the smaller file; the same text under a different key path (global.common.copied vs common.copied) does not count, and apps that share many messages inside large files of their own stay below the ratio. Identical rule blocks can be generic layout (a flex column with a gap) on unrelated selectors. Not seen: CSS-in-JS, utility classes (Tailwind), styles from node_modules; the post-edit hook checks JS/TS only.
- Local telemetry (stats): the hooks append to hook-log.jsonl in the plugin data dir and nothing is sent anywhere. A warned unit counts as "warning followed" when no unit with its name or code is in the file at its next edit (or on disk when stats runs; a deleted file counts as followed); a copy that was renamed and changed counts as followed.
- Verified fixes (propose_fix / fix) exist only for provable duplicate.reinvents-library-export and boundary.bypasses-package-entry findings. Verification compares syntactic and semantic diagnostics of the edited files and their direct importers before and after, in this tool's program (no lib files, external packages unresolved), and re-runs the analysis: it proves the change adds no error that program can see and removes the finding without creating another. A finding with the same anchor that only got smaller (no more locations; for module copies, no pair sharing more definitions) is not counted as new and is listed in shrunkFindings. It does not run the project's build or tests.
- Finding keys are built from what a finding is about (member files, names, packages, code hashes, specifiers), never from line numbers: moving code within a file keeps the key; editing the code, renaming the file or the package changes it.
- Every named package with source files has a public entry that resolves to analyzed source.

## Summary

| Class | Findings |
|---|---|
| provable | 2 |
| agent-guided | 17 |
| manual-review | 18 |

| Kind | Findings |
|---|---|
| `deps.version-drift` | 8 |
| `duplicate.cross-package` | 2 |
| `duplicate.module` | 3 |
| `duplicate.reinvents-library-export` | 5 |
| `duplicate.similar` | 8 |
| `duplicate.within-package` | 11 |

## Provable — mechanically certain, no judgment needed

### `duplicate.reinvents-library-export` · 5df7a1fff181

- **Key:** `a024e78a3ff3912d`
- **Where:** `web/apps/dashboard/components/logs/validation/utils/transform-structured-output-filter-format.ts:18:51`, `web/internal/ui/src/validation/utils/transform-structured-output-filter-format.ts:18:51`
- **Why:** `transformStructuredOutputToFilters` is identical (structure, literals, types, and the declarations its free identifiers resolve to) to `@unkey/ui#transformStructuredOutputToFilters`, which @unkey/dashboard already depends on.
- **Next action:** Delete the local definition and use `import { transformStructuredOutputToFilters } from "@unkey/ui"`; keep the local export names (transformStructuredOutputToFilters) by re-exporting from the library.

### `duplicate.reinvents-library-export` · 481b99dd124f

- **Key:** `3afd23a088f563f7`
- **Where:** `web/apps/dashboard/lib/utils.ts:5:1`, `web/internal/ui/src/lib/utils.ts:16:1`
- **Why:** `debounce` is identical (structure, literals, types, and the declarations its free identifiers resolve to) to `@unkey/ui#debounce`, which @unkey/dashboard already depends on.
- **Next action:** Delete the local definition and use `import { debounce } from "@unkey/ui"`; keep the local export names (debounce) by re-exporting from the library.

## Agent-guided — the site is certain, the replacement needs a check

### `duplicate.reinvents-library-export` · 9e16bd3d4793

- **Key:** `d9393385752fa728`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/apis/[apiId]/_overview/utils.ts:8:1`, `web/internal/ui/src/components/data-table/components/cells/outcome-popover-cell.tsx:9:1`
- **Why:** `formatOutcomeName` matches the public export `@unkey/ui#formatOutcomeName`, but the replacement is not mechanically certain: The library copy lives in a module marked "use client"; the local copy's module is not marked.
- **Next action:** Compare both copies at the listed differences. If they are equivalent for this caller, replace with `import { formatOutcomeName } from "@unkey/ui"`. Settle any doubt with the smallest focused test that exercises the differing values.
- **Stop if:** a differing literal encodes environment, timing, URLs, keys or business rules: that difference may be intentional.
- **Stop if:** a free identifier resolves to module state (a variable, cache or singleton) in this package.

### `duplicate.reinvents-library-export` · 64de76f06416

- **Key:** `5a1d163e0c2b03a3`
- **Where:** `web/internal/encoding/src/base64.ts:73:1`, `web/internal/hash/src/sha256.ts:109:1`
- **Why:** `encode` matches the public export `@unkey/hash#b64`, but the replacement is not mechanically certain: 1 free identifier(s) resolve to different declarations than in the library copy. @unkey/encoding does not declare a dependency on @unkey/hash.
- **Next action:** Compare both copies at the listed differences. If they are equivalent for this caller, replace with `import { b64 as encode } from "@unkey/hash"` and declare the dependency on @unkey/hash. Settle any doubt with the smallest focused test that exercises the differing values.
- **Stop if:** a differing literal encodes environment, timing, URLs, keys or business rules: that difference may be intentional.
- **Stop if:** a free identifier resolves to module state (a variable, cache or singleton) in this package.

### `duplicate.reinvents-library-export` · 88eec1c34dd3

- **Key:** `9695f757a61c00e6`
- **Where:** `web/internal/encoding/src/base64.ts:109:1`, `web/internal/hash/src/sha256.ts:145:1`
- **Why:** `decode` matches the public export `@unkey/hash#decodeBase64`, but the replacement is not mechanically certain: @unkey/encoding does not declare a dependency on @unkey/hash.
- **Next action:** Compare both copies at the listed differences. If they are equivalent for this caller, replace with `import { decodeBase64 as decode } from "@unkey/hash"` and declare the dependency on @unkey/hash. Settle any doubt with the smallest focused test that exercises the differing values.
- **Stop if:** a differing literal encodes environment, timing, URLs, keys or business rules: that difference may be intentional.
- **Stop if:** a free identifier resolves to module state (a variable, cache or singleton) in this package.

### `duplicate.similar` · 81d237f5b4b7

- **Key:** `9c8f8b84302fd381`
- **Where:** `web/apps/dashboard/components/virtual-table/components/loading-indicator.tsx:20:31`, `web/internal/ui/src/components/data-table/components/footer/load-more-footer.tsx:26:1`
- **Why:** 2 definitions across 2 packages share 66–66% of their structure but are not identical: statements were added, removed or written differently. One of them is a public export (@unkey/ui#LoadMoreFooter).
- **Next action:** Compare each copy with @unkey/ui#LoadMoreFooter. Where the differences do not matter for that caller, import the export; settle doubts with a focused test.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

### `duplicate.similar` · 5494b87495d9

- **Key:** `678cac5a89d8133b`
- **Where:** `web/apps/dashboard/lib/utils.ts:29:1`, `web/internal/ui/src/lib/utils.ts:41:1`
- **Why:** 2 definitions across 2 packages share 94–94% of their structure but are not identical: statements were added, removed or written differently. One of them is a public export (@unkey/ui#throttle).
- **Next action:** Compare each copy with @unkey/ui#throttle. Where the differences do not matter for that caller, import the export; settle doubts with a focused test.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

### `duplicate.similar` · fca8efbda921

- **Key:** `4a75a5842f39d89a`
- **Where:** `web/apps/dashboard/lib/utils.ts:130:35`, `web/internal/ui/src/lib/utils.ts:167:35`
- **Why:** 2 definitions across 2 packages share 84–84% of their structure but are not identical: statements were added, removed or written differently. One of them is a public export (@unkey/ui#processTimeFilters).
- **Next action:** Compare each copy with @unkey/ui#processTimeFilters. Where the differences do not matter for that caller, import the export; settle doubts with a focused test.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

### `duplicate.within-package` · e1d9a2fa376a

- **Key:** `69c7744257c72c1d`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/apis/[apiId]/_overview/components/controls/components/logs-filters/outcome-filter.tsx:10:31`, `web/apps/dashboard/app/(app)/[workspaceSlug]/apis/[apiId]/keys/[keyAuthId]/[keyId]/components/controls/components/logs-filters/outcome-filter.tsx:13:31`, `web/apps/dashboard/app/(app)/[workspaceSlug]/identities/[identityId]/components/controls/components/logs-filters/outcome-filter.tsx:13:31`
- **Why:** 3 structurally identical definitions (29 lines each) in different files of @unkey/dashboard.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · a490b2dbaa83

- **Key:** `891f222b8a216a9a`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/apis/[apiId]/_overview/components/controls/components/logs-refresh.tsx:5:28`, `web/apps/dashboard/app/(app)/[workspaceSlug]/apis/[apiId]/keys/[keyAuthId]/[keyId]/components/controls/components/logs-refresh.tsx:5:28`
- **Why:** 2 structurally identical definitions (13 lines each) in different files of @unkey/dashboard.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · f5dd126fe067

- **Key:** `661ec70226417bc2`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/apis/[apiId]/keys/[keyAuthId]/[keyId]/components/controls/components/logs-datetime/index.tsx:9:29`, `web/apps/dashboard/app/(app)/[workspaceSlug]/identities/[identityId]/components/controls/components/logs-datetime/index.tsx:9:29`
- **Why:** 2 structurally identical definitions (87 lines each) in different files of @unkey/dashboard.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 0fde22f3875e

- **Key:** `e77c23fdf3cb3445`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/audit/components/controls/components/logs-datetime/index.tsx:8:29`, `web/apps/dashboard/app/(app)/[workspaceSlug]/ratelimits/[namespaceId]/_overview/components/controls/components/logs-datetime/index.tsx:8:29`, `web/apps/dashboard/app/(app)/[workspaceSlug]/ratelimits/[namespaceId]/logs/components/controls/components/logs-datetime/index.tsx:8:29`
- **Why:** 3 structurally identical definitions (84 lines each) in different files of @unkey/dashboard.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 155d5f686da9

- **Key:** `7b6513dcb0872058`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/ratelimits/[namespaceId]/_overview/components/control-cloud/index.tsx:4:25`, `web/apps/dashboard/app/(app)/[workspaceSlug]/ratelimits/[namespaceId]/logs/components/control-cloud/index.tsx:4:25`
- **Why:** 2 structurally identical definitions (18 lines each) in different files of @unkey/dashboard.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 76d71481aa0d

- **Key:** `39a603681b0d6d67`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/ratelimits/[namespaceId]/_overview/components/controls/components/logs-filters/components/status-filter.tsx:29:29`, `web/apps/dashboard/app/(app)/[workspaceSlug]/ratelimits/[namespaceId]/logs/components/controls/components/logs-filters/components/status-filter.tsx:29:29`
- **Why:** 2 structurally identical definitions (21 lines each) in different files of @unkey/dashboard.
- **Next action:** The code is identical, but each copy uses its own module-level `statusOptions`. Consolidating means passing that in as a parameter or sharing it as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 44fc9aa929d9

- **Key:** `a13a548f0b72ba28`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/settings/billing/components/spend-budget-v2.tsx:22:1`, `web/apps/dashboard/app/(app)/[workspaceSlug]/settings/billing/components/spend-budget.tsx:26:1`
- **Why:** 2 structurally identical definitions (11 lines each) in different files of @unkey/dashboard.
- **Next action:** The code is identical, but each copy uses its own module-level `MAX_BUDGET_CENTS`. Consolidating means passing that in as a parameter or sharing it as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · dd0d46fdfe31

- **Key:** `7142d71d696c0a45`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/settings/logdrains/header-fields.ts:4:1`, `web/apps/dashboard/lib/trpc/routers/logdrain/validation.ts:25:1`
- **Why:** 2 structurally identical definitions (9 lines each) in different files of @unkey/dashboard.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 7dbe45cef7ee

- **Key:** `3f6f1d211983e4a5`
- **Where:** `web/apps/dashboard/lib/trpc/routers/authorization/permissions/llm-search/utils.ts:9:1`, `web/apps/dashboard/lib/trpc/routers/authorization/roles/llm-search/utils.ts:9:1`
- **Why:** 2 structurally identical definitions (70 lines each) in different files of @unkey/dashboard.
- **Next action:** The code is identical, but each copy uses its own module-level `getSystemPrompt`. Consolidating means passing that in as a parameter or sharing it as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 384531aba9cb

- **Key:** `6d41eed43a3bcb50`
- **Where:** `web/apps/dashboard/lib/trpc/routers/deploy/request-logs/llm-search/index.ts:13:26`, `web/apps/dashboard/lib/trpc/routers/deploy/runtime-logs/llm-search/index.ts:13:26`, `web/apps/dashboard/lib/trpc/routers/logs/llm-search/index.ts:13:26`
- **Why:** 3 structurally identical definitions (6 lines each) in different files of @unkey/dashboard.
- **Next action:** The code is identical, but each copy uses its own module-level `openai`. Consolidating means passing that in as a parameter or sharing it as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 73a14a57a39b

- **Key:** `7ff0657be2e6c767`
- **Where:** `web/apps/dashboard/lib/trpc/routers/ratelimit/query-latency-timeseries/utils.ts:10:1`, `web/apps/dashboard/lib/trpc/routers/ratelimit/query-timeseries/utils.ts:10:1`
- **Why:** 2 structurally identical definitions (27 lines each) in different files of @unkey/dashboard.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

## Manual review — depends on intent; a person decides

### `deps.version-drift` · 1630033e4451

- **Key:** `11c4093fb290d49e`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/apps/portal/package.json:1:1`, `web/internal/ui/package.json:1:1`
- **Why:** class-variance-authority is declared with 2 different ranges across 3 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · 81612d091305

- **Key:** `49cd0c9e958df2c2`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/apps/portal/package.json:1:1`, `web/internal/workos-widgets/package.json:1:1`
- **Why:** @tanstack/react-query is declared with 3 different ranges across 3 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · 83fd3c78e054

- **Key:** `4e085c538ac4442d`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/apps/design/package.json:1:1`, `web/apps/portal/package.json:1:1`, `web/internal/icons/package.json:1:1`, `web/internal/resend/package.json:1:1`, `web/internal/ui/package.json:1:1`, `web/internal/workos-widgets/package.json:1:1`
- **Why:** react is declared with 4 different ranges across 7 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · 93bf1f3cc034

- **Key:** `634e42d00ae5c44f`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/apps/portal/package.json:1:1`, `web/internal/ui/package.json:1:1`
- **Why:** react-hook-form is declared with 2 different ranges across 3 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · b4deeacf9da8

- **Key:** `419ffdd8a1c4208b`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/tools/migrate/package.json:1:1`
- **Why:** stripe is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · cbd7801acc2f

- **Key:** `aa228c886e71dc1e`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/internal/ui/package.json:1:1`
- **Why:** @tanstack/react-table is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · e3fc34ada73d

- **Key:** `72c2a97ac03dc553`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/internal/ui/package.json:1:1`
- **Why:** nuqs is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · ebb62334a588

- **Key:** `3387dd2f04617bac`
- **Where:** `web/apps/dashboard/package.json:1:1`, `web/apps/design/package.json:1:1`, `web/apps/portal/package.json:1:1`, `web/internal/resend/package.json:1:1`, `web/internal/ui/package.json:1:1`, `web/internal/workos-widgets/package.json:1:1`
- **Why:** react-dom is declared with 4 different ranges across 6 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `duplicate.cross-package` · 8264a33a09c3

- **Key:** `267f87f8cc55a9d4`
- **Where:** `web/apps/dashboard/components/logs/validation/utils/nuqs-parsers.ts:29:40`, `web/internal/ui/src/validation/utils/nuqs-parsers.ts:29:40`
- **Why:** 2 identical definitions (29+ lines) across 2 packages, and no copy is part of a library's public API.
- **Candidate home:** A copy already lives in @unkey/ui, which every other package with a copy already depends on; it is just not exported from the entry point.
- **Next action:** Decide whether @unkey/ui should expose this. If yes, export it from the entry point and rescan: the other copies will then be classified as replacements of a library export.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `duplicate.cross-package` · a7693d3ad8b9

- **Key:** `bdb32733a082297c`
- **Where:** `web/apps/dashboard/hooks/use-persisted-form.tsx:22:1`, `web/internal/ui/src/hooks/use-persisted-form.tsx:22:1`
- **Why:** 2 near-identical definitions (69+ lines) across 2 packages, and no copy is part of a library's public API.
- **Candidate home:** A copy already lives in @unkey/ui, which every other package with a copy already depends on; it is just not exported from the entry point.
- **Next action:** Decide whether @unkey/ui should expose this. If yes, export it from the entry point and rescan: the other copies will then be classified as replacements of a library export.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `duplicate.module` · ddb32a5d37b9

- **Key:** `05a1b08a5409b06d`
- **Where:** `web/apps/dashboard/app/(app)/[workspaceSlug]/logs/components/controls/components/logs-queries/utils.ts:1:1`, `web/apps/dashboard/app/(app)/[workspaceSlug]/ratelimits/[namespaceId]/logs/components/controls/components/logs-queries/utils.ts:1:1`
- **Why:** 2 files are copies of each other as modules: 3 of 4 top-level definitions match between utils.ts and utils.ts.
- **Next action:** Treat these as one module when deciding: share the whole file (one module everyone imports) or keep the copies, rather than deduplicating function by function.
- **Stop if:** the files belong to apps that must deploy and change independently.

### `duplicate.module` · 230e08fb16cd

- **Key:** `16ac9a7aa2af43f8`
- **Where:** `web/apps/dashboard/components/logs/validation/utils/nuqs-parsers.ts:1:1`, `web/internal/ui/src/validation/utils/nuqs-parsers.ts:1:1`
- **Why:** 2 files are copies of each other as modules: 3 of 3 top-level definitions match between nuqs-parsers.ts and nuqs-parsers.ts, across 2 packages.
- **Next action:** Treat these as one module when deciding: share the whole file (one module everyone imports) or keep the copies, rather than deduplicating function by function.
- **Stop if:** the files belong to apps that must deploy and change independently.

### `duplicate.module` · e0a7a51172fe

- **Key:** `a77140f8dcbe2751`
- **Where:** `web/internal/encoding/src/base64.ts:1:1`, `web/internal/hash/src/sha256.ts:1:1`
- **Why:** 2 files are copies of each other as modules: 3 of 4 top-level definitions match between base64.ts and sha256.ts, across 2 packages.
- **Next action:** Treat these as one module when deciding: share the whole file (one module everyone imports) or keep the copies, rather than deduplicating function by function.
- **Stop if:** the files belong to apps that must deploy and change independently.

### `duplicate.similar` · 9734376c2256

- **Key:** `7dfd6c3bbcede723`
- **Where:** `web/apps/dashboard/components/logs/validation/utils/nuqs-parsers.ts:67:33`, `web/internal/ui/src/validation/utils/nuqs-parsers.ts:67:33`
- **Why:** 2 definitions across 2 packages share 84–84% of their structure but are not identical: statements were added, removed or written differently.
- **Next action:** Compare the copies. If they are meant to behave the same, decide whether one shared version should exist; if the differences are intentional, leave them.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

### `duplicate.similar` · d82612b57ffb

- **Key:** `4de03f306b6c5358`
- **Where:** `web/apps/dashboard/components/logs/validation/utils/structured-output-schema-generator.ts:66:1`, `web/internal/ui/src/validation/utils/structured-output-schema-generator.ts:100:1`
- **Why:** 2 definitions across 2 packages share 97–97% of their structure but are not identical: statements were added, removed or written differently.
- **Next action:** Compare the copies. If they are meant to behave the same, decide whether one shared version should exist; if the differences are intentional, leave them.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

### `duplicate.similar` · a86624637d0a

- **Key:** `0adf3020516d0ac7`
- **Where:** `web/apps/dashboard/components/ui/chart.tsx:38:24`, `web/apps/portal/src/components/ui/chart.tsx:20:1`
- **Why:** 2 definitions across 2 packages share 72–72% of their structure but are not identical: statements were added, removed or written differently.
- **Next action:** Compare the copies. If they are meant to behave the same, decide whether one shared version should exist; if the differences are intentional, leave them.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

### `duplicate.similar` · 6bae20ebbd4d

- **Key:** `2b53851cf20a16ae`
- **Where:** `web/apps/dashboard/hooks/use-keyboard-shortcut.tsx:142:36`, `web/internal/ui/src/hooks/use-keyboard-shortcut.tsx:137:36`
- **Why:** 2 definitions across 2 packages share 85–85% of their structure but are not identical: statements were added, removed or written differently.
- **Next action:** Compare the copies. If they are meant to behave the same, decide whether one shared version should exist; if the differences are intentional, leave them.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

### `duplicate.similar` · 22355df27415

- **Key:** `07ce1163b887411f`
- **Where:** `web/apps/dashboard/hooks/use-keyboard-shortcut.tsx:226:1`, `web/internal/ui/src/hooks/use-keyboard-shortcut.tsx:221:1`
- **Why:** 2 definitions across 2 packages share 96–96% of their structure but are not identical: statements were added, removed or written differently.
- **Next action:** Compare the copies. If they are meant to behave the same, decide whether one shared version should exist; if the differences are intentional, leave them.
- **Stop if:** the differing statements encode app-specific rules (URLs, permissions, data shapes): similar is not equivalent.

## Observations (ledger, no action implied)

### Packages

| Package | Files | Role | Consumers |
|---|---|---|---|
| `unkey` | 0 | leaf | — |
| `@unkey/dashboard` | 1796 | leaf | — |
| `@unkey/design` | 33 | leaf | — |
| `@unkey/portal` | 74 | leaf | — |
| `@unkey/api` | 538 | library | `@unkey/dashboard`, `@unkey/portal` |
| `@unkey/billing` | 5 | leaf | — |
| `@unkey/clickhouse` | 32 | library | `@unkey/dashboard`, `@unkey/local`, `@unkey/migrate` |
| `@unkey/db` | 67 | library | `@unkey/dashboard`, `@unkey/portal`, `@unkey/local`, `@unkey/migrate` |
| `@unkey/encoding` | 3 | library | `@unkey/encryption` |
| `@unkey/encryption` | 4 | leaf | — |
| `@unkey/error` | 6 | library | `@unkey/dashboard`, `@unkey/billing`, `@unkey/clickhouse`, `@unkey/encryption`, `@unkey/rbac` |
| `@unkey/events` | 1 | leaf | — |
| `@unkey/hash` | 4 | library | `@unkey/dashboard`, `@unkey/portal`, `@unkey/keys` |
| `@unkey/icons` | 187 | library | `@unkey/dashboard`, `@unkey/design`, `@unkey/ui` |
| `@unkey/id` | 2 | library | `@unkey/dashboard`, `@unkey/db`, `@unkey/local`, `@unkey/migrate` |
| `@unkey/keys` | 5 | leaf | — |
| `@unkey/match` | 7 | library | `@unkey/dashboard` |
| `@unkey/rbac` | 8 | library | `@unkey/dashboard` |
| `@unkey/resend` | 16 | library | `@unkey/dashboard` |
| `@unkey/schema` | 2 | library | `@unkey/dashboard` |
| `@unkey/tsconfig` | 0 | leaf | — |
| `@unkey/ui` | 153 | library | `@unkey/dashboard`, `@unkey/design`, `@unkey/portal` |
| `@unkey/validation` | 1 | leaf | — |
| `@unkey/vault` | 1 | leaf | — |
| `@unkey/workos-widgets` | 1 | library | `@unkey/dashboard` |
| `@unkey/local` | 17 | leaf | — |
| `@unkey/migrate` | 18 | leaf | — |

### Package graph

| From | To | Import statements | Type-only | Bound references |
|---|---|---|---|---|
| `@unkey/dashboard` | `@unkey/api` | 84 | 59 | 189 |
| `@unkey/dashboard` | `@unkey/clickhouse` | 110 | 64 | 197 |
| `@unkey/dashboard` | `@unkey/db` | 32 | 4 | 554 |
| `@unkey/dashboard` | `@unkey/error` | 1 | 0 | 4 |
| `@unkey/dashboard` | `@unkey/hash` | 1 | 0 | 1 |
| `@unkey/dashboard` | `@unkey/icons` | 350 | 2 | 850 |
| `@unkey/dashboard` | `@unkey/id` | 10 | 0 | 33 |
| `@unkey/dashboard` | `@unkey/match` | 62 | 0 | 104 |
| `@unkey/dashboard` | `@unkey/rbac` | 4 | 1 | 8 |
| `@unkey/dashboard` | `@unkey/resend` | 2 | 0 | 2 |
| `@unkey/dashboard` | `@unkey/schema` | 5 | 1 | 6 |
| `@unkey/dashboard` | `@unkey/ui` | 719 | 25 | 2993 |
| `@unkey/dashboard` | `@unkey/workos-widgets` | 3 | 0 | 5 |
| `@unkey/design` | `@unkey/icons` | 9 | 0 | 19 |
| `@unkey/design` | `@unkey/ui` | 29 | 0 | 256 |
| `@unkey/portal` | `@unkey/api` | 3 | 1 | 1 |
| `@unkey/portal` | `@unkey/db` | 2 | 0 | 3 |
| `@unkey/portal` | `@unkey/hash` | 1 | 0 | 1 |
| `@unkey/portal` | `@unkey/ui` | 1 | 0 | 1 |
| `@unkey/billing` | `@unkey/error` | 2 | 0 | 15 |
| `@unkey/clickhouse` | `@unkey/error` | 8 | 1 | 39 |
| `@unkey/db` | `@unkey/id` | 1 | 0 | 1 |
| `@unkey/encryption` | `@unkey/encoding` | 2 | 0 | 6 |
| `@unkey/encryption` | `@unkey/error` | 1 | 0 | 5 |
| `@unkey/keys` | `@unkey/hash` | 1 | 0 | 1 |
| `@unkey/rbac` | `@unkey/error` | 1 | 0 | 14 |
| `@unkey/ui` | `@unkey/icons` | 39 | 1 | 68 |
| `@unkey/local` | `@unkey/clickhouse` | 1 | 0 | 1 |
| `@unkey/local` | `@unkey/db` | 4 | 0 | 52 |
| `@unkey/local` | `@unkey/id` | 1 | 0 | 2 |
| `@unkey/migrate` | `@unkey/clickhouse` | 2 | 0 | 2 |
| `@unkey/migrate` | `@unkey/db` | 13 | 0 | 49 |
| `@unkey/migrate` | `@unkey/id` | 3 | 0 | 4 |

### Public exports with no consumer in the analyzed group

- `@unkey/api`: 1428 export(s) — e.g. `@unkey/api/models/components#Action`, `@unkey/api/models/components#Action`, `@unkey/api/models/components#Action$inboundSchema`, `@unkey/api/models/components#Action$outboundSchema`, `@unkey/api/models/components#App`, `@unkey/api/models/components#App$inboundSchema`
- `@unkey/clickhouse`: 10 export(s) — e.g. `@unkey/clickhouse#activeKeysUsage`, `@unkey/clickhouse#ActiveKeysUsage`, `@unkey/clickhouse#ClickHouseConfig`, `@unkey/clickhouse#deployMeterUsage`, `@unkey/clickhouse#DeployMeterUsage`, `@unkey/clickhouse#DeployUsageTimeseriesGroup`
- `@unkey/db`: Not computed: another analyzed package re-exports this library with `export *`, so consumption cannot be attributed per symbol.
- `@unkey/error`: 6 export(s) — e.g. `@unkey/error#EnvError`, `@unkey/error#ErrorContext`, `@unkey/error#FetchError`, `@unkey/error#Ok`, `@unkey/error#Ok`, `@unkey/error#wrap`
- `@unkey/hash`: 2 export(s) — e.g. `@unkey/hash#b64`, `@unkey/hash#decodeBase64`
- `@unkey/icons`: 18 export(s) — e.g. `@unkey/icons#Discord`, `@unkey/icons#Docker`, `@unkey/icons#IconCircleDottedOutline12`, `@unkey/icons#IconClipboardCheckOutline18`, `@unkey/icons#IconClipboardOutline12`, `@unkey/icons#IconClipboardOutline18`
- `@unkey/match`: 2 export(s) — e.g. `@unkey/match#NonExhaustiveError`, `@unkey/match#PatternMatcher`
- `@unkey/rbac`: 29 export(s) — e.g. `@unkey/rbac#and`, `@unkey/rbac#apiActions`, `@unkey/rbac#appActions`, `@unkey/rbac#buildIdSchema`, `@unkey/rbac#buildQuery`, `@unkey/rbac#buildUnkeyQuery`
- `@unkey/ui`: 211 export(s) — e.g. `@unkey/ui#AlertDialogMedia`, `@unkey/ui#AlertDialogOverlay`, `@unkey/ui#AlertDialogTrigger`, `@unkey/ui#AssignedCountCellProps`, `@unkey/ui#BadgeCell`, `@unkey/ui#BadgeCellProps`

### Duplication scan

3171 of 5154 top-level units were large enough to fingerprint; 18 exact and 11 near clusters; 34 near groups rejected because their literals differ too much (e.g. icon sets).
