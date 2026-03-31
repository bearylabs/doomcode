# Change Log


## [0.0.3] - 2026-03-31

### Added
- Conditional fuzzy-search support with [jacobdufault.fuzzy-search](https://marketplace.visualstudio.com/items?itemName=jacobdufault.fuzzy-search) extension
- Enhanced find/replace keybindings (`Ctrl+S` to open/navigate, `Ctrl+R` for previous match)
- Global keybindings for find widget control (Enter/Escape to close)
- Search view closure handling for sidebar, panel, and auxiliary bar contexts

### Changed
- Improved "Search in current file" (`SPC s s`) to conditionally use fuzzy-search when available, falls back to normal editor find
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


## [0.0.2] - 2026-03-30

### Added
- Automatic one-time application of Doom defaults on first activation

### Changed
- Updated extension icon in `assets/icon.png`
- Reordered and cleaned up `whichkey.bindings` entries in configuration defaults

### Fixed
- Fixed terminal popup toggle behavior
- Changed the alternative leader key from `Alt+Shift+Space` to `Ctrl+Space`