<div align="center">
  <h1>Doom Code – VS Code Extension</h1>
</div>

![screenshot ](assets/screenshot.png)
---

Bring the power and elegance of **Doom Emacs** to VS Code. This configuration transforms VS Code into a modal, keyboard-driven editor that closely mirrors Doom Emacs' workflows and philosophy – designed for developers who either want to learn Doom Emacs or are forced to use VS Code but prefer an Emacs-like experience.

> **How it works:** This project is packaged as a **VS Code extension** that builds on top of the excellent **[VSCodeVim](https://github.com/vscodevim/vim)** and **[VSpaceCode](https://github.com/VSpaceCode/vscode-which-key)** extensions, which provide the core modal editing and which-key menu system. The primary contribution of this extension is a **carefully crafted which-key configuration** that extends VSpaceCode's standard bindings and organizes them to closely match **Doom Emacs' command structure and philosophy**. Required dependencies are installed automatically alongside this extension.

## 🎯 Purpose

Doom Emacs is known for its efficient keybindings, modal editing, and a clean, distraction-free interface. However, not everyone can use Emacs – whether due to ecosystem constraints, team workflows, or specific tool requirements.

**doomcode** bridges this gap by curating and configuring the existing ecosystem of VS Code extensions:

- **VSCodeVim** provides authentic **evil-mode keybindings** (Vim-like modal editing)
- **VSpaceCode** provides the **which-key menu system** for leader-key navigation
- **This extension** configures these extensions to **recreate Doom Emacs' command structure and workflows**

The result is a **configuration-based adaptation** that brings Doom's philosophy to VS Code developers with minimal friction.

This configuration works best for developers who value **efficiency over mouse usage** and want a **predictable, modal editing experience**.

## ✨ Features

This configuration includes:

- Doom-style leader-key navigation centered around `SPC`, with the live which-key menu as the source of truth for available bindings
- Fast file, buffer, project, and symbol navigation with representative entry points like `SPC .`, `SPC SPC`, `SPC s p`, and `SPC c d`
- Modal code actions for formatting, references, imports, rename, quick fixes, and refactors through grouped menus instead of scattered shortcuts
- Integrated terminal, debug, AI assistant, and window-management menus exposed through which-key
- Opinionated editor defaults for a cleaner layout, including hidden activity bar, hidden tabs, disabled breadcrumbs, and a hidden command center
- Required companion extensions for modal editing, which-key, fuzzy in-file search, and TODO highlighting

If a binding shown in the README ever disagrees with what you see in which-key, trust which-key. The shipped configuration in `whichkey.bindings` is authoritative.

## 🎮 Modal Editing

All keybindings follow **Vim/Evil conventions**:

- `leader` = `Space` (configure via leader key)
- Alternative which-key trigger =  `Alt+Space` and `Ctrl+Space` (only where SPC is not working)
- Which-key menus activate automatically with a short delay
- All standard movement keys work in modal contexts

Explorer, Open Editors, Timeline, terminal, and other focused views also get context-aware bindings where VS Code allows them.

## 📋 Requirements

This configuration **requires** four essential extensions:

### Core Dependencies

All dependencies are declared as `extensionDependencies` and are installed automatically when you install Doom Code:

1. **[VSCodeVim](https://github.com/vscodevim/vim)** – Vim/Evil-mode emulation
   - Provides modal editing (normal, insert, visual modes)
   - Handles all Vim motions and operators
2. **[VSpaceCode](https://github.com/VSpaceCode/vscode-which-key)** – Which-key menu system
   - Displays keyboard command menus (like Doom's prefix menu)
   - The entire custom configuration is built on which-key's binding system
   - Standard VS Code command menus have been extended to match Doom Emacs' style as closely as possible
3. **[fuzzy-search](https://marketplace.visualstudio.com/items?itemName=jacobdufault.fuzzy-search)** – Fuzzy in-file search
   - Required for `SPC s s` (Search in file)
   - Provides a fuzzy-matching find experience similar to Doom Emacs' `swiper`
4. **[Todo Highlight](https://marketplace.visualstudio.com/items?itemName=wayou.vscode-todo-highlight)** – Highlight TODO-style annotations
   - Required for Doom Code's default `TODO:`, `FIXME:`, `NOTE:`, `REVIEW:`, and `HACK:` comment highlighting
   - Adds matching overview ruler markers with Doom Code's color palette

## 🚀 Installation

### Step 1: Install the Extension

Search for **Doom Code** in the VS Code Extensions marketplace and click Install. VSCodeVim and VSpaceCode are declared as dependencies and will be installed automatically.

### Step 2: Let Doom Code Apply Its Defaults

On first activation, Doom Code automatically writes its install defaults to your user settings when those settings are not already configured.

This gives a fresh setup the required defaults automatically while leaving any existing user-defined settings untouched.

If you want to run the setup again later, open the Command Palette, run **Install Doom Code**, and confirm the prompt.

### Step 3: Configure UI Layout

For the configuration to work optimally:

1. **Open the Explorer panel** (`SPC o p` or from the sidebar)
2. **Drag "Timeline"** from the top to the bottom panel
3. **Drag "Open Editors"** to make it its own tab inside the primary side bar for a cleaner UI

This creates a clean primary editor area with file navigation and history in the bottom panel, matching Doom Emacs' layout philosophy.

### Step 4: Clean Up Your UI (Recommended)

The configuration assumes a **clean UI**. For best results:

- Hide the Activity bar (already configured)
- Disable tab bars (already configured)
- Breadcrumbs are disabled (already configured)
- Command Center is hidden (already configured)
- Remove unnecessary sidebar icons
- Keep only essential panels visible

A minimal UI reduces distractions and makes keyboard-driven navigation more effective.

## 🎨 UI Philosophy

This configuration emphasizes:

- **Keyboard-first workflow** – Everything centers on leader-key navigation
- **Minimal visual noise** – Hidden tabs, breadcrumbs, and command center
- **Modal paradigm** – Use Vim modes instead of mouse-based selection
- **Consistent keybindings** – Doom Emacs conventions throughout

The cleaner your UI, the more effective the modal experience becomes.

## ⚙️ Customization

The main customization happens through **which-key bindings** in the VS Code settings. You can customize bindings by editing `whichkey.bindings` in your user `settings.json`, or by forking this extension and editing the `contributes.configurationDefaults` section of its `package.json`. Edit the `whichkey.bindings` array to:

- Add new leader-key shortcuts
- Modify existing bindings
- Create nested command groups

Treat the README as orientation and `whichkey.bindings` plus the in-editor which-key menu as the authoritative map.

Refer to the [VSpaceCode documentation](https://github.com/VSpaceCode/vscode-which-key) for advanced configuration options.

## ⚠️ Known Issues

- **`doom.cleanup` only affects the default profile** – When using VS Code profiles, the cleanup command currently reads and writes settings from the default profile only. Settings in non-default profiles are not scanned or modified.

## 🙏 Credits & Inspiration

This configuration stands on the shoulders of amazing projects:

- **[Doom Emacs](https://github.com/hlissner/doom-emacs)** – The philosophical foundation and keybinding inspiration that makes this configuration possible
- **[VSCodeVim](https://github.com/vscodevim/vim)** – Bringing authentic Vim/Evil modal editing to VS Code
- **[VSpaceCode](https://github.com/VSpaceCode/vscode-which-key)** – The which-key implementation that enables Doom-like leader-key menus

Thank you to all contributors and maintainers of these projects for their dedication to improving the developer experience.

## 📄 License

MIT License – Feel free to use, modify, and share this extension.

## 💡 Tips

- Press `SPC` once to see available commands in which-key
- Use `SPC :` for the VS Code command palette
- Customize the theme and icon theme to match your own preferences

## 🤝 Contributing

Found improvements or better keybindings? Contributions are welcome! 

**For users:** Feel free to submit issues and pull requests to enhance the doomcode experience.

**For developers:** Want to contribute code? See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, build commands, and development workflow.

## 🚢 Release Automation (Maintainers)

Releases are automated with GitHub Actions.

1. Bump `package.json` version and update `CHANGELOG.md`
2. Push changes to `main`
3. Push a matching version tag (example: `v0.1.1`)

That tag triggers a workflow that runs checks, creates a GitHub Release with a `.vsix` asset, and publishes the same package to the VS Code Marketplace.

---

**Make VS Code feel like Doom Emacs. Happy coding!** 🚀
