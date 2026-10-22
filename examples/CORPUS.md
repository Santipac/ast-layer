# Run on public code: dub and unkey

Public repositories, cloned at the same commits as the 0.4 baseline:

- `unkey/web` @ `7d0f002`: 2981 JS/TS files and 27 packages.
- `dub` @ `c43a4b3`: 4682 JS/TS files and 13 packages.

The machine is an Apple Silicon Mac with Node 24.

## Timings (1.0)

| | unkey/web | dub |
|---|---|---|
| Full scan (CLI, bundle) | 1.5 s (1.7 s wall) | 2.6 s (2.8 s wall) |
| SessionStart, first time (scan + note) | 1.76 s | 2.84 s |
| **SessionStart, second time with no changes** (same signature, the report is reused) | **0.18 s** | **0.21 s** |
| First full in-process analysis | 1541 ms | 2609 ms |
| **Incremental after editing 1 file** (`oldProgram` + SourceFile cache) | **942 ms** (2980 reused, 1 parsed) | **1634 ms** (4681 reused, 1 parsed) |
| Full after the same edit (warm) | 1290 ms | 2376 ms |
| Does the incremental run give the same `report.json` and `index.json` as the full one? | yes, byte for byte | yes, byte for byte |

- A second SessionStart on an unchanged repository takes under 1 s: 0.18 s and 0.21 s.
- **Incremental analysis saves 27–31%** against a warm full run. Parsing is only part of the cost; the checker and the analysis always run again, so that the result is identical.

## Findings by kind, 0.4 vs 1.0

Both bundles ran on the same tree.

| Kind | unkey 0.4 | unkey 1.0 | dub 0.4 | dub 1.0 |
|---|---|---|---|---|
| `boundary.bypasses-package-entry` | 0 | 0 | 1 | 1 |
| `deps.version-drift` | 8 | 8 | 10 | 10 |
| `duplicate.cross-package` | 2 | 2 | 1 | 1 |
| `duplicate.module` | 3 | 3 | 2 | 2 |
| `duplicate.reinvents-library-export` | 5 | 5 | 1 | 1 |
| `duplicate.similar` | 5 | 5 | 0 | 0 |
| `duplicate.within-package` | 11 | 11 | 26 | 26 |
| `architecture.rule-violation` | — | 0 (no rules.json) | — | 0 (no rules.json) |
| `css.duplicate-token` | — | 0 (1 before raising the threshold) | — | 0 |
| `css.duplicate-rule-block` | — | 0 | — | 0 |
| `i18n.duplicate-messages` | — | 0 | — | 0 |
| **Total** | 34 | 34 | 41 | 41 |

- **No regression:** the 0.x kinds give the same counts.
- **Classes unchanged:** unkey has 2 provable, 15 agent-guided and 17 manual-review; dub has 0 provable, 27 agent-guided and 14 manual-review.
- **Why there are no CSS or i18n findings:**
  - dub and unkey use Tailwind: they have 3 and 6 stylesheets;
  - neither has locale JSON: discovery found 0;
  - without `ast-layer.rules.json` there are no rules to break.

## Hand-reviewed sample: 11 new findings

"Similar on edit" was simulated by passing every file with large units through the same check the post-edit hook runs (`findEquivalents` with `similar`, excluding its own file and package), as if it had just been written. 1811 files of unkey and 3420 of dub were checked. There were 10 warnings in unkey (5 pairs, one per direction) and 0 in dub.

| # | Kind | Warning (when editing the first) | Verdict | Why |
|---|---|---|---|---|
| 1–2 | similar on edit | `parseAsSortArray`: `apps/dashboard/.../nuqs-parsers.ts:67` ↔ `internal/ui/src/validation/utils/nuqs-parsers.ts:67`, 0.85 | **real** | The same function copied into `@unkey/ui`, but it diverged: one returns `null` and the other `[]` in the empty case. Exactly what "compare before reusing" has to catch. |
| 3–4 | similar on edit | `validateFieldValue`: dashboard `structured-output-schema-generator.ts:66` ↔ ui `:100`, 0.97 | **real** | Identical except the default case: one ends in `return true`, the other in `return false`. A real behavior difference. |
| 5–6 | similar on edit | `parseShortcutString`: dashboard `hooks/use-keyboard-shortcut.tsx:142` ↔ ui `:137`, 0.82 | **real** | A refactored copy: the ui version uses key maps, with the same purpose and API. |
| 7–8 | similar on edit | `useKeyboardShortcut`: dashboard `:226` ↔ ui `:221`, 0.96 | **real** | The same hook in both packages; `useCallback` and a few details differ. |
| 9–10 | similar on edit | `throttle`: dashboard `lib/utils.ts:29` ↔ ui `lib/utils.ts:41`, 0.94 | **real** | A copy, with `unknown` types in one and `any` in the other. |
| 11 | `css.duplicate-token` | `--color-background: var(--color-gray-1)` in `@unkey/ui` (`internal/ui/theme.css:347`) and `@unkey/workos-widgets` (`styles.css:16`) | **noise** | An intentional override: the file explains in a comment that it redefines the token to neutralize Radix's inside `.dark`. |

**Noise by kind in the sample:**
- **Similar on edit:** 0 of 10. Unchanged.
- **`css.duplicate-token`:** 1 of 1, over 30%. **The threshold was raised:** a group now needs at least 2 shared custom properties (`cssMinSharedTokens: 2`), since a single shared property is usually an override. With the new threshold unkey gives 0, and the fixture still reports its 2-token group.
- **`css.duplicate-rule-block` and `i18n.duplicate-messages`:** no sample in these repositories, which use Tailwind and have no locale JSON. In a private group of micro-frontends, 7 of 8 `css.duplicate-rule-block` findings were real copies (the noise was a generic flex block in unrelated components), and the 0 for `i18n.duplicate-messages` was confirmed by hand.

**A gap the run found, now fixed:** Tailwind v4 tokens declared directly inside `@theme { … }` were not read. Every `--*` declaration is read now, and namespace resets such as `--text-*: initial` are skipped.

## How to reproduce

```bash
git clone https://github.com/unkeyed/unkey && git -C unkey checkout 7d0f002
git clone https://github.com/dubinc/dub && git -C dub checkout c43a4b3
npm run build
B=plugin/dist/ast-layer.cjs
node $B scan unkey/web --out out/web
node $B scan dub --out out/dub
```

- **Generated reports:** `examples/unkey.REPORT.md` and `examples/dub.REPORT.md`.
- **Measurement scripts:**
  - `node scripts/measure-incremental.mjs unkey/web unkey/web/apps/dashboard/lib/utils.ts` compares incremental with full analysis, and restores the file afterwards.
  - `node scripts/simulate-similar-on-edit.mjs out/web unkey/web` simulates "similar on edit".

## 1.1: changes on dub and unkey

| | unkey/web | dub |
|---|---|---|
| Scan 1.0 | 1.9 s | 3.2 s |
| Scan 1.1 | 1.6 s | 2.8 s |
| Findings 1.0 → 1.1 | 34 → 37 | 41 → 41 |
| `duplicate.similar` | 5 → 8 | 0 → 0 |

- **The 3 new unkey pairs are real copies:**
  - `processTimeFilters`, with one statement moved, found thanks to the single token for locals;
  - `LoadMoreFooter` and `ChartContainer`, found by the 60% same-name threshold.
- **The other kinds do not change.**
- **Why the general threshold was not lowered to 0.6:** dub would get pairs of SVG icons with different names (`InvoiceDollar`/`PenWriting`, `Lock`/`Photo`).
