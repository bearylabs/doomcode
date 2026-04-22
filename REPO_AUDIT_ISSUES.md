# Repository Audit Issue Backlog

Ranked backlog from full repository audit on 2026-04-22.

Use each section as GitHub issue draft.

## P0

### 1. Fix broken conditional behavior in custom which-key menu

- Priority: P0
- Severity: Critical
- Labels: bug, architecture, ux, whichkey
- Files: `src/whichkey/menu.ts`, `package.json`

#### Problem

Custom Doom which-key menu cannot evaluate several shipped conditional bindings correctly.

Current snapshot logic hardcodes these values instead of reading real workbench state:

- `activePanel`
- `activeViewlet`
- `explorerViewletVisible`
- `view.workbench.panel.chat.view.copilot.visible`
- `view.workbench.panel.markers.view.visible`

This means bindings like "Hide problems", "Hide sidebar", and "Hide panel" never resolve correctly in Doom menu mode.

#### Why it matters

- Core menu behavior differs from shipped manifest.
- Users get wrong commands in context-sensitive menus.
- Feature appears flaky even when configuration is correct.

#### Proposed fix

- Audit every conditional predicate used in `whichkey.bindings`.
- Support only predicates that Doom menu can resolve from actual VS Code state.
- For unsupported predicates, either:
  - fall back to VSpaceCode menu, or
  - pre-resolve menu items through a capability filter and hide unsupported conditional entries.
- Add tests for conditional resolution using real shipped binding examples.

#### Acceptance criteria

- Doom menu and manifest agree on conditional bindings for supported contexts.
- Bindings for explorer, terminal, debug, problems, selection, and multi-group states resolve correctly.
- Tests cover at least one binding per supported condition family.

---

### 2. Stop mutating user-global settings on first activation without explicit consent

- Priority: P0
- Severity: High
- Labels: bug, config, onboarding, breaking-behavior
- Files: `src/extension.ts`, `README.md`

#### Problem

Extension writes defaults into global user settings automatically on first activation.

Skip logic only checks `inspect(key).globalValue`, so other user-owned scopes can still be overridden by new global values.

#### Why it matters

- Extension changes global editor behavior without explicit opt-in.
- Behavior is surprising and hard to undo for users.
- README promise is broader than implementation.

#### Proposed fix

- Replace silent first-run write with explicit install command or first-run confirmation.
- Treat any existing user-defined scope as owned by user.
- Update README to match exact semantics.

#### Acceptance criteria

- Fresh install does not modify global settings until user opts in.
- Existing values in any inspected user-owned scope are not overwritten.
- README explains exact installation flow.
- Tests verify opt-in flow and non-overwrite behavior.

---

## P1

### 3. Rework workspace fuzzy search to avoid preloading entire workspace

- Priority: P1
- Severity: High
- Labels: perf, architecture, search
- Files: `src/search/fuzzy.ts`

#### Problem

Workspace search opens every file, reads full content, and builds in-memory line index before search narrows results.

#### Why it matters

- Poor scale in real repositories.
- High I/O, memory churn, and document-open overhead.
- Slower panel open on larger workspaces.

#### Proposed fix

- Switch to query-driven search instead of preload-driven search.
- Require minimum query length before workspace scan.
- Use VS Code text search APIs or external indexed search approach.
- Stream or batch results.
- Cap scanned files and surfaced matches with named constants.

#### Acceptance criteria

- Opening project search with empty query does not scan full workspace.
- Search starts only after query threshold or explicit action.
- Result loading remains responsive in medium and large workspaces.
- Tests cover result ordering and caps.

---

### 4. Remove synchronous filesystem calls from activation and hot paths

- Priority: P1
- Severity: High
- Labels: perf, cleanup, extension-host
- Files: `src/extension.ts`, `src/buffers/openEditors.ts`

#### Problem

Activation and cleanup use `readFileSync`, `writeFileSync`, and `accessSync`.

#### Why it matters

- Blocks extension host event loop.
- Adds latency to startup and interactive commands.
- Harder to compose safely with future async flows.

#### Proposed fix

- Replace sync Node fs calls with `vscode.workspace.fs` or `fs/promises`.
- Isolate cleanup work behind explicit command or background flow.
- Cache expensive readonly checks where possible.

#### Acceptance criteria

- No sync filesystem calls remain in activation, cleanup, or buffer render hot paths.
- Cleanup still preserves current behavior.
- Tests cover malformed keybindings file and cleanup rewrite behavior.

---

### 5. Expand test suite beyond activation smoke tests

- Priority: P1
- Severity: High
- Labels: test, quality, coverage
- Files: `src/test/extension.test.ts`, `src/**`

#### Problem

Current suite has 2 smoke tests and almost no coverage of real feature logic.

#### Why it matters

- High-risk behavior ships unguarded.
- Refactors will be slow and unsafe.
- Core regressions can pass CI.

#### Proposed fix

- Add unit tests for pure helpers first.
- Add focused integration tests for commands and panel logic.
- Cover cleanup, migration, fuzzy matching, conditional bindings, MRU, and open-editor behavior.

#### Acceptance criteria

- Tests exist for:
  - `fuzzyMatch`
  - conditional binding resolution
  - flattened which-key binding generation
  - stale settings cleanup
  - MRU window switching
  - open-editor dedupe and selection behavior
- CI runs all new tests reliably.

---

### 6. Eliminate DOM injection patterns from custom which-key webview

- Priority: P1
- Severity: Medium
- Labels: security, webview, hardening
- Files: `src/whichkey/menu.ts`

#### Problem

Menu render path uses `innerHTML` with strings derived from configured bindings.

#### Why it matters

- Lowered trust boundary in webview UI.
- Inconsistent with safer `textContent` pattern used elsewhere.
- Easier to introduce XSS-like rendering bugs later.

#### Proposed fix

- Build footer and button contents with DOM APIs only.
- Keep config-derived text in `textContent`.
- Add regression test for escaping or malformed labels.

#### Acceptance criteria

- No config-derived string is injected through `innerHTML`.
- Rendering behavior remains identical for normal bindings.

---

### 7. Upgrade vulnerable dev/test dependency chain

- Priority: P1
- Severity: Medium
- Labels: dependencies, security, ci
- Files: `package.json`, `package-lock.json`

#### Problem

`npm audit` reports 4 vulnerabilities in dev/test dependencies, including 2 high severity issues through `@vscode/test-cli` -> `mocha` -> `serialize-javascript` and `diff`.

#### Why it matters

- Supply-chain debt in CI and local dev.
- High-severity advisory left unresolved.
- Audit noise hides future real issues.

#### Proposed fix

- Upgrade `@vscode/test-cli` and transitive test stack to patched versions.
- Use overrides if upstream lag blocks direct upgrade.
- Re-run audit in CI or as periodic maintenance step.

#### Acceptance criteria

- `npm audit` shows no high severity issues in current lockfile.
- Test command still passes in CI and local env.

---

## P2



### 9. Split extension lifecycle/config migration code into focused modules

- Priority: P2
- Severity: Medium
- Labels: refactor, architecture, maintainability
- Files: `src/extension.ts`

#### Problem

`extension.ts` owns activation, install defaults, conflict detection, stale cleanup, migration, and command registration.

#### Why it matters

- Too many responsibilities in one file.
- Hard to test or change safely.
- Encourages regressions during feature work.

#### Proposed fix

- Extract modules for:
  - install/defaults
  - conflict detection and cleanup
  - migration
  - command registration / activation wiring

#### Acceptance criteria

- `extension.ts` becomes thin composition root.
- Extracted modules have focused tests.
- No behavior change.

---

### 10. Extract shared webview/panel infrastructure

- Priority: P2
- Severity: Medium
- Labels: refactor, ui, maintainability
- Files: `src/search/fuzzy.ts`, `src/buffers/openEditors.ts`, `src/whichkey/bindingsPanel.ts`, `src/whichkey/menu.ts`

#### Problem

Panel implementations duplicate webview setup, CSP generation, message wiring, navigation handling, and render loop patterns.

#### Why it matters

- Same bug can exist in multiple places.
- Fixes are inconsistent.
- Harder to add new panels safely.

#### Proposed fix

- Extract shared webview controller utilities.
- Standardize message protocol and keyboard handling.
- Reuse safe DOM helper utilities.

#### Acceptance criteria

- Shared setup code removed from panel implementations.
- Common keyboard behavior defined once.
- Security hardening applies consistently across panels.

---

### 11. Tighten TypeScript and ESLint safety gates

- Priority: P2
- Severity: Medium
- Labels: tooling, types, lint
- Files: `tsconfig.json`, `eslint.config.mjs`

#### Problem

Static checks are too weak for long-term maintenance.

#### Why it matters

- Dead code and correctness issues can slip through.
- Async errors and unused params stay invisible.

#### Proposed fix

- Enable:
  - `noImplicitReturns`
  - `noFallthroughCasesInSwitch`
  - `noUnusedParameters`
- Add lint rules for:
  - no floating promises
  - unused vars
  - explicit unsafe `any` cases if needed

#### Acceptance criteria

- CI fails on newly introduced unused params, missing returns, and unhandled async calls.
- Existing surfaced violations are cleaned or consciously suppressed.

---

## P3

### 12. Revisit unconditional startup activation

- Priority: P3
- Severity: Low
- Labels: perf, startup
- Files: `package.json`

#### Problem

Extension activates on every VS Code startup via `onStartupFinished`.

#### Why it matters

- Always-on cost compounds startup work.
- Less room for future features without startup regressions.

#### Proposed fix

- Move to lazy activation on commands/views where possible.
- Keep minimal activation only if required for migration flow.

#### Acceptance criteria

- Activation path is justified and documented.
- Startup work is minimized and measured.

---

### 13. Clean up minor style drift and stale direct dev dependencies

- Priority: P3
- Severity: Low
- Labels: cleanup, tooling
- Files: `src/whichkey/showBindings.ts`, `package.json`

#### Problem

- Minor indentation drift exists in `showBindings.ts`.
- `@vscode/test-electron` looks unused and may be stale.

#### Why it matters

- Small issues add noise.
- Unused deps increase lockfile and audit surface.

#### Proposed fix

- Fix formatting drift.
- Verify whether `@vscode/test-electron` is required by current test flow. Remove if not needed.

#### Acceptance criteria

- Formatting clean.
- Dev dependency list matches actual usage.
