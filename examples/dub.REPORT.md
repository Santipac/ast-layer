# ast-layer report

Roots: `dub` · 4682 files · 13 packages · 41 findings

Every finding below is an observation with an exact location. Its class says whether acting on it is mechanical, needs a focused check, or needs a human decision.

## Limits (printed on every run)

- Every record is an observation about the code, not a verdict. A run with no findings is not a readiness or quality result.
- Only JavaScript/TypeScript is analyzed (no other source languages were seen).
- Excluded from analysis: 5 × declaration file (.d.ts).
- External packages are never resolved, by design (results do not depend on node_modules). 191 distinct external packages were imported.
- 18 relative import(s) and 0 workspace-package import(s) did not resolve to an analyzed file; bindings through them are unknown.
- 0 dynamic import()/require() call(s) with non-literal specifiers were not followed.
- Duplication: top-level functions, components and classes with at least 40 AST nodes and 5 lines, excluding tests and stories. Normalization ignores formatting and comments and renames locally-bound identifiers; free identifiers keep their names. "near" also abstracts literals and types and is only reported when at most 5 literal positions differ and the differing characters are at most 24 or 25% of all literal characters. "similar" groups (cross-package only) need 60+ AST nodes and 80% shared structure (5-token shingles over the "near" stream with every local as one token, MinHash candidates), or 60% when both definitions have the same name (framework names such as GET, default or Page excluded; compared directly, without MinHash), plus at least half of their literal values in common. A copy that was renamed and rewritten below 80% is not seen. Module copies need 3+ matching top-level definitions covering 75% of the larger file. Structural similarity is not semantic equivalence.
- "provable" means: identical structure, literals and types, every free identifier resolves to the same declaration, and the dependency already exists. It does not cover behavior that depends on module identity (instanceof across copies, module-level state reached indirectly).
- Module Federation configs are read statically from literal objects in *.config.* files; remotes built at runtime are not followed.
- Package roles are observed from imports between analyzed packages only.
- 0 file(s) had syntax errors; their facts may be partial.
- Similar code on edit and in find_equivalent: units with 60+ AST nodes are compared against the index with the same rule as "similar" groups (80% shared 5-token shingles after MinHash/LSH candidates, or 60% against units with the same name, half of the literal values in common, other packages only when the package is known). LSH can miss a pair of different names near the threshold (about 2% at exactly 80%).
- Scan reuse: a session start reuses the last scan when its signature matches (path, size and mtime of every analyzed file; content of package.json, tsconfig/jsconfig and ast-layer.*.json files; tool version and options) and no edit was recorded since. A change that keeps a file's size and mtime is only seen by an explicit scan. Incremental rebuilds reuse a file's parse only when its text is unchanged and give the same result as a full scan.
- No ast-layer.rules.json in any root: no architecture rules were checked.
- No recorded decisions (ast-layer.decisions.json).
- Styles and messages: 3 CSS/SCSS file(s) parsed with postcss/postcss-scss and 0 locale JSON file(s). Custom properties count when files in 2+ packages define 2+ of the same names with the same normalized values (a single shared property is usually an override; SCSS/Less variables are not read). Rule blocks need 4+ non-custom declarations, identical after normalizing order, whitespace and color case, in 2+ packages; reset/base selectors (only elements, *, :root), @keyframes steps and blocks whose values are all trivial (0, none, auto...) are skipped. Locale files of the same language in different packages are reported when they share 10+ identical key/value pairs covering 70% of the smaller file; the same text under a different key path (global.common.copied vs common.copied) does not count, and apps that share many messages inside large files of their own stay below the ratio. Identical rule blocks can be generic layout (a flex column with a gap) on unrelated selectors. Not seen: CSS-in-JS, utility classes (Tailwind), styles from node_modules; the post-edit hook checks JS/TS only.
- Local telemetry (stats): the hooks append to hook-log.jsonl in the plugin data dir and nothing is sent anywhere. A warned unit counts as "warning followed" when no unit with its name or code is in the file at its next edit (or on disk when stats runs; a deleted file counts as followed); a copy that was renamed and changed counts as followed.
- Verified fixes (propose_fix / fix) exist only for provable duplicate.reinvents-library-export and boundary.bypasses-package-entry findings. Verification compares syntactic and semantic diagnostics of the edited files and their direct importers before and after, in this tool's program (no lib files, external packages unresolved), and re-runs the analysis: it proves the change adds no error that program can see and removes the finding without creating another. A finding with the same anchor that only got smaller (no more locations; for module copies, no pair sharing more definitions) is not counted as new and is listed in shrunkFindings. It does not run the project's build or tests.
- Finding keys are built from what a finding is about (member files, names, packages, code hashes, specifiers), never from line numbers: moving code within a file keeps the key; editing the code, renaming the file or the package changes it.
- Blind spot: 1 named package(s) have no public entry that resolves to analyzed source, so copies of their exports cannot be detected and imports of them are not bound: @dub/tailwind-config (its "main" points to "index.ts").

## Summary

| Class | Findings |
|---|---|
| provable | 0 |
| agent-guided | 27 |
| manual-review | 14 |

| Kind | Findings |
|---|---|
| `boundary.bypasses-package-entry` | 1 |
| `deps.version-drift` | 10 |
| `duplicate.cross-package` | 1 |
| `duplicate.module` | 2 |
| `duplicate.reinvents-library-export` | 1 |
| `duplicate.within-package` | 26 |

## Agent-guided — the site is certain, the replacement needs a check

### `duplicate.reinvents-library-export` · 68ae335c6470

- **Key:** `4a12135848406f8b`
- **Where:** `dub/apps/web/app/api/og/program/route.tsx:196:1`, `dub/packages/ui/src/icons/nucleo/invoice-dollar.tsx:3:1`
- **Why:** `InvoiceDollar` matches the public export `@dub/ui#InvoiceDollar`, but the replacement is not mechanically certain: Importing "@dub/ui" would load its entry module graph (479 modules), which has 1 side-effect import(s), e.g. "./styles.css" at dub/packages/ui/src/index.tsx:2; this file does not load that entry today.
- **Next action:** Compare both copies at the listed differences. If they are equivalent for this caller, replace with `import { InvoiceDollar } from "@dub/ui"`. Settle any doubt with the smallest focused test that exercises the differing values.
- **Stop if:** a differing literal encodes environment, timing, URLs, keys or business rules: that difference may be intentional.
- **Stop if:** a free identifier resolves to module state (a variable, cache or singleton) in this package.

### `duplicate.within-package` · 2ac5d13473b7

- **Key:** `b724a361c53a6d14`
- **Where:** `dub/apps/web/app/(ee)/api/partners/count/route.ts:8:1`, `dub/apps/web/app/(ee)/api/partners/route.ts:19:1`
- **Why:** 2 structurally identical definitions (16 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · ab62ff228619

- **Key:** `27b65197b577da56`
- **Where:** `dub/apps/web/app/(ee)/partners.dub.co/(auth-other)/forgot-password/page.tsx:4:1`, `dub/apps/web/app/app.dub.co/(auth)/forgot-password/page.tsx:9:1`
- **Why:** 2 structurally identical definitions (15 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 47e8278224ee

- **Key:** `cd22b275a330f982`
- **Where:** `dub/apps/web/app/(ee)/partners.dub.co/(dashboard)/profile/members/page-client.tsx:420:1`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/settings/members/page.tsx:578:1`
- **Why:** 2 structurally identical definitions (26 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · be7b838253c7

- **Key:** `b3d6bf25c37bc3af`
- **Where:** `dub/apps/web/app/(ee)/partners.dub.co/(dashboard)/programs/[programSlug]/invite/program-invite-confetti.tsx:6:38`, `dub/apps/web/app/app.dub.co/(invites)/[slug]/invite/invite-confetti.tsx:6:31`
- **Why:** 2 structurally identical definitions (18 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 04d019c7544b

- **Key:** `72dbd7507073ba0e`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/links/customers/[customerId]/earnings/page.tsx:16:1`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/customers/[customerId]/earnings/page-client.tsx:16:1`
- **Why:** 2 structurally identical definitions (47 lines each) in different files of web.
- **Next action:** The code is identical, but each copy uses its own module-level `PartnerEarningsTable`. Consolidating means passing that in as a parameter or sharing it as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 88aa5cca0b56

- **Key:** `423d86a99b90bec1`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/links/customers/[customerId]/earnings/page.tsx:64:30`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/customers/[customerId]/earnings/page-client.tsx:64:30`
- **Why:** 2 structurally identical definitions (37 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 9cd3f8ebd851

- **Key:** `34dbd80875e94e33`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/links/customers/[customerId]/sales/page-client.tsx:13:1`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/customers/[customerId]/sales/page-client.tsx:13:1`
- **Why:** 2 structurally identical definitions (20 lines each) in different files of web.
- **Next action:** The code is identical, but each copy uses its own module-level `SalesTable`. Consolidating means passing that in as a parameter or sharing it as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · efc9687f00cd

- **Key:** `bbbab96207e762db`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/links/customers/[customerId]/sales/page-client.tsx:34:20`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/customers/[customerId]/sales/page-client.tsx:34:20`
- **Why:** 2 structurally identical definitions (34 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 3992dac5abd4

- **Key:** `34264ae63e774fad`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/bounties/[bountyId]/bounty-submission-row-menu.tsx:105:1`, `dub/apps/web/ui/partners/commission-row-menu.tsx:77:1`, `dub/apps/web/ui/partners/payout-row-menu.tsx:88:1`
- **Why:** 3 structurally identical definitions (26 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 7b88604936d4

- **Key:** `05884afdf9aea0df`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/bounties/[bountyId]/use-bounty-submission-filters.tsx:167:1`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/payouts/use-payout-filters.tsx:150:1`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/risks/use-fraud-group-filters.tsx:120:1`, `dub/apps/web/ui/customers/customers-table/use-customer-filters.tsx:206:1`, `dub/apps/web/ui/submitted-leads/use-program-submitted-lead-filters.tsx:175:1`
- **Why:** 5 structurally identical definitions (34 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 6c2eef9ff5f0

- **Key:** `ff872230ae902d72`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/groups/[groupSlug]/discounts/group-discounts.tsx:198:26`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/groups/[groupSlug]/rewards/page.tsx:401:24`
- **Why:** 2 structurally identical definitions (11 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · ed08742e2664

- **Key:** `b4e28c2d804fbaba`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/partners-graphic.tsx:48:1`, `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/program-empty-state.tsx:91:1`
- **Why:** 2 structurally identical definitions (52 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 3de92ae3a0c3

- **Key:** `412b3af80f799c57`
- **Where:** `dub/apps/web/app/app.dub.co/(dashboard)/[slug]/(ee)/program/partners/use-partner-filters.tsx:43:1`, `dub/apps/web/lib/program-applications/hooks/use-program-applications-filters.tsx:34:1`
- **Why:** 2 structurally identical definitions (10 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 3af40fb56b42

- **Key:** `643f8b59d9c4826d`
- **Where:** `dub/apps/web/lib/analytics/get-customer-events.ts:86:21`, `dub/apps/web/lib/analytics/get-events.ts:262:21`
- **Why:** 2 structurally identical definitions (17 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 7d41d3332201

- **Key:** `45ce141fb607c51c`
- **Where:** `dub/apps/web/lib/postback/postback-adapters.ts:71:1`, `dub/apps/web/lib/webhook/qstash.ts:163:1`
- **Why:** 2 structurally identical definitions (9 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · f71d8d4f5c49

- **Key:** `71b2ab7a9874bcae`
- **Where:** `dub/apps/web/lib/qr/index.tsx:161:1`, `dub/apps/web/lib/qr/utils.tsx:343:1`
- **Why:** 2 structurally identical definitions (20 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 79edf435826c

- **Key:** `35d65530c8d12b34`
- **Where:** `dub/apps/web/lib/qr/index.tsx:182:1`, `dub/apps/web/lib/qr/utils.tsx:365:1`
- **Why:** 2 structurally identical definitions (8 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 8ca142dbd2c0

- **Key:** `82ad3b1f895d2d06`
- **Where:** `dub/apps/web/scripts/tinybird/delete-lead-event.ts:21:20`, `dub/apps/web/scripts/tinybird/delete-links.ts:25:20`, `dub/apps/web/scripts/tinybird/delete-sale-event.ts:78:20`
- **Why:** 3 structurally identical definitions (19 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 2f63759bf687

- **Key:** `3cee8d4adfc0423d`
- **Where:** `dub/apps/web/ui/layout/page-content/toggle-side-panel-button.tsx:4:1`, `dub/apps/web/ui/messages/toggle-side-panel-button.tsx:4:1`
- **Why:** 2 structurally identical definitions (63 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 41a3a7ca68e5

- **Key:** `7ce7f755e037b2ee`
- **Where:** `dub/apps/web/ui/modals/link-builder/ab-testing-modal.tsx:535:1`, `dub/apps/web/ui/modals/link-builder/ab-testing/ab-testing-modal.tsx:642:1`
- **Why:** 2 structurally identical definitions (27 lines each) in different files of web.
- **Next action:** The code is identical, but each copy uses its own module-level `ABTestingButton`, `ABTestingModal`. Consolidating means passing those in as a parameter or sharing them as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · d74360d13270

- **Key:** `9d1fca81c3f04d17`
- **Where:** `dub/apps/web/ui/modals/link-builder/ab-testing-modal.tsx:563:1`, `dub/apps/web/ui/modals/link-builder/ab-testing/traffic-split-slider.tsx:5:1`
- **Why:** 2 structurally identical definitions (108 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 8e1bd82b5bb2

- **Key:** `9f850acdab9879d5`
- **Where:** `dub/apps/web/ui/modals/plan-change-confirmation-modal.tsx:26:1`, `dub/apps/web/ui/modals/switch-trial-plan-modal.tsx:30:1`
- **Why:** 2 structurally identical definitions (41 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · 4b0e6b01b672

- **Key:** `ca19f0816a1637b4`
- **Where:** `dub/apps/web/ui/partners/groups/design/previews/application-preview.tsx:405:1`, `dub/apps/web/ui/partners/groups/design/previews/lander-preview.tsx:389:1`
- **Why:** 2 structurally identical definitions (70 lines each) in different files of web.
- **Next action:** The code is identical, but each copy uses its own module-level `EditToolbarTooltip`. Consolidating means passing that in as a parameter or sharing it as well; deleting all but one copy would change behavior.
- **Stop if:** the per-file values differ on purpose (e.g. a logger named after its page); compare them before consolidating.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · e03bdf88afe8

- **Key:** `33be9aabeae27674`
- **Where:** `dub/apps/web/ui/partners/groups/design/previews/application-preview.tsx:476:1`, `dub/apps/web/ui/partners/groups/design/previews/lander-preview.tsx:460:1`
- **Why:** 2 structurally identical definitions (15 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · ebe70fb30d48

- **Key:** `33357d7f5329bb2e`
- **Where:** `dub/apps/web/ui/partners/groups/reward-discount-partners-card.tsx:209:1`, `dub/apps/web/ui/partners/rewards/reward-preview-card.tsx:166:1`
- **Why:** 2 structurally identical definitions (47 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

### `duplicate.within-package` · d9d7f73613cc

- **Key:** `2d27d27a115eefc2`
- **Where:** `dub/apps/web/ui/partners/rewards/add-edit-reward-sheet.tsx:1176:1`, `dub/apps/web/ui/partners/rewards/partner-referral-reward-builder.tsx:239:1`
- **Why:** 2 structurally identical definitions (42 lines each) in different files of web.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

## Manual review — depends on intent; a person decides

### `boundary.bypasses-package-entry` · c44f48ca58a2

- **Key:** `63447c6dc3cca92e`
- **Where:** `dub/packages/email/src/templates/links-limit.tsx:15:1`
- **Why:** @dub/email imports "../../../../apps/web/lib/types" (relative path into another package), reaching into web without going through its public entry.
- **Next action:** web has no resolvable public entry; decide whether it should expose this module.
- **Stop if:** the internal module is intentionally private to the library.

### `deps.version-drift` · 1d09603dabc9

- **Key:** `7f3c2a50d3275bc9`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/email/package.json:1:1`, `dub/packages/embeds/react/package.json:1:1`, `dub/packages/stripe-app/package.json:1:1`, `dub/packages/ui/package.json:1:1`, `dub/packages/utils/package.json:1:1`
- **Why:** react is declared with 2 different ranges across 6 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · 5137c3f598c1

- **Key:** `fae81cfdcf842936`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/stripe-app/package.json:1:1`
- **Why:** stripe is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · 61edd747f45e

- **Key:** `af339397b665d06d`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/cli/package.json:1:1`, `dub/packages/utils/package.json:1:1`
- **Why:** nanoid is declared with 2 different ranges across 3 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · 96cff3f43979

- **Key:** `b3f01c299aa86270`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/ui/package.json:1:1`
- **Why:** sonner is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · 9aa8d269037c

- **Key:** `3bbc4f55c6a44339`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/email/package.json:1:1`, `dub/packages/embeds/react/package.json:1:1`, `dub/packages/stripe-app/package.json:1:1`, `dub/packages/ui/package.json:1:1`, `dub/packages/utils/package.json:1:1`
- **Why:** react-dom is declared with 2 different ranges across 6 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · a20bada369f4

- **Key:** `36ebae78a7d693bd`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/ui/package.json:1:1`
- **Why:** use-debounce is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · b78ef26ae945

- **Key:** `d629440adf74a4ee`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/cli/package.json:1:1`
- **Why:** dub is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · c80474c4572c

- **Key:** `22781986acb713eb`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/ui/package.json:1:1`
- **Why:** linkify-react is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · d8a699df4030

- **Key:** `bf1b61deb1774779`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/cli/package.json:1:1`
- **Why:** zod is declared with 2 different ranges across 2 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `deps.version-drift` · fc004fbc1335

- **Key:** `2e5b646167980d73`
- **Where:** `dub/apps/web/package.json:1:1`, `dub/packages/ui/package.json:1:1`, `dub/packages/utils/package.json:1:1`
- **Why:** next is declared with 2 different ranges across 3 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `duplicate.cross-package` · c0a3fcc4c57f

- **Key:** `fd2020e2df44eac4`
- **Where:** `dub/apps/web/lib/api/partners/program-enrollment-query.ts:70:1`, `dub/packages/ui/src/filter/filter-range-panel.tsx:18:1`
- **Why:** 2 near-identical definitions (12+ lines) across 2 packages, and no copy is part of a library's public API.
- **Candidate home:** A copy already lives in @dub/ui, which every other package with a copy already depends on; it is just not exported from the entry point.
- **Next action:** Decide whether @dub/ui should expose this. If yes, export it from the entry point and rescan: the other copies will then be classified as replacements of a library export.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `duplicate.module` · 0db7d70b8b7d

- **Key:** `ffa3cf9520034c98`
- **Where:** `dub/apps/web/app/[domain]/banned/page.tsx:1:1`, `dub/apps/web/app/[domain]/disabled/page.tsx:1:1`
- **Why:** 2 files are copies of each other as modules: 3 of 3 top-level definitions match between page.tsx and page.tsx.
- **Next action:** Treat these as one module when deciding: share the whole file (one module everyone imports) or keep the copies, rather than deduplicating function by function.
- **Stop if:** the files belong to apps that must deploy and change independently.

### `duplicate.module` · 471572468a8a

- **Key:** `bd7cdd9c717cbff0`
- **Where:** `dub/apps/web/ui/partners/groups/design/previews/application-preview.tsx:1:1`, `dub/apps/web/ui/partners/groups/design/previews/lander-preview.tsx:1:1`
- **Why:** 2 files are copies of each other as modules: 5 of 6 top-level definitions match between application-preview.tsx and lander-preview.tsx.
- **Next action:** Treat these as one module when deciding: share the whole file (one module everyone imports) or keep the copies, rather than deduplicating function by function.
- **Stop if:** the files belong to apps that must deploy and change independently.

## Observations (ledger, no action implied)

### Packages

| Package | Files | Role | Consumers |
|---|---|---|---|
| `dub-monorepo` | 2 | leaf | — |
| `deepsec-workspace` | 1 | leaf | — |
| `web` | 3920 | library | `@dub/email` |
| `dub-cli` | 18 | leaf | — |
| `@dub/email` | 128 | library | `web` |
| `@dub/embed-core` | 7 | library | `@dub/embed-react` |
| `@dub/embed-react` | 7 | library | `web` |
| `dub-hubspot-app` | 0 | leaf | — |
| `com.example.dub` | 9 | leaf | — |
| `@dub/tailwind-config` | 1 | library | `web`, `@dub/embed-react`, `@dub/ui` |
| `tsconfig` | 0 | leaf | — |
| `@dub/ui` | 499 | library | `web` |
| `@dub/utils` | 90 | library | `web`, `@dub/email`, `@dub/ui` |

### Package graph

| From | To | Import statements | Type-only | Bound references |
|---|---|---|---|---|
| `web` | `@dub/email` | 279 | 9 | 297 |
| `web` | `@dub/embed-react` | 1 | 0 | 1 |
| `web` | `@dub/tailwind-config` | 1 | 0 | 4 |
| `web` | `@dub/ui` | 1331 | 8 | 6017 |
| `web` | `@dub/utils` | 1701 | 2 | 5242 |
| `@dub/email` | `web` | 1 | 1 | 1 |
| `@dub/email` | `@dub/utils` | 120 | 0 | 265 |
| `@dub/embed-react` | `@dub/embed-core` | 1 | 0 | 5 |
| `@dub/embed-react` | `@dub/tailwind-config` | 1 | 0 | 1 |
| `@dub/ui` | `@dub/tailwind-config` | 1 | 0 | 1 |
| `@dub/ui` | `@dub/utils` | 117 | 1 | 340 |

### Public exports with no consumer in the analyzed group

- `@dub/email`: 1 export(s) — e.g. `@dub/email/send-via-nodemailer#sendViaNodeMailer`
- `@dub/embed-core`: 4 export(s) — e.g. `@dub/embed-core#DUB_CONTAINER_ID`, `@dub/embed-core#DubEmbed`, `@dub/embed-core#DubInitResult`, `@dub/embed-core#IframeMessage`
- `@dub/ui`: 130 export(s) — e.g. `@dub/ui/charts#ChartTooltipContext`, `@dub/ui/charts#ChartTooltipSyncContext`, `@dub/ui/charts#useChartContext`, `@dub/ui/charts#useChartTooltipContext`, `@dub/ui/charts#XAxisProps`, `@dub/ui/charts#YAxisProps`
- `@dub/utils`: 14 export(s) — e.g. `@dub/utils#ccTLDs`, `@dub/utils#COUNTRY_PHONE_CODES`, `@dub/utils#generateDomainFromName`, `@dub/utils#getLastDayOfMonth`, `@dub/utils#getSearchParamsWithArray`, `@dub/utils#getUTMParamsFromURL`

### Duplication scan

5706 of 7019 top-level units were large enough to fingerprint; 27 exact and 11 near clusters; 54 near groups rejected because their literals differ too much (e.g. icon sets).
