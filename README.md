<div align="center">
  <h1>Doom Code – VS Code Extension</h1>
</div>

![screenshot ](assets/screenshot.png)
---

Bring the power and elegance of **Doom Emacs** to VS Code. This configuration transforms VS Code into a modal, keyboard-driven editor that closely mirrors Doom Emacs' workflows and philosophy – designed for developers who either want to learn Doom Emacs or are forced to use VS Code but prefer an Emacs-like experience.

> **How it works:** This project is packaged as a **VS Code extension** that builds on top of the excellent **[VSCodeVim](https://github.com/vscodevim/vim)** and **[VSpaceCode](https://github.com/VSpaceCode/vscode-which-key)** extensions, which provide the core modal editing and which-key menu system. The primary contribution of this extension is a **carefully crafted which-key configuration** that extends VSpaceCode's standard bindings and organizes them to closely match **Doom Emacs' command structure and philosophy**. Both dependencies are installed automatically alongside this extension.

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

### Navigation & Buffers

- **File finder** (`SPC .` / `SPC SPC`) – Quick file navigation
- **Buffer switcher** (`SPC <`) – Switch between open editors
- **Show all buffers** (`SPC b B`) – View all open editors/buffers
- **File history** (`SPC s u`) – Access timeline/file history

### Code Intelligence

- **Jump to definition** (`SPC c d`) – Go to function/class definition
- **Jump to references** (`SPC c D`) – Find all references
- **Find implementations** (`SPC c i`) – Locate implementations
- **Find type definition** (`SPC c t`) – Jump to type definition
- **Format code** (`SPC c f`) – Format document or selection
- **List errors** (`SPC c x`) – Show all diagnostics in Problems panel
- **Trim trailing whitespace** (`SPC c w`) – Clean up whitespace
- **Compile/Build** (`SPC c c`) – Run build tasks

### Search

- **Search in file** (`SPC s s`) – Find in current editor using [fuzzy-search](https://marketplace.visualstudio.com/items?itemName=jacobdufault.fuzzy-search) (required dependency)
- **Search project** (`SPC s p`) – Find across all files in project
- **Find symbol** (`SPC s j`) – Jump to symbol in current file
- **Find symbol workspace** (`SPC s J`) – Find symbol across all files
- **Find all references** (`SPC s r`) – Show all usages (in side panel)
- **Find all references (side view)** (`SPC s R`) – Open references in references panel
- **Search and replace** (`Ctrl+S`) – Open find widget with multi-state navigation
- **File history** (`SPC s u`) – Access timeline/file history

### Project & Sidebar

- **Toggle project sidebar** (`SPC o p`) – Show/hide file explorer
- **New file** (`c f` in explorer) – Create new file
- **New folder** (`c d` in explorer) – Create new folder
- **Rename file** (`Shift+R` in explorer) – Rename selection
- **Delete file** (`d` in explorer) – Delete selection

### Terminal & Debug

- **Toggle terminal** (`SPC o t`) – Open/close integrated terminal
- **Start debugger** (`SPC o d`) – Open debug sidebar
- **Debug console** (`SPC o D`) – Open REPL/debug console

### AI Assistants

- **Copilot Chat** (`SPC o a a`) – Toggle Copilot Chat
- **Codex Chat** (`SPC o a c`) – Open Codex Chat
- **Gemini Chat** (`SPC o a g`) – Open Gemini Chat

### Window Management

- **Close editor group** (`SPC w c`) – Close current editor group
- **New workspace** (`SPC Tab n`) – Create new VS Code window
- **Switch workspaces** (`SPC Tab Tab`) – Switch between windows
- **Command palette** (`SPC :`) – M-x equivalent for VS Code

### UI Cleanliness

- Activity bar hidden for minimal distractions
- Tab bar disabled – modal navigation replaces tab clicking
- Breadcrumbs disabled – cleaner editor view
- Command center hidden
- Menu bar in compact mode

## 🎮 Modal Editing

All keybindings follow **Vim/Evil conventions**:

- `leader` = `Space` (configure via leader key)
- Alternative which-key trigger =  `Alt+Space` and `Ctrl+Space` (only where SPC is not working)
- Which-key menus activate automatically with a short delay
- All standard movement keys work in modal contexts

**File Explorer bindings:**

- `c f` – New file
- `c d` – New folder
- `r` – Refresh
- `Shift+R` – Rename
- `d` – Delete
- `q` – Close sidebar

The spacer provides additional context-aware bindings for Open Editors and other panels.

## 📋 Requirements

This configuration **requires** three essential extensions:

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

## 🚀 Installation

### Step 1: Install the Extension

Search for **Doom Code** in the VS Code Extensions marketplace and click Install. VSCodeVim and VSpaceCode are declared as dependencies and will be installed automatically.

### Step 2: Let Doom Code Apply Its Defaults

On first activation, Doom Code automatically writes its install defaults to your user settings when those settings are not already configured.

This gives a fresh setup the required defaults automatically while leaving any existing user-defined settings untouched.

If you want to run the setup again later, open the Command Palette, run **Install Doom Code**, and confirm the prompt.

### Step 3: Configure UI Layout

For the configuration to work optimally:

1. **Open the Explorer panel** (`SPC o p`)
2. **Drag "Timeline"** from the top to the bottom panel
3. **Drag "Open Editors"** to make it its own tab inside the primary side bar for a cleaner UI

This creates a clean primary editor area with file navigation and history in the bottom panel, matching Doom Emacs' layout philosophy.

### Step 4: Clean Up Your UI (Recommended)

The configuration assumes a **clean UI**. For best results:

- Hide the Activity bar (already configured)
- Disable tab bars (already configured)
- Remove unnecessary sidebar icons
- Keep only essential panels visible

A minimal UI reduces distractions and makes keyboard-driven navigation more effective.

## 🎨 UI Philosophy

This configuration emphasizes:

- **Keyboard-first workflow** – Everything accessible via leader key
- **Minimal visual noise** – Hidden tabs, breadcrumbs, and command center
- **Modal paradigm** – Use Vim modes instead of mouse-based selection
- **Consistent keybindings** – Doom Emacs conventions throughout

The cleaner your UI, the more effective the modal experience becomes.

## ⚙️ Customization

The main customization happens through **which-key bindings** in the VS Code settings. You can customize bindings by editing `whichkey.bindings` in your user `settings.json`, or by forking this extension and editing the `contributes.configurationDefaults` section of its `package.json`. Edit the `whichkey.bindings` array to:

- Add new leader-key shortcuts
- Modify existing bindings
- Create nested command groups

Refer to the [VSpaceCode documentation](https://github.com/VSpaceCode/vscode-which-key) for advanced configuration options.

## 🙏 Credits & Inspiration

This configuration stands on the shoulders of amazing projects:

- **[Doom Emacs](https://github.com/hlissner/doom-emacs)** – The philosophical foundation and keybinding inspiration that makes this configuration possible
- **[VSCodeVim](https://github.com/vscodevim/vim)** – Bringing authentic Vim/Evil modal editing to VS Code
- **[VSpaceCode](https://github.com/VSpaceCode/vscode-which-key)** – The which-key implementation that enables Doom-like leader-key menus

Thank you to all contributors and maintainers of these projects for their dedication to improving the developer experience.

## 📄 License

MIT License – Feel free to use, modify, and share this extension.

## 💡 Tips

- Use `SPC :` to access the VS Code command palette with a Doom-like menu
- Press `SPC` once to see all available commands (the which-key menu)
- Combine `SPC` commands with Vim motions for powerful editing
- Explore different language servers for enhanced code intelligence
- Customize the theme and icon theme to match your own preferences

## 🤝 Contributing

Found improvements or better keybindings? Contributions are welcome! 

**For users:** Feel free to submit issues and pull requests to enhance the doomcode experience.

**For developers:** Want to contribute code? See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, build commands, and development workflow.

## 🚢 Release Automation (Maintainers)

Releases are automated with GitHub Actions.

1. Bump `package.json` version and update `CHANGELOG.md`
2. Push changes to `main`
3. Push a matching version tag (example: `v0.0.3`)

That tag triggers a workflow that runs checks, creates a GitHub Release with a `.vsix` asset, and publishes the same package to the VS Code Marketplace.

---

**Make VS Code feel like Doom Emacs. Happy coding!** 🚀
