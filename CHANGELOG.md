# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.3.6] - 2026-04-27

### Fixed

- `SPC SPC` on SSH workspaces now actually respects `.gitignore` — `vscodevim.vim` (`extensionKind: ["ui"]` only) was listed as an `extensionDependency`, which prevented Doom from installing on the remote extension host; Doom fell back to running locally where `git ls-files` cannot reach the remote filesystem and silently fell through to `findFiles` (no `.gitignore` support). Moving vim to `extensionPack` lets Doom install on the SSH remote where git runs correctly.

### Changed

- `SPC p p` and `SPC p f` no longer show a file picker after selecting a project — the project opens directly. Extensions must load before any action can run, making the two-step pick-project-then-pick-file flow too slow to be useful
- `vscodevim.vim` moved from `extensionDependencies` to `extensionPack` — it is a recommended companion, not a hard requirement for Doom to function

> **SSH users:** After updating, open your SSH remote in VS Code and run **Developer: Restart Extension Host** (`Ctrl+Shift+P`). If `SPC SPC` still shows gitignored files, Doom is still running locally — uninstall and reinstall it while connected to the SSH remote so VS Code places the extension on the remote host.

## [0.3.5] - 2026-04-27

### Fixed

- `SPC SPC` on WSL workspaces now respects `.gitignore` — previously all files including ignored ones were listed; now uses `wsl.exe -d <distro> -- git ls-files` so git runs inside the distro and honours the remote `.gitignore`
- `SPC SPC` on SSH workspaces: removed early-exit guard that skipped `git ls-files` entirely for SSH URIs and fell back to `findFiles`; `git ls-files` now runs on the remote host via `extensionKind: workspace` (note: full fix required v0.3.6)

## [0.3.4] - 2026-04-27

### Added

- `SPC p p` recent project picker now shows a `[host]` indicator in the permissions column for remote projects (WSL distro name or SSH hostname), replacing the unreadable Linux-style permissions that can't be retrieved for remote paths
- `SPC p p` skips the cross-project file picker for remote projects (WSL/SSH) — VS Code isn't connected to the host yet at that point, so files can't be listed; selecting a remote project now opens the folder directly

### Fixed

- `SPC SPC` and `SPC .` now work correctly when connected to a WSL (or other remote) workspace — previously no files or folders were shown in the results
- `SPC SPC` and `SPC .` show `----------` / `0` for permissions and size on SSH remotes — `fs.stat` over SSH is too slow; local and WSL connections show real values
- `SPC SPC` on SSH remotes uses VS Code's `findFiles` (ripgrep) instead of `git ls-files` — respects `.gitignore` natively and avoids the latency of git over the network
- `SPC p p` remote project entries show `----------` / `0` for permissions and size instead of blank columns
- Extension `extensionKind` changed to `["workspace", "ui"]` so the installed extension migrates to the remote host when opening a WSL/SSH workspace

## [0.3.3] - 2026-04-26

### Added

- `SPC p p` cross-project file picker now ranks results by frecency — shares the same selection history as `SPC SPC` and `SPC .`

## [0.3.2] - 2026-04-26

### Added

- `SPC q` which-key group (`+quit/session`) now includes: `F` Clear current frame, `q` Quit VSCode, `r` Reload VSCode
- `SPC SPC` and `SPC .` file pickers now rank results by frecency (frequency × recency) — files you open often and recently surface first, matching Doom Emacs prescient.el behaviour
- Selection history persists across restarts and is shared across workspaces (global, like prescient.el)
- Files opened by any method (click, git, external tools) passively seed the history via `onDidOpenTextDocument`; explicit picker selections additionally boost the frecency count

### Changed

- Which-key menus sorted alphabetically (case-insensitive, lowercase before uppercase): `b`, `d`, `e`, `f`, `f→i`, `g`, `o→u`
- `SPC SPC` non-open-tab files previously sorted alphabetically; now ordered by frecency score with modification time as fallback

## [0.3.1] - 2026-04-26

### Added

- `whichkey.bindingOverrides` now respected in the doom which-key UI — use `position: -1` to remove a binding, a positive index to insert at a specific position, or omit `position` to append

### Fixed

- `SPC o p` no longer opens the explorer without focus when the sidebar was previously closed with `q`
- First key of a chord no longer dropped when the which-key panel reattaches to an existing webview

### Changed

- Terminal sticky scroll disabled by default

## [0.3.0] - 2026-04-25

### Added

- `SPC .` / `SPC f f` — new directory browser panel, mirrors Doom Emacs `find-file`; starts in the current file's directory (falls back to project root, then `$HOME`); lists files and subdirectories; typing filters by name within the current directory; Tab completes the active item into the path; backspacing past a `/` removes the whole directory component for rapid upward traversal
- `SPC SPC` / `SPC p f` — new "find file in project" panel, Doom Emacs-style file picker
- Orderless AND matching in file and project pickers — space-separate terms to filter by multiple words in any order
- File picker shows last modified time alongside each file
- Buffer switcher shows file size and accent extension badge
- Opening a project now chains directly into the file picker; editor layout resets on project open
- Paths under home directory collapse to `~` across all panels
- Relative time labels in file pickers expanded with clock time appended

### Changed

- `SPC SPC` reuses an existing editor tab when opening a file instead of always opening a new one

### Fixed

- `.gitignore` respected in project file picker
- `.gitignore` respected in `SPC SPC` file search (uses `git ls-files`)
- Which-key panel now restores the terminal tab after closing instead of collapsing the panel, when `SPC o t` had opened the terminal beforehand

## [0.2.8] - 2026-04-24

### Fixed

- Dashboard "Install now" button now refreshes the page after install, hiding the prompt once everything is applied

### Added

- Dashboard now shows a prompt when Doom keybindings are missing from your user `keybindings.json`
- Install now writes Doom's keybindings into your user `keybindings.json` so magit dispatch displays the correct key hints — existing content and comments are preserved

### Changed

- `SPC g s` changed from "Status" (opens SCM panel) to "Stage hunk at point" (`git.stageSelectedRanges`)
- Magit: remap shift keybinds to literal symbols

## [0.2.7] - 2026-04-23

### Added

- Which-key menu closes when focus moves to an editor, terminal, or any other panel
- Git whichkey: `SPC g [` jump to previous hunk, `SPC g ]` jump to next hunk
- Default scrollbar hidden (`editor.scrollbar.vertical/horizontal: hidden`)
- SCM diff decorations default to gutter only (`scm.diffDecorations: gutter`)

## [0.2.6] - 2026-04-23

### Added

- Magit (`kahole.magit`) added to extension pack
- Git keybindings: `SPC g g` status, `SPC g /` dispatch, `SPC g b` checkout, `SPC g B` blame
- `magit.display-buffer-function` defaults to `same-column`
- Magit buffer keybindings: `g g` top, `g r` refresh, `x` discard, `-` reverse, `_` reverting, `O` resetting

### Changed

- `SPC o a c` now opens Codex CLI in a terminal editor instead of the ChatGPT sidebar
- `SPC s s` and `SPC s p` fuzzy search results now display in file order (by line number) instead of by match score

## [0.2.5] - 2026-04-23

### Added

- Which-key buffers keys pressed before the menu finishes rendering

### Fixed

- Space no longer triggers which-key when Claude or GitHub Copilot chat is open in editor view

### Changed

- Workspace search performance improvements

## [0.2.4] - 2026-04-23

### Changed

- Startup page renamed to dashboard

### Fixed

- Which-key menu can now be opened from settings and keyboard UI pages

## [0.2.3] - 2026-04-23

### Added

- `SPC o a a` keybinding to open Claude chat

### Changed

- GitHub Copilot chat keybinding moved to `SPC o a g`
- Removed Gemini keybinding from `SPC o a g`

### Fixed

- Buffer switcher now previews the first item on open
- GitHub Copilot which-key triggers work correctly

## [0.2.2] - 2026-04-22

### Fixed

- Which-key alternative trigger works correctly when Claude chat window is open
- Buffer switcher works correctly for terminal editors

## [0.2.1] - 2026-04-22

### Fixed

- Terminal window deletion no longer causes errors when closing the last terminal
- Toggle explorer keybinding restored to correct behavior
- Terminal toggle keybinding restored to correct behavior
- Claude chat which-key entry behaves correctly in Doom menu

### Changed

- Doom which-key menu reverted to use original which-key conditions for better compatibility

## [0.2.0] - 2026-04-22

### Added

- `doom.whichKey.menuStyle` setting to choose Doom Code's custom which-key panel or the default VSpaceCode menu
- `SPC h b` to search available which-key bindings by key, name, or command
- Startup page now opens on activation with manual install/cleanup actions, repository links, and embedded changelog

### Changed

- Doom Code now ships its own panel-based UI for which-key, project search, and workspace buffer switching
- Added top-level shortcuts `SPC /` for project search and `SPC ,` for workspace buffer switching
- Buffer switching now better matches Doom Emacs, with clear buffer flags
- Built-in fuzzy search now replaces the external `fuzzy-search` extension for Doom Code search flows
- Install defaults no longer apply silently on first activation; setup is explicit opt-in only

### Fixed

- Improved leader-key handling inside Doom Code menus so `SPC`, `Ctrl+K`, and `Escape` behave more consistently
- `doom.cleanup` now operates on the active VS Code profile's keybindings, not just the default profile
- Install defaults now respect existing values from any user-owned configuration scope before writing globals

## [0.1.2] - 2026-04-20

### Changed

- Aligned the `SPC w` window menu to better replicate Doom Emacs window behavior
- Todo Highlight and fuzzy-search now install as bundled companion extensions instead of hard requirements

### Fixed

- Improved WSL and remote-window activation so Doom Code no longer fails when required UI extensions are unavailable in the remote extension host

## [0.1.1] - 2026-04-19

### Changed

- Adjusted the `SPC b` buffer menu to better replicate Doom Emacs buffer behavior
- Refreshed README keybinding highlights and release notes so documentation matches shipped bindings more closely

## [0.1.0] - 2026-04-19

### Added

- Added `SPC t b` as a "big mode" toggle that zooms the workbench in and resets back to normal on repeat
- Added [Todo Highlight](https://marketplace.visualstudio.com/items?itemName=wayou.vscode-todo-highlight) as a hard dependency for `TODO:`, `FIXME:`, `NOTE:`, `REVIEW:`, and `HACK:` annotations

### Changed

- Added default Todo Highlight styling and overview ruler colors for supported annotation keywords
- Remapped `Ctrl+=` and `Ctrl+-` to editor font zoom in/out while editor focus is active
- Removed the duplicate word-wrap toggle entry from the which-key menu

### Fixed

- Added `Escape` support to close the Problems panel and Debug Console panel

## [0.0.5] - 2026-04-17

### Changed

- Aligned local TypeScript tooling by setting explicit `node16` module resolution, declaring Node/VS Code/Mocha types
- Added integrated terminal keybindings so `Ctrl+C` copies when text is selected and `Ctrl+V` pastes while terminal focus is active
- Added `SPC t w` as a toggle for soft line wrapping in the current editor
- Added `SPC f Y` to copy the active file path relative to the project root

### Fixed

- Restored `whichkey.show` for `Alt+Space` and `Ctrl+Space` when focus is in VS Code auxiliary bar views

## [0.0.4] - 2026-04-05

### Added

- `doom.cleanup` command to detect and remove stale settings and conflicting entries (surgical per-entry removal, requires explicit user confirmation)

### Fixed

- Added editor-specific `Space` keybinding and explicit `vim.leader` default to fix `SPC` in focused editor context

### Known Issues

- `doom.cleanup` only affects the default profile — settings in non-default VS Code profiles are not scanned or modified

## [0.0.3] - 2026-03-31

### Added

- [fuzzy-search](https://marketplace.visualstudio.com/items?itemName=jacobdufault.fuzzy-search) as a hard dependency for `SPC s s` (Search in file)
- Enhanced find/replace keybindings (`Ctrl+S` to open/navigate, `Ctrl+R` for previous match)
- Global keybindings for find widget control (Enter/Escape to close)
- Search view closure handling for sidebar, panel, and auxiliary bar contexts

### Changed

- `SPC s s` (Search in file) now requires fuzzy-search — fallback to native find removed
- Fixed "Search Project" (`SPC s p`) command to use correct `workbench.action.findInFiles`

### Fixed

- Search functionality keybindings now properly handle disabled find widget states
- Multiple search view closure scenarios now work correctly

## [0.0.2] - 2026-03-30

### Added

- Automatic one-time application of Doom defaults on first activation

### Changed

- Updated extension icon in `assets/icon.png`
- Reordered and cleaned up `whichkey.bindings` entries in configuration defaults

### Fixed

- Fixed terminal popup toggle behavior
- Changed the alternative leader key from `Alt+Shift+Space` to `Ctrl+Space`

## [0.0.1] - 2026-03-29

### Added

- Initial release of Doom Code extension
- Doom Emacs-inspired keybindings via VSCodeVim and VSpaceCode
- Which-key menu system with 40+ configured bindings
- `doom.install` command to apply settings
- Full documentation and MIT license
