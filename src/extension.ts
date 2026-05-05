// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DoomOpenEditorsPanel } from './buffers/openEditors';
import {
	DASHBOARD_OPEN_ON_ACTIVATION_SETTING,
	detectDashboardMode,
	DoomDashboard,
	evaluateInstalledDefaults,
	resolveStartupCommandsFromBindings,
} from './onboarding/dashboard';
import {
	ApplyDefaultsOptions,
	ApplyDefaultsResult,
	applyDefaultsToConfiguration,
	runInstallFlow,
	type VimBindingConflict,
	type VimBindingConflictDecision,
} from './onboarding/install';
import { DoomSharedPanel } from './panel/shared';
import { DoomFindFilePanel } from './search/findFile';
import { DoomFuzzySearchPanel } from './search/fuzzy';
import { DoomProjectFilePanel } from './search/projectFile';
import { DoomRecentProjectsPanel } from './search/recentProjects';
import { SelectionHistory } from './search/selectionHistory';
import { DoomWhichKeyBindingsPanel } from './whichkey/bindingsPanel';
import { DoomWhichKeyMenu } from './whichkey/menu';
import { showWhichKeyBindingsQuickPick } from './whichkey/showBindings';
import { focusEditorGroup, registerWindowMru } from './window/mru';

type WhichKeyMenuStyle = 'doom' | 'vspacecode';

const WHICH_KEY_MENU_SETTING = 'doom.whichKey.menuStyle';
const DEFAULT_WHICH_KEY_MENU_STYLE: WhichKeyMenuStyle = 'doom';
const LAST_SEEN_VERSION_KEY = 'doom.lastSeenVersion';
const LAST_WORKSPACE_TARGET_KEY = 'doom.lastWorkspaceTarget';
const PREVIOUS_WORKSPACE_TARGET_KEY = 'doom.previousWorkspaceTarget';
/** Stores the absolute URI string of a file to open after the next folder reload. */
const PENDING_OPEN_FILE_KEY = 'doom.pendingOpenFile';
/** Set before an intentional project switch so the activation IIFE skips the dashboard. */
const SKIP_DASHBOARD_KEY = 'doom.skipDashboardOnActivation';
const KEEP_EXISTING_BINDING_ACTION = 'Keep Existing';
const OVERWRITE_WITH_DOOM_ACTION = 'Overwrite with Doom';
const KEEP_ALL_EXISTING_BINDINGS_ACTION = 'Keep All Existing';
const OVERWRITE_ALL_WITH_DOOM_ACTION = 'Overwrite All with Doom';

export interface StoredWorkspaceTarget {
	label: string;
	uri: string;
}

/** Type guard for `StoredWorkspaceTarget` — validates shape before reading from globalState. */
function isStoredWorkspaceTarget(value: unknown): value is StoredWorkspaceTarget {
	return value !== null
		&& typeof value === 'object'
		&& 'label' in value
		&& 'uri' in value
		&& typeof value.label === 'string'
		&& typeof value.uri === 'string';
}

/** Reads and validates a `StoredWorkspaceTarget` from a Memento. Returns undefined if missing or malformed. */
function getStoredWorkspaceTarget(state: vscode.Memento, key: string): StoredWorkspaceTarget | undefined {
	const value = state.get<unknown>(key);
	return isStoredWorkspaceTarget(value) ? value : undefined;
}

/** Returns a human-readable label for a workspace target URI, preferring workspace name over basename. */
function getWorkspaceTargetLabel(targetUri: vscode.Uri): string {
	if (vscode.workspace.workspaceFile?.toString() === targetUri.toString()) {
		return path.basename(targetUri.fsPath);
	}

	return vscode.workspace.name || path.basename(targetUri.fsPath);
}

/** Returns the current workspace as a storable target. Only handles local `file://` workspaces; returns undefined for remote or untitled. */
function getCurrentWorkspaceTarget(): StoredWorkspaceTarget | undefined {
	const workspaceFile = vscode.workspace.workspaceFile;
	if (workspaceFile?.scheme === 'file') {
		return {
			label: getWorkspaceTargetLabel(workspaceFile),
			uri: workspaceFile.toString(),
		};
	}

	const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (firstFolder?.scheme !== 'file') {
		return undefined;
	}

	return {
		label: getWorkspaceTargetLabel(firstFolder),
		uri: firstFolder.toString(),
	};
}

/**
 * Pure function: computes the new last/previous history pair given the current workspace.
 * No-ops (changed=false) if the current workspace is already the last recorded one.
 */
export function computeWorkspaceHistoryUpdate(
	current: StoredWorkspaceTarget | undefined,
	last: StoredWorkspaceTarget | undefined,
	previous: StoredWorkspaceTarget | undefined,
): {
	changed: boolean;
	last: StoredWorkspaceTarget | undefined;
	previous: StoredWorkspaceTarget | undefined;
} {
	if (!current || last?.uri === current.uri) {
		return {
			changed: false,
			last,
			previous,
		};
	}

	return {
		changed: true,
		last: current,
		previous: last,
	};
}

/**
 * Pure function: picks the best target to switch to for "reload last session".
 * Prefers `previous` when it differs from current, then `last`, then falls back if none differ.
 */
export function selectReloadWorkspaceTarget(
	current: StoredWorkspaceTarget | undefined,
	last: StoredWorkspaceTarget | undefined,
	previous: StoredWorkspaceTarget | undefined,
): StoredWorkspaceTarget | undefined {
	if (!current) {
		return last ?? previous;
	}

	if (previous && previous.uri !== current.uri) {
		return previous;
	}

	if (last && last.uri !== current.uri) {
		return last;
	}

	return undefined;
}

export type WindowDeleteAction = 'closeGroup' | 'closePanel' | 'moveTerminalEditorToPanelAndCloseGroup';

/**
 * Pure function: determines the correct `doom.windowDelete` action based on focus context.
 * Terminal panel focus → close panel. Terminal editor tab → move back to panel first. Otherwise → close group.
 */
export function resolveWindowDeleteAction(
	terminalFocus: boolean,
	activeTerminalEditor: boolean,
): WindowDeleteAction {
	if (terminalFocus && !activeTerminalEditor) {
		return 'closePanel';
	}

	if (activeTerminalEditor) {
		return 'moveTerminalEditorToPanelAndCloseGroup';
	}

	return 'closeGroup';
}

/** Snapshots the current workspace into globalState if it differs from the last recorded one. */
async function persistWorkspaceHistory(context: vscode.ExtensionContext): Promise<void> {
	const next = computeWorkspaceHistoryUpdate(
		getCurrentWorkspaceTarget(),
		getStoredWorkspaceTarget(context.globalState, LAST_WORKSPACE_TARGET_KEY),
		getStoredWorkspaceTarget(context.globalState, PREVIOUS_WORKSPACE_TARGET_KEY),
	);

	if (!next.changed) {
		return;
	}

	await context.globalState.update(PREVIOUS_WORKSPACE_TARGET_KEY, next.previous);
	await context.globalState.update(LAST_WORKSPACE_TARGET_KEY, next.last);
}

/**
 * Opens the previous workspace in the current window after user confirmation.
 * Clears stale history entries if the target path no longer exists on disk.
 */
async function reloadLastSession(context: vscode.ExtensionContext): Promise<void> {
	const last = getStoredWorkspaceTarget(context.globalState, LAST_WORKSPACE_TARGET_KEY);
	const previous = getStoredWorkspaceTarget(context.globalState, PREVIOUS_WORKSPACE_TARGET_KEY);
	const target = selectReloadWorkspaceTarget(getCurrentWorkspaceTarget(), last, previous);

	if (!target) {
		void vscode.window.showInformationMessage('No previous project saved yet. Open another project first.');
		return;
	}

	const targetUri = vscode.Uri.parse(target.uri);

	try {
		await vscode.workspace.fs.stat(targetUri);
	} catch {
		if (last?.uri === target.uri) {
			await context.globalState.update(LAST_WORKSPACE_TARGET_KEY, undefined);
		}

		if (previous?.uri === target.uri) {
			await context.globalState.update(PREVIOUS_WORKSPACE_TARGET_KEY, undefined);
		}

		void vscode.window.showWarningMessage(`Last session "${target.label}" is no longer available.`);
		return;
	}

	const choice = await vscode.window.showQuickPick(['Yes', 'No'], {
		placeHolder: 'This will wipe your current session. Do you want to continue?',
		ignoreFocusOut: true,
	});
	if (choice !== 'Yes') {
		return;
	}

	await vscode.commands.executeCommand('vscode.openFolder', targetUri, { forceReuseWindow: true });
}

/** Reads which-key menu style from config, normalising unknown values to the default 'doom' style. */
function getWhichKeyMenuStyle(): WhichKeyMenuStyle {
	const configuredStyle = vscode.workspace
		.getConfiguration()
		.get<WhichKeyMenuStyle>(WHICH_KEY_MENU_SETTING, DEFAULT_WHICH_KEY_MENU_STYLE);

	return configuredStyle === 'vspacecode' ? configuredStyle : DEFAULT_WHICH_KEY_MENU_STYLE;
}

/**
 * Shows which-key via VSpaceCode if configured, falling back to Doom's panel on error.
 * Hides the Doom menu first to avoid stacking both UIs simultaneously.
 */
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

/** Reads the `doomInstallDefaults` map from package.json — the settings Doom writes on install. */
function getInstallDefaults(context: vscode.ExtensionContext): Record<string, unknown> {
	const packageJson = context.extension.packageJSON as {
		doomInstallDefaults?: Record<string, unknown>;
	};

	return packageJson.doomInstallDefaults ?? {};
}

/** Reads the bundled `whichkey.bindings` default from package.json contributes, used to resolve startup command key paths. */
function getPackageWhichKeyBindings(context: vscode.ExtensionContext): unknown {
	const packageJson = context.extension.packageJSON as {
		contributes?: {
			configurationDefaults?: Record<string, unknown>;
		};
	};

	return packageJson.contributes?.configurationDefaults?.['whichkey.bindings'];
}

/** Parses `doomDashboard.startupCommandKeyPaths` from package.json into `string[][]` key path arrays. */
function getStartupCommandKeyPaths(context: vscode.ExtensionContext): string[][] {
	const packageJson = context.extension.packageJSON as {
		doomDashboard?: {
			startupCommandKeyPaths?: unknown;
		};
	};

	const configuredPaths = packageJson.doomDashboard?.startupCommandKeyPaths;
	if (!Array.isArray(configuredPaths)) {
		return [];
	}

	return configuredPaths.flatMap((entry) => {
		if (typeof entry !== 'string') {
			return [];
		}

		const keyPath = entry
			.split(/\s+/)
			.map((segment) => segment.trim())
			.filter((segment) => segment.length > 0);

		return keyPath.length > 0 ? [keyPath] : [];
	});
}

/**
 * Writes install defaults to the user's global settings, skipping user-owned keys.
 * Optionally shows a toast summarising applied/skipped/failed counts.
 */
async function applyDefaultsToUserSettings(
	defaults: Record<string, unknown>,
	showResultMessage = false,
	options: ApplyDefaultsOptions = {},
): Promise<ApplyDefaultsResult> {
	const config = vscode.workspace.getConfiguration();
	const result = await applyDefaultsToConfiguration(config, defaults, vscode.ConfigurationTarget.Global, options);

	if (showResultMessage) {
		if (result.total === 0) {
			void vscode.window.showWarningMessage("No Doom install defaults are configured in package.json.");
			return result;
		}

		const parts: string[] = [
			`${result.applied} applied`,
			`${result.skipped} skipped (already customized by you)`,
		];
		if (result.unsupported > 0) {
			parts.push(`${result.unsupported} not recognized by VS Code`);
		}
		if (result.failed > 0) {
			parts.push(`${result.failed} failed`);
		}
		const failureDetails = result.failures.length > 0
			? ` Failures: ${result.failures.slice(0, 3).map((failure) => (
				`${failure.key} (${failure.reason})`
			)).join('; ')}${result.failures.length > 3 ? `; +${result.failures.length - 3} more` : ''}.`
			: '';
		void vscode.window.showInformationMessage(
			`Doom defaults applied to your global User settings: ${parts.join(', ')}.${failureDetails}`
		);
	}

	return result;
}

function summarizeValueForUi(value: unknown, maxLength = 180): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		serialized = String(value);
	}

	return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 1)}…`;
}

function formatVimBindingChord(before: readonly string[]): string {
	return before.join(' ');
}

function createVimBindingConflictResolver(): ApplyDefaultsOptions['resolveVimBindingConflict'] {
	let rememberedDecision: VimBindingConflictDecision | undefined;

	return async (conflict: VimBindingConflict) => {
		if (rememberedDecision) {
			return rememberedDecision;
		}

		const choice = await vscode.window.showWarningMessage(
			`Doom Code: ${conflict.settingKey} already contains a binding for ${formatVimBindingChord(conflict.before)}.`,
			{
				modal: true,
				detail: [
					`Existing: ${conflict.existingEntries.map((entry) => summarizeValueForUi(entry)).join(' | ')}`,
					`Doom: ${summarizeValueForUi(conflict.defaultEntry)}`,
					'Keep existing preserves your current mapping. Overwrite replaces all conflicting bindings for this chord with Doom\'s default.',
				].join('\n'),
			},
			KEEP_EXISTING_BINDING_ACTION,
			OVERWRITE_WITH_DOOM_ACTION,
			KEEP_ALL_EXISTING_BINDINGS_ACTION,
			OVERWRITE_ALL_WITH_DOOM_ACTION,
		);

		if (choice === OVERWRITE_ALL_WITH_DOOM_ACTION) {
			rememberedDecision = 'overwrite';
			return 'overwrite';
		}

		if (choice === KEEP_ALL_EXISTING_BINDINGS_ACTION) {
			rememberedDecision = 'keep';
			return 'keep';
		}

		if (choice === OVERWRITE_WITH_DOOM_ACTION) {
			return 'overwrite';
		}

		return 'keep';
	};
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/** Returns the subset of `CONFLICTING_EXTENSIONS` that are currently installed. */
function detectConflictingExtensions(): typeof CONFLICTING_EXTENSIONS {
	return CONFLICTING_EXTENSIONS.filter(
		(ext) => vscode.extensions.getExtension(ext.id) !== undefined
	);
}

/** Shows a modal warning for each conflicting extension with an "Open Extensions" action. */
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
	if (!keybindingsPath) {
		return 0;
	}

	const bindings = readKeybindingsJson(keybindingsPath);
	if (!bindings) {
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

/**
 * Reads and parses a VS Code keybindings.json, tolerating single-line comments
 * and trailing commas. Returns the parsed array, or undefined if the file is
 * missing, unreadable, or malformed.
 */
function readKeybindingsJson(keybindingsPath: string): Array<Record<string, unknown>> | undefined {
	if (!fs.existsSync(keybindingsPath)) {
		return undefined;
	}
	try {
		const raw = fs.readFileSync(keybindingsPath, 'utf-8');
		const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
		const sanitized = stripped.replace(/,\s*([}\]])/g, '$1');
		const parsed = JSON.parse(sanitized);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Returns the magit-related keybindings from Doom's own contributes.keybindings:
 * entries scoped to the magit editor language and negation entries that disable
 * kahole.magit's default key assignments.
 */
function getDoomUserKeybindings(context: vscode.ExtensionContext): Array<Record<string, unknown>> {
	const doomKeybindings = (context.extension.packageJSON as {
		contributes?: { keybindings?: Array<Record<string, unknown>> };
	}).contributes?.keybindings;

	if (!Array.isArray(doomKeybindings)) {
		return [];
	}

	const magitKeybindings = doomKeybindings.filter((kb) => {
		const when = kb['when'];
		return typeof when === 'string' && when.includes("editorLangId == 'magit'");
	});

	// Negation entries that disable kahole.magit's default key assignments.
	const negationKeybindings = doomKeybindings.filter((kb) => {
		const cmd = kb['command'];
		return typeof cmd === 'string' && cmd.startsWith('-magit.');
	});

	return [...magitKeybindings, ...negationKeybindings];
}

/**
 * Read the user keybindings.json, add any magit-related keybindings declared
 * in Doom's own contributes.keybindings that are not already present, and
 * write back.  User-level keybindings have higher precedence than all
 * extension keybindings, which is necessary for magit.dispatch to display the
 * correct key hints.
 * Returns the number of keybindings added.
 */
async function installDoomKeybindings(context: vscode.ExtensionContext): Promise<number> {
	const allMagitRelated = getDoomUserKeybindings(context);

	if (allMagitRelated.length === 0) {
		return 0;
	}

	const keybindingsPath = getKeybindingsPath(context);
	if (!keybindingsPath) {
		return 0;
	}

	let existing: Array<Record<string, unknown>> = [];
	let rawContent: string | undefined;
	if (fs.existsSync(keybindingsPath)) {
		try {
			rawContent = fs.readFileSync(keybindingsPath, 'utf-8');
		} catch {
			console.warn("Doom Code: could not read keybindings.json, skipping magit install.");
			return 0;
		}
		const parsed = readKeybindingsJson(keybindingsPath);
		if (parsed === undefined) {
			console.warn("Doom Code: could not parse keybindings.json, skipping magit install.");
			return 0;
		}
		existing = parsed;
	}

	const toAdd = allMagitRelated.filter((kb) =>
		!existing.some((e) => e['key'] === kb['key'] && e['command'] === kb['command'] && e['when'] === kb['when']),
	);

	if (toAdd.length === 0) {
		return 0;
	}

	let output: string;
	const newEntries = toAdd.map((kb) => '\t' + JSON.stringify(kb)).join(',\n');
	const block = '\t// #region Doom Code keybindings\n' + newEntries + '\n\t// #endregion Doom Code keybindings';

	if (rawContent !== undefined && existing.length > 0) {
		// Append to existing file — preserve original content and comments.
		const lastBracket = rawContent.lastIndexOf(']');
		if (lastBracket !== -1) {
			const beforeBracket = rawContent.slice(0, lastBracket).trimEnd();
			const rest = rawContent.slice(lastBracket + 1);
			output = beforeBracket + ',\n' + block + '\n]' + rest;
		} else {
			// Malformed — fall back to full rewrite.
			output = "// Place your key bindings in this file to override the defaults\n"
				+ JSON.stringify([...existing, ...toAdd], null, '\t')
				+ '\n';
		}
	} else {
		// File doesn't exist or is empty — write fresh.
		output = "// Place your key bindings in this file to override the defaults\n[\n"
			+ block
			+ '\n]\n';
	}

	try {
		fs.mkdirSync(path.dirname(keybindingsPath), { recursive: true });
		fs.writeFileSync(keybindingsPath, output, 'utf-8');
	} catch (err) {
		console.warn("Doom Code: failed to write magit keybindings to keybindings.json:", err);
		return 0;
	}

	return toAdd.length;
}

// ---------------------------------------------------------------------------
// Detection-only check (reads state, never mutates)
// ---------------------------------------------------------------------------

interface StaleDetectionResult {
	conflicts: typeof CONFLICTING_EXTENSIONS;
	hasStaleSettings: boolean;
	hasStaleKeybindings: boolean;
	hasMagitKeybindings: boolean;
}

/** Read-only stale detection: scans vim settings and keybindings.json without writing anything. */
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

	const keybindingsPath = getKeybindingsPath(context);
	const parsedKeybindings = keybindingsPath ? readKeybindingsJson(keybindingsPath) : undefined;

	const hasStaleKeybindings = parsedKeybindings?.some((entry) => {
		const cmd = (entry as { command?: string }).command;
		return typeof cmd === 'string'
			&& !cmd.startsWith('-')
			&& STALE_COMMAND_PREFIXES.some((p) => cmd.startsWith(p));
	}) ?? false;

	const magitKbs = getDoomUserKeybindings(context);
	const hasMagitKeybindings = magitKbs.length > 0 && parsedKeybindings !== undefined
		? magitKbs.every((kb) =>
			parsedKeybindings.some((e) => e['key'] === kb['key'] && e['command'] === kb['command'] && e['when'] === kb['when'])
		)
		: false;

	return { conflicts, hasStaleSettings, hasStaleKeybindings, hasMagitKeybindings };
}

// ---------------------------------------------------------------------------
// Full cleanup — mutating path (manual command or user-confirmed)
// ---------------------------------------------------------------------------

/** Runs both setting and keybinding cleanup, then shows a summary toast with a "Reload" action. */
async function runCleanup(context: vscode.ExtensionContext): Promise<void> {
	const cleanedSettings = await cleanStaleSettings();
	const removedKeybindings = await cleanStaleKeybindings(context);

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

/** Extracts version and repository URL from package.json for display in the start page. */
function getExtensionMetadata(context: vscode.ExtensionContext): {
	version: string;
	repositoryUrl?: string;
} {
	const packageJson = context.extension.packageJSON as {
		version?: string;
		repository?: { url?: string };
	};

	return {
		version: packageJson.version ?? '0.0.0',
		repositoryUrl: packageJson.repository?.url,
	};
}

/** Assembles the full `DoomDashboardState` by combining config inspection, stale detection, and binding resolution. */
function createDashboardState(
	context: vscode.ExtensionContext,
	mode: ReturnType<typeof detectDashboardMode>,
	installDefaults: Record<string, unknown>,
): Parameters<DoomDashboard['show']>[0] {
	const configuration = vscode.workspace.getConfiguration();
	const staleState = detectStaleState(context);
	const metadata = getExtensionMetadata(context);
	const installState = evaluateInstalledDefaults(installDefaults, (key) => configuration.inspect(key));
	const startupCommands = resolveStartupCommandsFromBindings(
		getPackageWhichKeyBindings(context),
		getStartupCommandKeyPaths(context),
	);

	return {
		mode,
		currentVersion: metadata.version,
		defaultCount: Object.keys(installDefaults).length,
		installedDefaultCount: installState.matchingDefaults,
		hasInstalledDefaults: installState.isInstalled,
		hasMagitKeybindings: staleState.hasMagitKeybindings,
		hasStaleSettings: staleState.hasStaleSettings,
		hasStaleKeybindings: staleState.hasStaleKeybindings,
		openOnActivation: configuration.get<boolean>(DASHBOARD_OPEN_ON_ACTIVATION_SETTING, true),
		startupCommands,
		conflicts: staleState.conflicts.map((conflict) => ({
			name: conflict.name,
			reason: conflict.reason,
		})),
		repositoryUrl: metadata.repositoryUrl,
	};
}

/** Builds state and reveals the start page panel. */
async function showDashboard(
	context: vscode.ExtensionContext,
	dashboard: DoomDashboard,
	mode: ReturnType<typeof detectDashboardMode>,
	installDefaults: Record<string, unknown>,
): Promise<void> {
	dashboard.show(createDashboardState(context, mode, installDefaults));
}

/** Re-renders the dashboard with fresh state if it's currently open. No-op if the page was never shown. */
function refreshDashboardIfOpen(
	context: vscode.ExtensionContext,
	dashboard: DoomDashboard,
	installDefaults: Record<string, unknown>,
): void {
	const mode = dashboard.getCurrentMode();
	if (!mode) {
		return;
	}

	dashboard.refresh(createDashboardState(context, mode, installDefaults));
}

// ---------------------------------------------------------------------------
// Which-key migration
// ---------------------------------------------------------------------------

/** One-time migration: rewrites `whichkey.show` → `doom.whichKeyShow` in user vim keybindings so SPC still works after install. */
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

/**
 * Extension entry point. Wires all commands, panel providers, and event listeners,
 * then asynchronously persists workspace history and optionally shows the start page.
 */
export function activate(context: vscode.ExtensionContext) {
	const installDefaults = getInstallDefaults(context);
	const dashboardRefreshKeys = [
		WHICH_KEY_MENU_SETTING,
		DASHBOARD_OPEN_ON_ACTIVATION_SETTING,
		...Object.keys(installDefaults),
	];
	const fuzzySearchPanel = new DoomFuzzySearchPanel();

	/** Opens a project folder in the current window and suppresses the dashboard on the next activation. */
	const openProjectAndSkipDashboard = async (projectUri: vscode.Uri): Promise<void> => {
		await context.globalState.update(SKIP_DASHBOARD_KEY, true);
		await vscode.commands.executeCommand('vscode.openFolder', projectUri, { forceReuseWindow: true });
	};
	const whichKeyMenu = new DoomWhichKeyMenu();
	const dashboard = new DoomDashboard(context.extensionUri);
	let dashboardRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	// Debounced refresh so rapid config changes (e.g. bulk settings apply) don't re-render on every key.
	const scheduleDashboardRefresh = (delayMs = 50) => {
		if (!dashboard.getCurrentMode()) {
			return;
		}

		if (dashboardRefreshTimer) {
			clearTimeout(dashboardRefreshTimer);
		}

		dashboardRefreshTimer = setTimeout(() => {
			dashboardRefreshTimer = undefined;
			refreshDashboardIfOpen(context, dashboard, installDefaults);
		}, delayMs);
	};
	registerWindowMru(context);
	const selectionHistory = new SelectionHistory(context.globalState);
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (doc.uri.scheme === 'file' && !doc.isUntitled) {
				selectionHistory.recordIfNewer(doc.uri.fsPath, Date.now());
			}
		})
	);
	const openEditorsPanel = new DoomOpenEditorsPanel();
	const whichKeyBindingsPanel = new DoomWhichKeyBindingsPanel();
	const projectFilePanel = new DoomProjectFilePanel(selectionHistory);
	const recentProjectsPanel = new DoomRecentProjectsPanel();
	const findFilePanel = new DoomFindFilePanel(selectionHistory);
	const sharedPanel = new DoomSharedPanel(
		whichKeyMenu,
		fuzzySearchPanel,
		openEditorsPanel,
		whichKeyBindingsPanel,
		projectFilePanel,
		recentProjectsPanel,
		findFilePanel,
	);

	// Manual install command
	const installCmd = vscode.commands.registerCommand(
		"doom.install",
		async () => {
			const result = await runInstallFlow(
				async () => {
					const choice = await vscode.window.showWarningMessage(
						"Apply Doom default settings and keybindings to your User settings? Existing user-owned values stay untouched unless you choose to overwrite a conflicting Doom Vim binding.",
						{ modal: true },
						"Apply"
					);
					return choice === "Apply";
				},
				async () => {
					await migrateLegacyWhichKeyShowBindings();
					const settingsResult = await applyDefaultsToUserSettings(installDefaults, true, {
						resolveVimBindingConflict: createVimBindingConflictResolver(),
					});
					const addedKeybindings = await installDoomKeybindings(context);
					if (addedKeybindings > 0) {
						void vscode.window.showInformationMessage(
							`Doom Code: installed ${addedKeybindings} magit keybinding(s) into keybindings.json so the magit dispatch recognises them.`
						);
					}
					return settingsResult;
				},
			);

			if (!result) {
				return;
			}

			scheduleDashboardRefresh(0);
		}
	);

	// Manual cleanup command
	const cleanupCmd = vscode.commands.registerCommand(
		"doom.cleanup",
		async () => {
			const choice = await vscode.window.showWarningMessage(
				"This will remove stale settings and keybindings left behind by conflicting extensions (e.g. vspacecode.* commands) from your User settings.json and keybindings.json. Note: keybindings.json will be rewritten — all comments and custom formatting will be lost. This cannot be undone.",
				{ modal: true },
				"Clean Up"
			);
			if (choice !== "Clean Up") {
				return;
			}
			const conflicts = detectConflictingExtensions();
			if (conflicts.length > 0) {
				await warnAboutConflicts(conflicts);
			}
			await runCleanup(context);
			scheduleDashboardRefresh(0);
		}
	);

	const showDashboardCmd = vscode.commands.registerCommand(
		"doom.dashboard",
		async () => {
			await showDashboard(context, dashboard, 'startup', installDefaults);
		}
	);

	const reloadLastSessionCmd = vscode.commands.registerCommand(
		"doom.reloadLastSession",
		async () => {
			await reloadLastSession(context);
		}
	);

	const whichKeyCmd = vscode.commands.registerCommand(
		"doom.whichKeyShow",
		(showContext?: { terminalFocus?: boolean; terminalPanelOpen?: boolean; explorerVisible?: boolean; explorerFocused?: boolean; webviewFocused?: boolean }) => {
			if (getWhichKeyMenuStyle() === 'vspacecode') {
				whichKeyMenu.prepareShow(showContext);
				void showConfiguredWhichKeyMenu(whichKeyMenu, sharedPanel);
				return;
			}

			if (whichKeyMenu.isCurrentlyShowing) {
				whichKeyMenu.queueKey('SPC');
				return;
			}

			void sharedPanel.showWhichKeyWithContext(showContext);
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

	// Keys pressed while `whichkeyVisible` is true but before the webview has focus are
	// routed here by the `whichkey.triggerKey` keybindings in package.json. Without this
	// handler those keys were silently swallowed (no registered command = no-op), causing
	// rapid chords to be lost — especially on Windows where the focus-transition window is
	// larger. Queuing them here lets the host replay them once the first render fires.
	const whichKeyTriggerKeyCmd = vscode.commands.registerCommand(
		'doom.triggerKey',
		(args: string | { key: string; when?: string } | undefined) => {
			const raw = typeof args === 'string' ? args : (args?.key ?? '');
			if (!raw || !whichKeyMenu.isCurrentlyShowing) {
				return;
			}
			const key = raw === ' ' ? 'SPC' : raw === '\t' ? 'TAB' : raw;
			whichKeyMenu.queueKey(key);
		}
	);

	const whichKeyHideCmd = vscode.commands.registerCommand(
		"doom.whichKeyHide",
		() => {
			void whichKeyMenu.hide();
		}
	);

	const sidebarHideCmd = vscode.commands.registerCommand(
		"doom.sidebarHide",
		async () => {
			whichKeyMenu.trackContextCommand('workbench.action.toggleSidebarVisibility');
			await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
		}
	);

	const panelHideCmd = vscode.commands.registerCommand(
		"doom.panelHide",
		async () => {
			whichKeyMenu.trackContextCommand('workbench.action.togglePanel');
			await vscode.commands.executeCommand('workbench.action.togglePanel');
		}
	);

	const VTERM_NAME = '*vterm*';
	const VTERM_PREFIX = '*vterm*';
	const EDITOR_TERMINAL_NAMES = new Set(['codex', 'claude', 'claude code', 'copilot']);

	const isVtermName = (name: string) =>
		name === VTERM_NAME
		|| name.startsWith(`${VTERM_PREFIX}<`)
		|| EDITOR_TERMINAL_NAMES.has(name.toLowerCase());

	const managedVtermSet = new Set<vscode.Terminal>();

	/** Creates a named editor-group terminal so `doom.openPanelTerminal` can exclude it by name. */
	const createTerminalEditorCmd = vscode.commands.registerCommand(
		"doom.createTerminalEditor",
		async () => {
			const vtermCount = vscode.window.terminals.filter((t) => isVtermName(t.name)).length;
			const name = vtermCount === 0 ? VTERM_NAME : `${VTERM_PREFIX}<${vtermCount + 1}>`;
			const terminal = vscode.window.createTerminal({
				name,
				location: vscode.TerminalLocation.Editor,
			});
			managedVtermSet.add(terminal);
			terminal.show();
			// Lock the title so the shell (bash PROMPT_COMMAND / PS1) cannot override it
			await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
		}
	);

	/**
	 * Opens AI tool CLIs in editor terminals with fixed names.
	 * Each terminal gets a consistent name ('claude', 'copilot', 'codex') so that:
	 * - They're recognized by isVtermName() and excluded from panel terminal switching (SPC o t)
	 * - Users can reliably find CLI terminals by name
	 * Creates a new terminal each trigger (no reuse).
	 */

	const openClaudeCliCmd = vscode.commands.registerCommand(
		"doom.openClaudeCli",
		async () => {
			const terminal = vscode.window.createTerminal({
				name: 'claude',
				location: vscode.TerminalLocation.Editor,
			});
			terminal.show();
			await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'claude' });
			terminal.sendText('claude');
		}
	);

	const openCopilotCliCmd = vscode.commands.registerCommand(
		"doom.openCopilotCli",
		async () => {
			const terminal = vscode.window.createTerminal({
				name: 'copilot',
				location: vscode.TerminalLocation.Editor,
			});
			terminal.show();
			await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'copilot' });
			terminal.sendText('copilot');
		}
	);

	const openCodexCliCmd = vscode.commands.registerCommand(
		"doom.openCodexCli",
		async () => {
			const terminal = vscode.window.createTerminal({
				name: 'codex',
				location: vscode.TerminalLocation.Editor,
			});
			terminal.show();
			await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'codex' });
			terminal.sendText('codex');
		}
	);

	/**
	 * Opens the panel terminal without disturbing terminals in editor groups.
	 * Editor terminals created via `doom.createTerminalEditor` are named `*vterm*` or `*vterm*<N>`.
	 * Known CLI editor terminals such as `codex` and `claude code` are also excluded by name.
	 * Panel terminals are anything not carrying those names.
	 * Falls back to creating a new panel terminal only when none exist.
	 * Uses show(true) to pre-select the terminal, then workbench.view.terminal to reliably
	 * open the panel — terminal.show() alone doesn't guarantee the panel opens.
	 */
	const openPanelTerminalCmd = vscode.commands.registerCommand(
		"doom.openPanelTerminal",
		() => {
			const panelTerminals = vscode.window.terminals.filter((t) => !isVtermName(t.name));

			if (panelTerminals.length > 0) {
				panelTerminals[panelTerminals.length - 1].show(false);
			} else {
				vscode.window.createTerminal({ location: vscode.TerminalLocation.Panel }).show(false);
			}
		}
	);

	const windowDeleteCmd = vscode.commands.registerCommand(
		"doom.windowDelete",
		async () => {
			const activeGroup = vscode.window.tabGroups.activeTabGroup;
			const activeTerminalEditor = activeGroup.activeTab?.input instanceof vscode.TabInputTerminal;
			const action = resolveWindowDeleteAction(
				whichKeyMenu.showContext.terminalFocus,
				activeTerminalEditor,
			);

			if (action === 'closePanel') {
				await vscode.commands.executeCommand('workbench.action.closePanel');
				return;
			}

			if (action === 'moveTerminalEditorToPanelAndCloseGroup') {
				await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
				await focusEditorGroup(activeGroup.viewColumn);
				await vscode.commands.executeCommand('workbench.action.closeGroup');
				return;
			}

			// Use the group that was active when whichkey opened (preWhichKeyEditorGroupColumn is set
			// during whichkey command execution and undefined for direct invocations). This avoids
			// relying on workbench.action.closeGroup honouring focus, which VS Code does not guarantee
			// after the whichkey panel closes.
			const targetColumn = whichKeyMenu.preWhichKeyEditorGroupColumn ?? activeGroup.viewColumn;
			const groupToClose = vscode.window.tabGroups.all.find(g => g.viewColumn === targetColumn)
				?? activeGroup;
			await vscode.window.tabGroups.close(groupToClose);
		}
	);

	const configurationChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(WHICH_KEY_MENU_SETTING) && getWhichKeyMenuStyle() === 'vspacecode') {
			void whichKeyMenu.hide();
		}

		if (dashboardRefreshKeys.some((key) => event.affectsConfiguration(key))) {
			scheduleDashboardRefresh();
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

	const findFileInProjectCmd = vscode.commands.registerCommand(
		'doom.findFileInProject',
		() => {
			void sharedPanel.showProjectFiles(openProjectAndSkipDashboard);
		}
	);

	const findFileCmd = vscode.commands.registerCommand(
		'doom.findFile',
		() => {
			const activeUri = vscode.window.activeTextEditor?.document.uri;
			let startUri: vscode.Uri;
			if (activeUri && activeUri.scheme !== 'untitled' && activeUri.scheme !== 'git') {
				const parentPath = activeUri.path.replace(/\/[^/]+$/, '/');
				startUri = activeUri.with({ path: parentPath.endsWith('/') ? parentPath : parentPath + '/' });
			} else if (vscode.workspace.workspaceFolders?.length) {
				const folderUri = vscode.workspace.workspaceFolders[0].uri;
				startUri = folderUri.with({ path: folderUri.path.endsWith('/') ? folderUri.path : folderUri.path + '/' });
			} else {
				startUri = vscode.Uri.file(os.homedir().replace(/\\/g, '/') + '/');
			}
			void sharedPanel.showFindFile(startUri);
		}
	);

	const findFileMoveDownCmd = vscode.commands.registerCommand(
		'doom.findFileMoveDown',
		() => {
			void findFilePanel.moveSelection(1);
		}
	);

	const findFileMoveUpCmd = vscode.commands.registerCommand(
		'doom.findFileMoveUp',
		() => {
			void findFilePanel.moveSelection(-1);
		}
	);

	const showRecentProjectsCmd = vscode.commands.registerCommand(
		'doom.showRecentProjects',
		() => {
			void sharedPanel.showRecentProjectsForFilePick(openProjectAndSkipDashboard);
		}
	);

	const recentProjectsMoveDownCmd = vscode.commands.registerCommand(
		'doom.recentProjectsMoveDown',
		() => {
			void recentProjectsPanel.moveSelection(1);
		}
	);

	const recentProjectsMoveUpCmd = vscode.commands.registerCommand(
		'doom.recentProjectsMoveUp',
		() => {
			void recentProjectsPanel.moveSelection(-1);
		}
	);

	const projectFileMoveDownCmd = vscode.commands.registerCommand(
		'doom.projectFileMoveDown',
		() => {
			void projectFilePanel.moveSelection(1);
		}
	);

	const projectFileMoveUpCmd = vscode.commands.registerCommand(
		'doom.projectFileMoveUp',
		() => {
			void projectFilePanel.moveSelection(-1);
		}
	);

	const openEditorsCmd = vscode.commands.registerCommand(
		"doom.showOpenEditors",
		() => {
			void sharedPanel.showOpenEditors();
		}
	);

	const allOpenEditorsCmd = vscode.commands.registerCommand(
		"doom.showAllOpenEditors",
		() => {
			void sharedPanel.showAllOpenEditors();
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

	void (async () => {
		await persistWorkspaceHistory(context);

		// If a file was queued before a folder reload (cross-project file-pick flow), open it now.
		// Skip the start page for this activation — the user already knows what they want to open.
		const pendingFile = context.globalState.get<string>(PENDING_OPEN_FILE_KEY);
		if (pendingFile) {
			await context.globalState.update(PENDING_OPEN_FILE_KEY, undefined);
			await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			try {
				const fileUri = vscode.Uri.parse(pendingFile, true);
				const document = await vscode.workspace.openTextDocument(fileUri);
				await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
			} catch {
				// File may have moved or be outside the workspace — silently skip.
			}

			await context.globalState.update(LAST_SEEN_VERSION_KEY, getExtensionMetadata(context).version);
			return;
		}

		if (context.globalState.get<boolean>(SKIP_DASHBOARD_KEY)) {
			await context.globalState.update(SKIP_DASHBOARD_KEY, undefined);
			await context.globalState.update(LAST_SEEN_VERSION_KEY, getExtensionMetadata(context).version);
			return;
		}

		const metadata = getExtensionMetadata(context);
		const previousVersion = context.globalState.get<string>(LAST_SEEN_VERSION_KEY);
		const shouldOpenDashboard = vscode.workspace
			.getConfiguration()
			.get<boolean>(DASHBOARD_OPEN_ON_ACTIVATION_SETTING, true);

		if (shouldOpenDashboard) {
			await showDashboard(
				context,
				dashboard,
				detectDashboardMode(previousVersion, metadata.version),
				installDefaults,
			);
		}

		await context.globalState.update(LAST_SEEN_VERSION_KEY, metadata.version);
	})();

	context.subscriptions.push(
		installCmd,
		cleanupCmd,
		showDashboardCmd,
		reloadLastSessionCmd,
		whichKeyCmd,
		whichKeyBindingsCmd,
		whichKeyTriggerKeyCmd,
		whichKeyHideCmd,
		sidebarHideCmd,
		panelHideCmd,
		createTerminalEditorCmd,
		openClaudeCliCmd,
		openCopilotCliCmd,
		openCodexCliCmd,
		openPanelTerminalCmd,
		windowDeleteCmd,
		configurationChangeListener,
		fuzzySearchCmd,
		workspaceFuzzySearchCmd,
		openEditorsCmd,
		allOpenEditorsCmd,
		findFileCmd,
		findFileMoveDownCmd,
		findFileMoveUpCmd,
		findFileInProjectCmd,
		showRecentProjectsCmd,
		recentProjectsMoveDownCmd,
		recentProjectsMoveUpCmd,
		projectFileMoveDownCmd,
		projectFileMoveUpCmd,
		sharedPanelViewProvider,
		new vscode.Disposable(() => {
			if (dashboardRefreshTimer) {
				clearTimeout(dashboardRefreshTimer);
			}
		}),
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }
