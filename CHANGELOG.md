# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

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
