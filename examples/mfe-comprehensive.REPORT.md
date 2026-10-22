# ast-layer report

Roots: `app-01`, `app-02`, `app-03`, `app-04`, `app-05` · 34 files · 5 packages · 0 findings

Every finding below is an observation with an exact location. Its class says whether acting on it is mechanical, needs a focused check, or needs a human decision.

## Limits (printed on every run)

- Every record is an observation about the code, not a verdict. A run with no findings is not a readiness or quality result.
- Only JavaScript/TypeScript is analyzed (skipped: 1 .svelte).
- Excluded from analysis: 1 × excluded directory.
- External packages are never resolved, by design (results do not depend on node_modules). 16 distinct external packages were imported.
- 10 relative import(s) and 0 workspace-package import(s) did not resolve to an analyzed file; bindings through them are unknown.
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
| agent-guided | 0 |
| manual-review | 0 |

| Kind | Findings |
|---|---|

## Observations (ledger, no action implied)

### Packages

| Package | Files | Role | Consumers |
|---|---|---|---|
| `comprehensive-demo-react18_app-01` | 13 | leaf | — |
| `comprehensive-demo-react18_app-02` | 7 | leaf | — |
| `comprehensive-demo-react18_app-03` | 5 | leaf | — |
| `comprehensive-demo-react18_app-04` | 4 | leaf | — |
| `comprehensive-demo-react18_app-05` | 5 | leaf | — |

### Module Federation

- `app_01` (comprehensive-demo-react18_app-01, app-01/rspack.config.js:71) exposes `./Page`, `./SideNav`; remotes `app_02`, `app_03`, `app_04`, `app_05`; shared `@material-ui/core`, `react`, `react-dom`, `react-router-dom`
- `app_02` (comprehensive-demo-react18_app-02, app-02/rspack.config.js:66) exposes `./Dialog`, `./Tabs`; remotes `app_01`, `app_03`; shared `@material-ui/core`, `react`, `react-dom`, `react-router-dom`
- `app_03` (comprehensive-demo-react18_app-03, app-03/rspack.config.js:65) exposes `./Button`; remotes `app_01`; shared `react`, `react-dom`
- `app_04` (comprehensive-demo-react18_app-04, app-04/rspack.config.js:54) exposes `./App`, `./loadApp`; remotes none; shared none
- `app_05` (comprehensive-demo-react18_app-05, app-05/rspack.config.js:78) exposes `./ActionButton`, `./AlertBox`, `./components`; remotes none; shared none
- Federated imports matched to an expose: 8. Remotes outside the analyzed group: 0.

### Duplication scan

19 of 35 top-level units were large enough to fingerprint; 0 exact and 0 near clusters; 0 near groups rejected because their literals differ too much (e.g. icon sets).
