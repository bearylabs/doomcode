// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
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
	getDoomUserKeybindings,
	getKeybindingsPath,
	readKeybindingsJson,
} from './onboarding/keybindingsFile';
import {
	CONFLICTING_EXTENSIONS,
	detectConflictingExtensions,
	register as registerOnboardingCommands,
} from './onboarding/onboardingCommands';
import {
	containsStaleCommand,
	STALE_COMMAND_PREFIXES,
} from './onboarding/staleCleanup';
import { DOOM_STALE_VIM_BINDING_SETTINGS } from './onboarding/vimBindings';
import { DoomSharedPanel } from './panel/shared';
import { DoomFindFilePanel } from './search/findFile';
import { DoomSearchPanel } from './search/search';
import { DoomProjectFilePanel } from './search/projectFile';
import { DoomRecentProjectsPanel } from './search/recentProjects';
import { SelectionHistory } from './search/selectionHistory';
import { WorkspaceFileIndex } from './search/workspaceFileIndex';
import * as terminalCommands from './terminal/terminalCommands';
import { DoomWhichKeyBindingsPanel } from './whichkey/bindingsPanel';
import { DoomWhichKeyMenu } from './whichkey/menu';
import { showWhichKeyBindingsQuickPick } from './whichkey/showBindings';
import { registerWindowMru } from './window/mru';
import * as windowCommands from './window/windowCommands';

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

const TERMINAL_ESCAPE_TIMEOUT_MS = 2000;
const DASHBOARD_REFRESH_DEBOUNCE_MS = 50;

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
	const keysToCheck = DOOM_STALE_VIM_BINDING_SETTINGS;

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
	const workspaceFileIndex = new WorkspaceFileIndex();
	context.subscriptions.push(workspaceFileIndex);
	const searchPanel = new DoomSearchPanel(workspaceFileIndex);

	/** Opens a project folder in the current window and suppresses the dashboard on the next activation. */
	const openProjectAndSkipDashboard = async (projectUri: vscode.Uri): Promise<void> => {
		await context.globalState.update(SKIP_DASHBOARD_KEY, true);
		await vscode.commands.executeCommand('vscode.openFolder', projectUri, { forceReuseWindow: true });
	};
	const whichKeyMenu = new DoomWhichKeyMenu(context.extension.packageJSON as { contributes?: { keybindings?: unknown[] } });
	const dashboard = new DoomDashboard(context.extensionUri);
	let dashboardRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let terminalEscapeTimer: ReturnType<typeof setTimeout> | undefined;
	// Debounced refresh so rapid config changes (e.g. bulk settings apply) don't re-render on every key.
	const scheduleDashboardRefresh = (delayMs = DASHBOARD_REFRESH_DEBOUNCE_MS) => {
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
	const projectFilePanel = new DoomProjectFilePanel(selectionHistory, workspaceFileIndex);
	const recentProjectsPanel = new DoomRecentProjectsPanel();
	const findFilePanel = new DoomFindFilePanel(selectionHistory);
	const sharedPanel = new DoomSharedPanel(
		whichKeyMenu,
		searchPanel,
		openEditorsPanel,
		whichKeyBindingsPanel,
		projectFilePanel,
		recentProjectsPanel,
		findFilePanel,
	);

	registerOnboardingCommands(context, {
		installDefaults,
		scheduleDashboardRefresh,
		showStartupDashboard: () => showDashboard(context, dashboard, 'startup', installDefaults),
	});

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

	const terminalEscapePrefixCmd = vscode.commands.registerCommand(
		'doom.terminalEscapePrefix',
		() => {
			if (terminalEscapeTimer) { clearTimeout(terminalEscapeTimer); }
			void vscode.commands.executeCommand('setContext', 'doom.terminalEscapeMode', true);
			terminalEscapeTimer = setTimeout(() => {
				terminalEscapeTimer = undefined;
				void vscode.commands.executeCommand('setContext', 'doom.terminalEscapeMode', false);
			}, TERMINAL_ESCAPE_TIMEOUT_MS);
		}
	);

	const terminalEscapeSpaceCmd = vscode.commands.registerCommand(
		'doom.terminalEscapeSpace',
		(showContext?: { terminalFocus?: boolean; terminalPanelOpen?: boolean; explorerVisible?: boolean }) => {
			if (terminalEscapeTimer) { clearTimeout(terminalEscapeTimer); terminalEscapeTimer = undefined; }
			void vscode.commands.executeCommand('setContext', 'doom.terminalEscapeMode', false);
			void sharedPanel.showWhichKeyWithContext(showContext);
		}
	);

	const terminalSendEscapeCmd = vscode.commands.registerCommand(
		'doom.terminalSendEscape',
		() => {
			if (terminalEscapeTimer) { clearTimeout(terminalEscapeTimer); terminalEscapeTimer = undefined; }
			void vscode.commands.executeCommand('setContext', 'doom.terminalEscapeMode', false);
			void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\u001b' });
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

	terminalCommands.register(context);
	windowCommands.register(context, { whichKeyMenu });

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

	const showRecentProjectsCmd = vscode.commands.registerCommand(
		'doom.showRecentProjects',
		() => {
			void sharedPanel.showRecentProjectsForFilePick(openProjectAndSkipDashboard);
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
			} catch (err) {
				// File may have moved or be outside the workspace — silently skip.
				console.warn('[Doom] pendingOpenFile failed to open:', err);
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
		reloadLastSessionCmd,
		whichKeyCmd,
		whichKeyBindingsCmd,
		whichKeyTriggerKeyCmd,
		whichKeyHideCmd,
		terminalEscapePrefixCmd,
		terminalEscapeSpaceCmd,
		terminalSendEscapeCmd,
		sidebarHideCmd,
		panelHideCmd,
		configurationChangeListener,
		fuzzySearchCmd,
		workspaceFuzzySearchCmd,
		openEditorsCmd,
		allOpenEditorsCmd,
		findFileCmd,
		findFileInProjectCmd,
		showRecentProjectsCmd,
		sharedPanelViewProvider,
		new vscode.Disposable(() => {
			if (dashboardRefreshTimer) {
				clearTimeout(dashboardRefreshTimer);
			}
			if (terminalEscapeTimer) {
				clearTimeout(terminalEscapeTimer);
			}
		}),
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }
