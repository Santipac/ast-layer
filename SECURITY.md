# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting ("Report a vulnerability" in the repository's Security tab), not a public issue. Include the version (`plugin/.claude-plugin/plugin.json`), how to reproduce it and its impact.

## Threat model

The plugin runs on your machine, with your permissions, inside Claude Code, and it analyzes repositories that may not be yours. Everything that comes from the analyzed repository is treated as untrusted data: the code, `package.json`, `tsconfig`, `ast-layer.rules.json` and `ast-layer.decisions.json`.

- **The analysis does not write to disk:** writes are blocked at runtime by `src/guard.js`, and a static test checks it. Writes go only through `src/writer.js`:
  - the output directory, which never replaces a folder that is not a previous report;
  - `ast-layer.decisions.json`, only when a decision is recorded on request;
  - a temporary directory for PR mode, removed afterwards.
- **No code from the project is executed, its `node_modules` is not loaded, and there is no network access.**
- **Processes are started with `execFile`/`spawn`, with argument arrays and no shell.** Git refs given to PR mode are refused when they start with `-`, and are resolved to a SHA before use.
- **Globs in `ast-layer.rules.json` are matched without regular expressions,** so a hostile pattern cannot hang the analysis. The schema caps their size.
- **A symlink in the repository that points outside the root is not read.**
- **Known limit:** tool responses include text from the analyzed repository (names, paths, rule messages). A hostile repository may try to place instructions there, as in any file the agent reads.
