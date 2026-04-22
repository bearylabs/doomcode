// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DoomOpenEditorsPanel } from './buffers/openEditors';
import { DoomSharedPanel } from './panel/shared';
import { DoomFuzzySearchPanel } from './search/fuzzy';
import { DoomWhichKeyBindingsPanel } from './whichkey/bindingsPanel';
import { DoomWhichKeyMenu } from './whichkey/menu';
import { showWhichKeyBindingsQuickPick } from './whichkey/showBindings';
import { registerWindowMru } from './window/mru';

type WhichKeyMenuStyle = 'doom' | 'vspacecode';

const WHICH_KEY_MENU_SETTING = 'doom.whichKey.menuStyle';
const DEFAULT_WHICH_KEY_MENU_STYLE: WhichKeyMenuStyle = 'doom';

function getWhichKeyMenuStyle(): WhichKeyMenuStyle {
	const configuredStyle = vscode.workspace
		.getConfiguration()
		.get<WhichKeyMenuStyle>(WHICH_KEY_MENU_SETTING, DEFAULT_WHICH_KEY_MENU_STYLE);

	return configuredStyle === 'vspacecode' ? configuredStyle : DEFAULT_WHICH_KEY_MENU_STYLE;
}

async function showConfiguredWhichKeyMenu(
	whichKeyMenu: DoomWhichKeyMenu,
	sharedPanel: DoomSharedPanel,
): Promise<void> {
	if (getWhichKeyMenuStyle() === 'vspacecode') {
		await whichKeyMenu.hide();

		try {
			await vscode.commands.executeCommand('whichkey.show');
			return;
		} catch (error) {
			console.warn("Failed to show VSpaceCode WhichKey menu, falling back to Doom menu:", error);
			void vscode.window.showWarningMessage(
				"Unable to open the VSpaceCode WhichKey menu. Falling back to Doom Code's menu for this session."
			);
		}
	}

	await sharedPanel.showWhichKey();
}

// ---------------------------------------------------------------------------
// Conflicting extensions that override the same settings Doom Code manages.
// ---------------------------------------------------------------------------
const CONFLICTING_EXTENSIONS = [
	{
		id: "VSpaceCode.vspacecode",
		name: "VSpaceCode",
		reason: "overrides whichkey.bindings and vim keybindings with its own defaults",
	},
];

// Stale command prefixes left behind by conflicting extensions.
const STALE_COMMAND_PREFIXES = ["vspacecode."];

// ---------------------------------------------------------------------------
// Install defaults
// ---------------------------------------------------------------------------

function getInstallDefaults(context: vscode.ExtensionContext): Record<string, unknown> {
	const packageJson = context.extension.packageJSON as {
		doomInstallDefaults?: Record<string, unknown>;
	};

	return packageJson.doomInstallDefaults ?? {};
}

async function applyDefaultsToUserSettings(
	defaults: Record<string, unknown>,
	showResultMessage = false
): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	const target = vscode.ConfigurationTarget.Global;

	let applied = 0;
	let skipped = 0;
	let unsupported = 0;
	let failed = 0;
	const entries = Object.entries(defaults);

	for (const [key, value] of entries) {
		const inspected = config.inspect(key);

		if (!inspected) {
			unsupported++;
			continue;
		}

		const alreadySetByUser = inspected?.globalValue !== undefined;

		if (alreadySetByUser) {
			skipped++;
			continue;
		}

		try {
			await config.update(key, value, target);
			applied++;
		} catch (error) {
			console.warn(`Failed to apply setting '${key}':`, error);
			failed++;
		}
	}

	if (showResultMessage) {
		if (entries.length === 0) {
			void vscode.window.showWarningMessage("No Doom install defaults are configured in package.json.");
			return;
		}

		void vscode.window.showInformationMessage(
			`Doom defaults: applied ${applied}, skipped ${skipped} (already set), unsupported ${unsupported}, failed ${failed}.`
		);
	}
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

function detectConflictingExtensions(): typeof CONFLICTING_EXTENSIONS {
	return CONFLICTING_EXTENSIONS.filter(
		(ext) => vscode.extensions.getExtension(ext.id) !== undefined
	);
}

async function warnAboutConflicts(conflicts: typeof CONFLICTING_EXTENSIONS): Promise<void> {
	for (const ext of conflicts) {
		const choice = await vscode.window.showWarningMessage(
			`Doom Code: "${ext.name}" is installed and ${ext.reason}. This will cause keybinding conflicts. Please uninstall "${ext.name}" and reload.`,
			"Open Extensions"
		);
		if (choice === "Open Extensions") {
			await vscode.commands.executeCommand("workbench.extensions.action.showInstalledExtensions");
		}
	}
}

// ---------------------------------------------------------------------------
// Stale-command cleanup  (settings.json + keybindings.json)
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` (at any depth) contains a string that starts with
 * one of the stale command prefixes.
 */
function containsStaleCommand(value: unknown): boolean {
	if (typeof value === 'string') {
		return STALE_COMMAND_PREFIXES.some((p) => value.startsWith(p));
	}
	if (Array.isArray(value)) {
		return value.some(containsStaleCommand);
	}
	if (value !== null && typeof value === 'object') {
		return Object.values(value as Record<string, unknown>).some(containsStaleCommand);
	}
	return false;
}

/**
 * Scan vim keybinding arrays in user settings for stale commands.
 * Only removes individual stale entries, preserving all user-defined bindings.
 * Returns the list of setting keys that were cleaned.
 */
async function cleanStaleSettings(): Promise<string[]> {
	const config = vscode.workspace.getConfiguration();
	const keysToCheck = [
		"vim.normalModeKeyBindingsNonRecursive",
		"vim.visualModeKeyBindingsNonRecursive",
		"vim.normalModeKeyBindings",
		"vim.visualModeKeyBindings",
	];

	const cleaned: string[] = [];

	for (const key of keysToCheck) {
		const inspected = config.inspect(key);
		const currentValue = inspected?.globalValue;
		if (!Array.isArray(currentValue)) {
			continue;
		}

		const filtered = currentValue.filter((entry) => !containsStaleCommand(entry));
		if (filtered.length !== currentValue.length) {
			await config.update(key, filtered, vscode.ConfigurationTarget.Global);
			cleaned.push(key);
		}
	}

	return cleaned;
}

/**
 * Read the user keybindings.json, filter out entries whose `command` starts
 * with a stale prefix, and write back if anything changed.
 * Returns the number of entries removed.
 */
async function cleanStaleKeybindings(context: vscode.ExtensionContext): Promise<number> {
	const keybindingsPath = getKeybindingsPath(context);
	if (!keybindingsPath || !fs.existsSync(keybindingsPath)) {
		return 0;
	}

	let raw: string;
	try {
		raw = fs.readFileSync(keybindingsPath, 'utf-8');
	} catch {
		return 0;
	}

	// Strip single-line comments (// ...) so JSON.parse succeeds.
	const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
	// Strip trailing commas before ] or }
	const sanitized = stripped.replace(/,\s*([}\]])/g, '$1');

	let bindings: Array<{ command?: string; [key: string]: unknown }>;
	try {
		bindings = JSON.parse(sanitized);
	} catch {
		console.warn("Doom Code: could not parse keybindings.json, skipping cleanup.");
		return 0;
	}

	if (!Array.isArray(bindings)) {
		return 0;
	}

	const before = bindings.length;
	const filtered = bindings.filter((entry) => {
		const cmd = entry.command;
		if (typeof cmd !== 'string') { return true; }
		// Keep negations (e.g. "-vspacecode.space") — they disable a default.
		if (cmd.startsWith('-')) { return true; }
		return !STALE_COMMAND_PREFIXES.some((p) => cmd.startsWith(p));
	});

	const removed = before - filtered.length;
	if (removed === 0) { return 0; }

	const output = "// Place your key bindings in this file to override the defaults\n"
		+ JSON.stringify(filtered, null, '\t')
		+ '\n';

	try {
		fs.writeFileSync(keybindingsPath, output, 'utf-8');
	} catch (err) {
		console.warn("Doom Code: failed to write cleaned keybindings.json:", err);
		return 0;
	}

	return removed;
}

function getKeybindingsPath(context: vscode.ExtensionContext): string | undefined {
	// globalStorageUri points to:
	//   <userData>/User/globalStorage/<ext-id>       (default profile)
	//   <userData>/User/profiles/<id>/globalStorage/<ext-id>  (named profile)
	// Go up 2 levels to reach the active profile's User directory.
	const profileDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
	return path.join(profileDir, 'keybindings.json');
}

// ---------------------------------------------------------------------------
// Detection-only check (reads state, never mutates)
// ---------------------------------------------------------------------------

interface StaleDetectionResult {
	conflicts: typeof CONFLICTING_EXTENSIONS;
	hasStaleSettings: boolean;
	hasStaleKeybindings: boolean;
}

function detectStaleState(context: vscode.ExtensionContext): StaleDetectionResult {
	const conflicts = detectConflictingExtensions();

	const config = vscode.workspace.getConfiguration();
	const keysToCheck = [
		"vim.normalModeKeyBindingsNonRecursive",
		"vim.visualModeKeyBindingsNonRecursive",
		"vim.normalModeKeyBindings",
		"vim.visualModeKeyBindings",
	];

	const hasStaleSettings = keysToCheck.some((key) => {
		const inspected = config.inspect(key);
		const currentValue = inspected?.globalValue;
		return Array.isArray(currentValue) && currentValue.some(containsStaleCommand);
	});

	let hasStaleKeybindings = false;
	const keybindingsPath = getKeybindingsPath(context);
	if (keybindingsPath && fs.existsSync(keybindingsPath)) {
		try {
			const raw = fs.readFileSync(keybindingsPath, 'utf-8');
			const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
			const sanitized = stripped.replace(/,\s*([}\]])/g, '$1');
			const bindings = JSON.parse(sanitized);
			if (Array.isArray(bindings)) {
				hasStaleKeybindings = bindings.some((entry: { command?: string }) => {
					const cmd = entry.command;
					return typeof cmd === 'string'
						&& !cmd.startsWith('-')
						&& STALE_COMMAND_PREFIXES.some((p) => cmd.startsWith(p));
				});
			}
		} catch {
			// If we can't parse it, don't flag it
		}
	}

	return { conflicts, hasStaleSettings, hasStaleKeybindings };
}

// ---------------------------------------------------------------------------
// Prompt for cleanup on automatic activation (never mutates without consent)
// ---------------------------------------------------------------------------

async function promptForCleanup(context: vscode.ExtensionContext): Promise<void> {
	const { conflicts, hasStaleSettings, hasStaleKeybindings } = detectStaleState(context);

	if (conflicts.length > 0) {
		await warnAboutConflicts(conflicts);
	}

	if (hasStaleSettings || hasStaleKeybindings) {
		const choice = await vscode.window.showWarningMessage(
			"Doom Code detected stale VSpaceCode bindings. Clean them up?",
			"Clean Up",
			"Not Now"
		);
		if (choice === "Clean Up") {
			await runCleanup(context);
		}
	}
}

// ---------------------------------------------------------------------------
// Full cleanup — mutating path (manual command or user-confirmed)
// ---------------------------------------------------------------------------

async function runCleanup(context: vscode.ExtensionContext): Promise<void> {
	const cleanedSettings = await cleanStaleSettings();
	const removedKeybindings = await cleanStaleKeybindings(context);

	const didClean = cleanedSettings.length > 0 || removedKeybindings > 0;

	if (didClean) {
		const defaults = getInstallDefaults(context);
		await applyDefaultsToUserSettings(defaults, false);
	}

	const conflicts = detectConflictingExtensions();

	const parts: string[] = [];
	if (cleanedSettings.length > 0) {
		parts.push(`cleaned ${cleanedSettings.length} setting(s)`);
	}
	if (removedKeybindings > 0) {
		parts.push(`removed ${removedKeybindings} stale keybinding(s)`);
	}
	if (conflicts.length > 0) {
		parts.push(`${conflicts.length} conflicting extension(s) detected`);
	}

	if (parts.length > 0) {
		void vscode.window.showInformationMessage(
			`Doom Code cleanup: ${parts.join(', ')}. Please reload the window.`,
			"Reload"
		).then((choice: string | undefined) => {
			if (choice === "Reload") {
				void vscode.commands.executeCommand("workbench.action.reloadWindow");
			}
		});
	} else {
		void vscode.window.showInformationMessage("Doom Code: no stale settings or conflicts found.");
	}
}

// ---------------------------------------------------------------------------
// Which-key migration
// ---------------------------------------------------------------------------

async function migrateLegacyWhichKeyShowBindings(): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	const keysToCheck = [
		"vim.normalModeKeyBindingsNonRecursive",
		"vim.visualModeKeyBindingsNonRecursive",
	];

	for (const key of keysToCheck) {
		const inspected = config.inspect(key);
		const currentValue = inspected?.globalValue;
		if (!Array.isArray(currentValue)) {
			continue;
		}

		let changed = false;
		const migrated = currentValue.map((entry) => {
			if (
				entry !== null
				&& typeof entry === 'object'
				&& 'before' in entry
				&& 'commands' in entry
			) {
				const binding = entry as {
					before?: unknown;
					commands?: unknown;
				};

				if (
					Array.isArray(binding.before)
					&& binding.before.length === 1
					&& binding.before[0] === '<space>'
					&& Array.isArray(binding.commands)
					&& binding.commands.length === 1
					&& binding.commands[0] === 'whichkey.show'
				) {
					changed = true;
					return {
						...entry,
						commands: ['doom.whichKeyShow'],
					};
				}
			}

			return entry;
		});

		if (changed) {
			await config.update(key, migrated, vscode.ConfigurationTarget.Global);
		}
	}
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Doom Code is now active.');

	const installDefaults = getInstallDefaults(context);
	const defaultsAppliedKey = "doom.defaultsAppliedOnce";
	const whichKeyMigratedKey = "doom.whichKeyShowMigrated";
	const fuzzySearchPanel = new DoomFuzzySearchPanel();
	const whichKeyMenu = new DoomWhichKeyMenu();
	registerWindowMru(context);
	const openEditorsPanel = new DoomOpenEditorsPanel();
	const whichKeyBindingsPanel = new DoomWhichKeyBindingsPanel();
	const sharedPanel = new DoomSharedPanel(
		whichKeyMenu,
		fuzzySearchPanel,
		openEditorsPanel,
		whichKeyBindingsPanel,
	);

	// First-activation: apply defaults then detect stale state.
	if (!context.globalState.get<boolean>(defaultsAppliedKey)) {
		void applyDefaultsToUserSettings(installDefaults, false)
			.then(async () => {
				await context.globalState.update(defaultsAppliedKey, true);
				if (!context.globalState.get<boolean>(whichKeyMigratedKey)) {
					await migrateLegacyWhichKeyShowBindings();
					await context.globalState.update(whichKeyMigratedKey, true);
				}
				await promptForCleanup(context);
			})
			.catch((error) => {
				console.warn("Failed to apply Doom defaults on first activation:", error);
			});
	} else {
		// Subsequent activations: detect and prompt, never mutate silently.
		void (async () => {
			if (!context.globalState.get<boolean>(whichKeyMigratedKey)) {
				await migrateLegacyWhichKeyShowBindings();
				await context.globalState.update(whichKeyMigratedKey, true);
			}
			await promptForCleanup(context);
		})();
	}

	// Manual install command
	const installCmd = vscode.commands.registerCommand(
		"doom.install",
		async () => {
			const choice = await vscode.window.showWarningMessage(
				"Apply Doom default settings to your User settings?",
				{ modal: true },
				"Apply"
			);
			if (choice !== "Apply") { return; }

			await applyDefaultsToUserSettings(installDefaults, true);
		}
	);

	// Manual cleanup command
	const cleanupCmd = vscode.commands.registerCommand(
		"doom.cleanup",
		async () => {
			const conflicts = detectConflictingExtensions();
			if (conflicts.length > 0) {
				await warnAboutConflicts(conflicts);
			}
			await runCleanup(context);
		}
	);

	const whichKeyCmd = vscode.commands.registerCommand(
		"doom.whichKeyShow",
		() => {
			if (getWhichKeyMenuStyle() === 'vspacecode') {
				void showConfiguredWhichKeyMenu(whichKeyMenu, sharedPanel);
				return;
			}

			void sharedPanel.showWhichKey();
		}
	);

	const whichKeyBindingsCmd = vscode.commands.registerCommand(
		"doom.whichKeyShowBindings",
		() => {
			if (getWhichKeyMenuStyle() === 'vspacecode') {
				void showWhichKeyBindingsQuickPick();
				return;
			}

			void sharedPanel.showWhichKeyBindings();
		}
	);

	const whichKeyHideCmd = vscode.commands.registerCommand(
		"doom.whichKeyHide",
		() => {
			void whichKeyMenu.hide();
		}
	);

	const configurationChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (!event.affectsConfiguration(WHICH_KEY_MENU_SETTING)) {
			return;
		}

		if (getWhichKeyMenuStyle() === 'vspacecode') {
			void whichKeyMenu.hide();
		}
	});

	const fuzzySearchCmd = vscode.commands.registerCommand(
		"doom.fuzzySearchActiveTextEditor",
		() => {
			void sharedPanel.showFuzzySearch();
		}
	);

	const workspaceFuzzySearchCmd = vscode.commands.registerCommand(
		"doom.fuzzySearchWorkspace",
		() => {
			void sharedPanel.showWorkspaceSearch();
		}
	);

	const openEditorsCmd = vscode.commands.registerCommand(
		"doom.showOpenEditors",
		() => {
			void sharedPanel.showOpenEditors();
		}
	);

	const fuzzySearchMoveDownCmd = vscode.commands.registerCommand(
		"doom.fuzzySearchMoveDown",
		() => {
			void fuzzySearchPanel.moveSelection(1);
		}
	);

	const fuzzySearchMoveUpCmd = vscode.commands.registerCommand(
		"doom.fuzzySearchMoveUp",
		() => {
			void fuzzySearchPanel.moveSelection(-1);
		}
	);

	const sharedPanelViewProvider = vscode.window.registerWebviewViewProvider(
		DoomSharedPanel.viewId,
		sharedPanel,
		{
			webviewOptions: {
				retainContextWhenHidden: true,
			},
		}
	);

	context.subscriptions.push(
		installCmd,
		cleanupCmd,
		whichKeyCmd,
		whichKeyBindingsCmd,
		whichKeyHideCmd,
		configurationChangeListener,
		fuzzySearchCmd,
		workspaceFuzzySearchCmd,
		openEditorsCmd,
		fuzzySearchMoveDownCmd,
		fuzzySearchMoveUpCmd,
		sharedPanelViewProvider,
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }
