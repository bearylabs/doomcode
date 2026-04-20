// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { registerWindowMru } from './window/mru';

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
async function cleanStaleKeybindings(): Promise<number> {
	const keybindingsPath = getKeybindingsPath();
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

function getKeybindingsPath(): string | undefined {
	const appData = process.env.APPDATA
		?? (process.platform === 'darwin'
			? path.join(process.env.HOME ?? '', 'Library', 'Application Support')
			: path.join(process.env.HOME ?? '', '.config'));

	return path.join(appData, 'Code', 'User', 'keybindings.json');
}

// ---------------------------------------------------------------------------
// Detection-only check (reads state, never mutates)
// ---------------------------------------------------------------------------

interface StaleDetectionResult {
	conflicts: typeof CONFLICTING_EXTENSIONS;
	hasStaleSettings: boolean;
	hasStaleKeybindings: boolean;
}

function detectStaleState(): StaleDetectionResult {
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
	const keybindingsPath = getKeybindingsPath();
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
	const { conflicts, hasStaleSettings, hasStaleKeybindings } = detectStaleState();

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
	const removedKeybindings = await cleanStaleKeybindings();

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
	registerWindowMru(context);

	// First-activation: apply defaults then detect stale state.
	if (!context.globalState.get<boolean>(defaultsAppliedKey)) {
		void applyDefaultsToUserSettings(installDefaults, false)
			.then(async () => {
				await context.globalState.update(defaultsAppliedKey, true);
				await promptForCleanup(context);
			})
			.catch((error) => {
				console.warn("Failed to apply Doom defaults on first activation:", error);
			});
	} else {
		// Subsequent activations: detect and prompt, never mutate silently.
		void promptForCleanup(context);
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

	context.subscriptions.push(installCmd, cleanupCmd);
}

// This method is called when your extension is deactivated
export function deactivate() { }
