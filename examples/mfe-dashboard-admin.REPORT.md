# ast-layer report

Roots: `root`, `sidebar`, `dashboard-app`, `faq-app`, `team-app` · 35 files · 5 packages · 5 findings

Every finding below is an observation with an exact location. Its class says whether acting on it is mechanical, needs a focused check, or needs a human decision.

## Limits (printed on every run)

- Every record is an observation about the code, not a verdict. A run with no findings is not a readiness or quality result.
- Only JavaScript/TypeScript is analyzed (no other source languages were seen).
- Excluded from analysis: 1 × larger than 400000 bytes.
- External packages are never resolved, by design (results do not depend on node_modules). 17 distinct external packages were imported.
- 12 relative import(s) and 0 workspace-package import(s) did not resolve to an analyzed file; bindings through them are unknown.
- 0 dynamic import()/require() call(s) with non-literal specifiers were not followed.
- Duplication: top-level functions, components and classes with at least 40 AST nodes and 5 lines, excluding tests and stories. Normalization ignores formatting and comments and renames locally-bound identifiers; free identifiers keep their names. "near" also abstracts literals and types and is only reported when at most 5 literal positions differ and the differing characters are at most 24 or 25% of all literal characters. Structural similarity is not semantic equivalence.
- "provable" means: identical structure, literals and types, every free identifier resolves to the same declaration, and the dependency already exists. It does not cover behavior that depends on module identity (instanceof across copies, module-level state reached indirectly).
- Module Federation configs are read statically from literal objects in *.config.* files; remotes built at runtime are not followed.
- Package roles are observed from imports between analyzed packages only. Package name collisions (first wins): header-app [dashboard-app:., faq-app:.].
- 0 file(s) had syntax errors; their facts may be partial.

## Summary

| Class | Findings |
|---|---|
| provable | 0 |
| agent-guided | 0 |
| manual-review | 5 |

| Kind | Findings |
|---|---|
| `duplicate.cross-package` | 4 |
| `packages.duplicate-name` | 1 |

## Manual review — depends on intent; a person decides

### `duplicate.cross-package` · 714a6ba0a914

- **Where:** `dashboard-app/src/components/Header.jsx:5:16`, `team-app/src/components/Header.jsx:5:16`
- **Why:** 2 identical definitions (15+ lines) across 2 packages, and no copy is part of a library's public API.
- **Candidate home:** No analyzed library is already a dependency of every package with a copy; extracting would add a new dependency edge. No federation container is consumed by every package with a copy either.
- **Next action:** Decide whether this logic should be shared. If yes, move one copy into the candidate home, export it from the entry point, and rescan; this tool will then classify each replacement.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `duplicate.cross-package` · 2d18d72bb673

- **Where:** `dashboard-app/src/theme.js:5:23`, `faq-app/src/theme.js:5:23`, `sidebar/src/theme.js:6:23`, `team-app/src/theme.js:6:23`
- **Why:** 4 identical definitions (117+ lines) across 4 packages, and no copy is part of a library's public API.
- **Candidate home:** No analyzed library is already a dependency of every package with a copy; extracting would add a new dependency edge. No federation container is consumed by every package with a copy either.
- **Next action:** Decide whether this logic should be shared. If yes, move one copy into the candidate home, export it from the entry point, and rescan; this tool will then classify each replacement.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `duplicate.cross-package` · a6a512bd5a5e

- **Where:** `dashboard-app/src/theme.js:124:30`, `faq-app/src/theme.js:124:30`, `sidebar/src/theme.js:125:30`, `team-app/src/theme.js:125:30`
- **Why:** 4 identical definitions (71+ lines) across 4 packages, and no copy is part of a library's public API.
- **Candidate home:** No analyzed library is already a dependency of every package with a copy; extracting would add a new dependency edge. No federation container is consumed by every package with a copy either.
- **Next action:** Decide whether this logic should be shared. If yes, move one copy into the candidate home, export it from the entry point, and rescan; this tool will then classify each replacement.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `duplicate.cross-package` · 97d92d104eb1

- **Where:** `dashboard-app/src/theme.js:201:24`, `faq-app/src/theme.js:201:24`, `sidebar/src/theme.js:202:24`, `team-app/src/theme.js:202:24`
- **Why:** 4 near-identical definitions (13+ lines) across 4 packages, and no copy is part of a library's public API.
- **Candidate home:** No analyzed library is already a dependency of every package with a copy; extracting would add a new dependency edge. No federation container is consumed by every package with a copy either.
- **Differing literals:** "dark" vs "light"; "dark" vs "light"; "dark" vs "light"
- **Next action:** Decide whether this logic should be shared. If yes, move one copy into the candidate home, export it from the entry point, and rescan; this tool will then classify each replacement.
- **Stop if:** Similar structure is not proof of the same intent; copies owned by different teams or release cycles may be duplicated on purpose.

### `packages.duplicate-name` · 367d3945967c

- **Where:** `dashboard-app/package.json:1:1`, `faq-app/package.json:1:1`
- **Why:** 2 packages declare the same name "header-app". Imports by that name resolve to only one of them (dashboard-app:.), and publishing or workspace tooling will conflict.
- **Next action:** Give each package a unique name (often a copy-paste leftover).
- **Stop if:** these are intentionally alternative implementations selected at build time.

## Observations (ledger, no action implied)

### Packages

| Package | Files | Role | Consumers |
|---|---|---|---|
| `header-app` | 13 | leaf | — |
| `header-app` | 6 | leaf | — |
| `mfe-shell-container` | 3 | leaf | — |
| `mfe-left-nav` | 7 | leaf | — |
| `r` | 6 | leaf | — |

### Module Federation

- `Dashboard` (header-app (dashboard-app:.), dashboard-app/webpack.config.js:52) exposes `./Dashboard`; remotes none; shared `@emotion/react`, `@mui/icons-material`, `@mui/material`, `react`, `react-dom`, `react-router-dom`
- `FAQ` (header-app (faq-app:.), faq-app/webpack.config.js:51) exposes `./FAQ`; remotes `Sidebar`, `Dashboard`; shared `@emotion/react`, `@mui/icons-material`, `@mui/material`, `react`, `react-dom`, `react-router-dom`
- `Nav` (mfe-left-nav, sidebar/webpack.config.js:57) exposes `./Nav`; remotes `Dashboard`, `FAQ`; shared `@emotion/react`, `@mui/icons-material`, `@mui/material`, `react`, `react-dom`, `react-router-dom`
- `shell` (mfe-shell-container, root/webpack.config.js:84) exposes nothing; remotes `Nav`, `Dashboard`, `FAQ`, `Team`; shared `@emotion/react`, `@mui/icons-material`, `@mui/material`, `react`, `react-dom`, `react-router-dom`
- `team` (r, team-app/rspack.config.js:60) exposes `./team`; remotes none; shared `@emotion/react`, `@mui/icons-material`, `@mui/material`, `react`, `react-dom`
- Federated imports matched to an expose: 6. Remotes outside the analyzed group: 0.

### Duplication scan

30 of 37 top-level units were large enough to fingerprint; 3 exact and 1 near clusters; 0 near groups rejected because their literals differ too much (e.g. icon sets).
