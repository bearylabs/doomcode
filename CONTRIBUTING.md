# Contributing to Doom Code

Thank you for your interest in contributing to Doom Code! This guide explains how to set up your development environment and contribute to the project.

## Opening the Project

**Open `doomcode.code-workspace` instead of opening the folder directly.**

This multi-root workspace includes:
- `doomcode` — the extension
- `doomcode-workspace` — companion package for workspace configs

### Why the workspace file?

The workspace file configures extensions to run on the workspace (remote) host instead of the local client host. This is **required for proper debugging on Windows + WSL**:

```json
"remote.extensionKind": {
  "bearylabs.doom": ["workspace"],
  "vspacecode.whichkey": ["workspace"]
}
```

UI-kind extensions default to running locally (on Windows), which breaks WSL debugging. The workspace file forces them remote.

**If you open the folder directly, debugging will fail.**

## Development Setup

### Option 1: Using Nix (Recommended)

The project includes a `flake.nix` for reproducible development environments:

```bash
nix develop
```

This shell includes Node.js, npm, and all required tools. All subsequent commands should be run inside this shell.

### Option 2: Manual Setup

If you don't use Nix, ensure you have:

- Node.js 16+
- npm 7+

Then install dependencies:

```bash
npm install
```

## Build & Development Commands

All commands below assume you're inside the Nix shell (`nix develop`). If not using Nix, you can run them directly without the prefix.

### Compile TypeScript

```bash
nix develop -c npm run compile
```

Compiles `src/*.ts` to `out/*.js` using TypeScript.

### Watch Mode

```bash
nix develop -c npm run watch
```

Watches source files and recompiles on changes. Ideal when actively developing.

### Linting

```bash
nix develop -c npm run lint
```

Runs ESLint on the `src/` directory. Fix automatically with:

```bash
nix develop -c npx eslint src --fix
```

### Testing

```bash
nix develop -c npm run test
```

Runs the test suite using `@vscode/test-cli`. Tests are in `src/test/`.

### Full Build Pipeline

```bash
nix develop -c npm run pretest
```

Runs compile + lint (useful before submitting PRs).

## Extension Development Workflow

### 1. Make Changes

Edit files in `src/`. The extension code is in `src/extension.ts`.

### 2. Run Watch Mode

```bash
nix develop -c npm run watch
```

This compiles changes automatically.

### 3. Test in VS Code

Open the project in VS Code and press **F5** to launch the extension in a test window. The test profile uses an isolated extensions directory to avoid conflicts.

### 4. Reload Extension

After making TypeScript changes:

- With watch mode running (see step 2), just reload the test window (**Ctrl+R** / **Cmd+R**)
- Or restart debugging with **F5**

### 5. Package for Testing

To create a `.vsix` file for manual testing:

```bash
nix develop -c npm run compile
nix develop -c npx @vscode/vsce package
```

This generates `doom-<version>.vsix` which you can install in VS Code via:

```bash
code --install-extension doom-<version>.vsix
```

## Project Structure

```
src/
├── extension.ts       # Main extension entry point
└── test/
    └── extension.test.ts  # Extension tests

package.json          # Extension manifest & metadata
tsconfig.json         # TypeScript configuration
.vscodeignore         # Files excluded from .vsix package
eslint.config.mjs     # ESLint configuration
flake.nix             # Nix development environment
```

## Key Files

- **package.json**: Extension manifest (contributes, dependencies, metadata)
- **src/extension.ts**: Extension lifecycle (activate/deactivate) and command registration
- **README.md**: End-user documentation
- **CHANGELOG.md**: Version history and release notes

## Making Changes

### Adding a New Command

1. Register the command in `src/extension.ts` → `activate()`
2. Add to `package.json` → `contributes.commands`
3. Add keybinding in `package.json` → `contributes.keybindings` (optional)
4. Document in `README.md`

### Updating Keybindings

Keybindings and which-key menu are defined in `package.json` → `contributes.configurationDefaults` → `whichkey.bindings`. Changes apply immediately after reinstalling the extension.

### Updating Settings

Core settings go in `contributes.configurationDefaults`. Settings that don't pass the manifest schema go in `doomInstallDefaults` (applied only when user runs `doom.install` command).

## Testing Your Changes

### Local Testing

1. `nix develop`
2. `npm run watch` (in one terminal)
3. Press **F5** in VS Code to launch extension in test profile
4. Make changes; reload window with **Ctrl+R** / **Cmd+R**

### Before Submitting a PR

1. Compile: `nix develop -c npm run compile`
2. Lint: `nix develop -c npm run lint`
3. Test: `nix develop -c npm run test`
4. Build: `nix develop -c npm run pretest`
5. All should pass with no errors

## Publishing to VS Code Marketplace

**Only maintainers can publish.** To publish a new version:

1. Update `version` in `package.json` (follow [semver](https://semver.org/)).
2. Update `CHANGELOG.md` with release notes.
3. Commit and push to `main`.
4. Create and push a version tag that matches `package.json` exactly:

```bash
git tag v0.x.y
git push origin v0.x.y
```

When the tag is pushed, GitHub Actions will:

1. Run compile, lint, and tests.
2. Package a `.vsix` artifact.
3. Create a GitHub Release for the tag and attach the `.vsix`.
4. Publish that same package to VS Code Marketplace using `VSCE_PAT`.

## Questions?

Open an issue on [GitHub](https://github.com/bearylabs/doomcode/issues) if you have questions or run into problems.

Happy contributing! 🚀
