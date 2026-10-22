# ast-layer report

Roots: `shell`, `dashboard`, `order`, `profile`, `sales` · 85 files · 5 packages · 4 findings

Every finding below is an observation with an exact location. Its class says whether acting on it is mechanical, needs a focused check, or needs a human decision.

## Limits (printed on every run)

- Every record is an observation about the code, not a verdict. A run with no findings is not a readiness or quality result.
- Only JavaScript/TypeScript is analyzed (no other source languages were seen).
- Excluded from analysis: nothing.
- External packages are never resolved, by design (results do not depend on node_modules). 14 distinct external packages were imported.
- 18 relative import(s) and 0 workspace-package import(s) did not resolve to an analyzed file; bindings through them are unknown.
- 0 dynamic import()/require() call(s) with non-literal specifiers were not followed.
- Duplication: top-level functions, components and classes with at least 40 AST nodes and 5 lines, excluding tests and stories. Normalization ignores formatting and comments and renames locally-bound identifiers; free identifiers keep their names. "near" also abstracts literals and types and is only reported when at most 5 literal positions differ and the differing characters are at most 24 or 25% of all literal characters. Structural similarity is not semantic equivalence.
- "provable" means: identical structure, literals and types, every free identifier resolves to the same declaration, and the dependency already exists. It does not cover behavior that depends on module identity (instanceof across copies, module-level state reached indirectly).
- Module Federation configs are read statically from literal objects in *.config.* files; remotes built at runtime are not followed.
- Package roles are observed from imports between analyzed packages only.
- 0 file(s) had syntax errors; their facts may be partial.

## Summary

| Class | Findings |
|---|---|
| provable | 0 |
| agent-guided | 1 |
| manual-review | 3 |

| Kind | Findings |
|---|---|
| `deps.version-drift` | 1 |
| `duplicate.cross-package` | 2 |
| `duplicate.within-package` | 1 |

## Agent-guided — the site is certain, the replacement needs a check

### `duplicate.within-package` · 4c5c1674d3ea

- **Where:** `profile/src/assets/jss/material-dashboard-react/components/headerLinksStyle.js:5:26`, `profile/src/assets/jss/material-dashboard-react/components/rtlHeaderLinksStyle.js:5:26`
- **Why:** 2 structurally identical definitions (103 lines each) in different files of shared-routing_profile.
- **Next action:** Keep one definition and import it from the others. Prefer the copy that is already exported and referenced elsewhere.
- **Stop if:** the copies are intentionally independent (e.g. generated files, separate deploy targets).
- **Stop if:** a copy is referenced by code you cannot see (scripts, other repos).

## Manual review — depends on intent; a person decides

### `deps.version-drift` · 2a9bb9378792

- **Where:** `dashboard/package.json:1:1`, `order/package.json:1:1`, `profile/package.json:1:1`, `sales/package.json:1:1`, `shell/package.json:1:1`
- **Why:** react-router is declared with 2 different ranges across 5 packages.
- **Next action:** Decide on one range (or a catalog entry) for this dependency.
- **Stop if:** packages deploy independently and are meant to upgrade on their own schedule.

### `duplicate.cross-package` · 4876b4d4a459

- **Where:** `dashboard/src/App.js:13:19`, `order/src/App.js:13:19`, `profile/src/App.js:13:19`, `sales/src/App.js:13:19`
- **Why:** 4 identical definitions (16+ lines) across 4 packages, and no copy is part of a library's public API.
- **Candidate home:** No analyzed library is already a dependency of every package with a copy; extracting would add a new dependency edge. Through Module Federation, every package with a copy already consumes shell (shared-routing_shell); exposing it there is the other option.
- **Next action:** Decide whether this logic should be shared. If yes, move one copy into the candidate home, export it from the entry point, and rescan; this tool will then classify each replacement.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `duplicate.cross-package` · c805e62566a9

- **Where:** `dashboard/src/App.js:30:1`, `order/src/App.js:30:1`, `profile/src/App.js:30:1`, `sales/src/App.js:30:1`
- **Why:** 4 identical definitions (9+ lines) across 4 packages, and no copy is part of a library's public API.
- **Candidate home:** No analyzed library is already a dependency of every package with a copy; extracting would add a new dependency edge. Through Module Federation, every package with a copy already consumes shell (shared-routing_shell); exposing it there is the other option.
- **Next action:** Decide whether this logic should be shared. If yes, move one copy into the candidate home, export it from the entry point, and rescan; this tool will then classify each replacement.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

## Observations (ledger, no action implied)

### Packages

| Package | Files | Role | Consumers |
|---|---|---|---|
| `shared-routing_dashboard` | 5 | leaf | — |
| `shared-routing_core` | 6 | leaf | — |
| `shared-routing_profile` | 60 | leaf | — |
| `shared-routing_sales` | 5 | leaf | — |
| `shared-routing_shell` | 9 | leaf | — |

### Module Federation

- `dashboard` (shared-routing_dashboard, dashboard/webpack.config.js:53) exposes `./DashboardService`; remotes `order`, `sales`, `shell`, `dashboard`; shared `@material-ui/core`, `react`, `react-dom`
- `order` (shared-routing_core, order/webpack.config.js:52) exposes `./OrderService`, `./RecentOrdersWidget`; remotes `shell`; shared `@material-ui/core`, `react`, `react-dom`
- `profile` (shared-routing_profile, profile/webpack.config.js:57) exposes `./ProfilePage`; remotes `shell`; shared `@material-ui/core`, `react`, `react-dom`
- `sales` (shared-routing_sales, sales/webpack.config.js:50) exposes `./DepositsWidget`, `./TodayWidget`; remotes `shell`; shared `@material-ui/core`, `react`, `react-dom`
- `shell` (shared-routing_shell, shell/webpack.config.js:52) exposes `./Service`, `./Shell`; remotes `order`, `dashboard`, `profile`, `shell`; shared `./src/Service`
- Federated imports matched to an expose: 13. Remotes outside the analyzed group: 0.

### Duplication scan

66 of 96 top-level units were large enough to fingerprint; 3 exact and 0 near clusters; 0 near groups rejected because their literals differ too much (e.g. icon sets).
