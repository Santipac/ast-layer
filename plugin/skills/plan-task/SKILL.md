---
description: Plan a feature, fix or refactor in a JS/TS repo with sibling apps, micro-frontends or shared packages before writing code — finds what already exists (library exports, copies in other apps), what the target package already depends on, and which findings touch the area. Use for "add/build/implement X" requests in such repos.
argument-hint: "[task description]"
---

# Plan a task with the AST layer

Task: $ARGUMENTS

Produce a short implementation plan grounded in facts from the `ast-layer` tools. Do not write code yet.

1. **Fresh facts.** The session-start note already holds a scan of the project, the architecture rules and which findings the user already decided. If the tools are deferred, load them with `ToolSearch` (query `ast-layer`). Call `scan` only if the code changed since, or with every repo in `roots` if the task spans several repos.
2. **Locate the target.** From the task, identify the package or app that will change. Call `package_graph` and note which libraries that package already depends on, and which are libraries for other packages too.
3. **Search before building.** List the units the task needs (functions, hooks, components, utilities). For each one, call `search_names` with its likely name and with two or three concept words. `find_equivalent` only catches structural copies, so use it only on code you already have.
4. **Read nearby findings and past decisions.**
   - Call `findings` filtered by `package` or `file` for the areas the task touches, and open the relevant ones with `finding`.
   - Findings with `status: "decided"` were already settled by the user: do not propose them again. If `previousDecision.outdated` is true, mention that the decision no longer applies.
   - If the session has Engram tools (`mem_search`), search `ast-layer/decision` plus the names involved for decisions recorded in earlier sessions.
   - Check the architecture rules in the session note (`ast-layer.rules.json`) before planning any new import across packages.
5. **Choose, per unit, one option, citing the fact behind it:**
   - **Reuse:** a public export already does it, and the target package already depends on that library. Give the exact import line.
   - **Expose an existing copy:** a copy already lives in a library the target depends on, but it is not exported. Exposing it is an API decision for the user.
   - **Extract:** the same code exists in several apps and there is no library copy. Extraction is the user's decision. Present the candidate home from the finding's evidence; a candidate home is a dependency fact, not a judgment.
   - **Implement new:** nothing equivalent exists. Say whether it belongs in the app or in a library the app already depends on, and why.
6. **Fixes and PRs.** If a provable finding is in the way, `propose_fix` gives a verified diff; it is part of the plan only if `verified: true`. When the task ends in a PR, plan to run `pr_findings` before opening it.
7. **Output.** For each unit, give the option, the evidence (finding id or `find_equivalent` result with `file:line`), and the risks: stop conditions, limits, and any manual-review decisions the user must make before work starts. Keep facts and judgment visibly separate.
