import * as vscode from 'vscode';
import { DoomOpenEditorsPanel } from '../buffers/openEditors';
import { DoomFindFilePanel } from '../search/findFile';
import { DoomFuzzySearchPanel } from '../search/fuzzy';
import { DoomProjectFilePanel } from '../search/projectFile';
import { DoomRecentProjectsPanel } from '../search/recentProjects';
import { DoomWhichKeyBindingsPanel } from '../whichkey/bindingsPanel';
import { DoomWhichKeyMenu } from '../whichkey/menu';

// ---------------------------------------------------------------------------
// Shared panel modes
// ---------------------------------------------------------------------------

type SharedPanelMode = 'bindings' | 'buffers' | 'findFile' | 'project' | 'recent' | 'search' | 'whichkey';

interface SharedPanelController {
	attachToView(webviewView: vscode.WebviewView): void;
	detachFromView(): void;
}

// ---------------------------------------------------------------------------
// Shared panel host
// ---------------------------------------------------------------------------

export class DoomSharedPanel implements vscode.WebviewViewProvider {
	static readonly containerId = 'doomPanel';
	static readonly viewId = 'doom.panelView';

	private activeController: SharedPanelController | undefined;
	private activeMode: SharedPanelMode | undefined;
	private pendingViewResolvers: Array<(view: vscode.WebviewView) => void> = [];
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly whichKeyMenu: DoomWhichKeyMenu,
		private readonly fuzzySearchPanel: DoomFuzzySearchPanel,
		private readonly openEditorsPanel: DoomOpenEditorsPanel,
		private readonly whichKeyBindingsPanel: DoomWhichKeyBindingsPanel,
		private readonly projectFilePanel: DoomProjectFilePanel,
		private readonly recentProjectsPanel: DoomRecentProjectsPanel,
		private readonly findFilePanel: DoomFindFilePanel,
	) {}

	/**
	 * Called by VS Code when the panel view is first created or restored.
	 * Flushes any pending `waitForView` promises, then hands the view to the active
	 * controller or renders the idle placeholder if nothing is active yet.
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.pendingViewResolvers.forEach((resolve) => resolve(webviewView));
		this.pendingViewResolvers = [];

		webviewView.onDidDispose(() => {
			if (this.view !== webviewView) {
				return;
			}

			this.activeController?.detachFromView();
			this.view = undefined;
			void this.syncVisibilityContexts(false);
		});

		webviewView.onDidChangeVisibility(() => {
			void this.syncVisibilityContexts(webviewView.visible);
		});

		if (this.activeController) {
			this.activeController.attachToView(webviewView);
		} else {
			webviewView.title = 'Doom';
			webviewView.description = 'Run Doom command';
			webviewView.webview.options = {
				enableScripts: false,
			};
			webviewView.webview.html = this.getPlaceholderHtml();
		}

		void this.syncVisibilityContexts(webviewView.visible);
	}

	/** Opens which-key without any context overrides (editor focus assumed). */
	private getIdleDelay(): number {
		return vscode.workspace
			.getConfiguration()
			.get<number>('doom.whichKey.idleDelay', 1.0);
	}

	private async runWithIdleDelay(menu: DoomWhichKeyMenu): Promise<void> {
		const delay = this.getIdleDelay();

		// Skip the idle delay when the terminal has focus — keys typed during the delay
		// would reach the terminal process before whichkeyVisible propagates to the renderer.
		// alt+space from the terminal is already a deliberate gesture; open the panel immediately.
		if (delay <= 0 || menu.showContext.terminalFocus) {
			await this.showMode('whichkey', menu);
			return;
		}

		const deadline = Date.now() + delay * 1000;

		// Reactive loop: re-evaluate on every key arrival.
		// Execute immediately on a leaf; show panel immediately on an unrecognised key;
		// only fall through to show panel when the timer expires with the queue exhausted.
		while (true) {
			const resolution = menu.resolveQueuedKeys();

			if (resolution.type === 'execute') {
				await menu.executeBinding(resolution.binding);
				return;
			}

			// An unrecognised key was left in the queue — show panel immediately.
			if (menu.hasPendingKeys) {
				menu.setNavigationStack(resolution.stack);
				await this.showMode('whichkey', menu);
				return;
			}

			// Queue exhausted mid-group — commit the walked depth and wait for the next key or timeout.
			menu.setNavigationStack(resolution.stack);

			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				await this.showMode('whichkey', menu);
				return;
			}

			const gotKey = await Promise.race([
				menu.waitForNextKey().then(() => true as const),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), remaining)),
			]);

			if (!gotKey) {
				await this.showMode('whichkey', menu);
				return;
			}
		}
	}

	async showWhichKey(): Promise<void> {
		this.whichKeyMenu.prepareShow();
		// Hoist whichkeyVisible=true before the idle delay so doom.triggerKey keybindings
		// activate immediately and buffer fast chords (e.g. SPC b on Windows).
		await vscode.commands.executeCommand('setContext', DoomWhichKeyMenu.visibleContextKey, true);
		await this.runWithIdleDelay(this.whichKeyMenu);
	}

	/** Opens which-key with an explicit context (e.g. terminal focus) so conditional bindings resolve correctly. */
	async showWhichKeyWithContext(showContext?: { terminalFocus?: boolean; terminalPanelOpen?: boolean; explorerVisible?: boolean }): Promise<void> {
		this.whichKeyMenu.prepareShow(showContext);
		// Hoist whichkeyVisible=true before the idle delay so doom.triggerKey keybindings
		// activate immediately and buffer fast chords (e.g. SPC b on Windows).
		await vscode.commands.executeCommand('setContext', DoomWhichKeyMenu.visibleContextKey, true);
		await this.runWithIdleDelay(this.whichKeyMenu);
	}

	/** Opens fuzzy search for the active editor. No-op if no editor is open. */
	async showFuzzySearch(): Promise<void> {
		if (!this.fuzzySearchPanel.prepareShow()) {
			return;
		}

		await this.showMode('search', this.fuzzySearchPanel);
	}

	/** Opens workspace search, then kicks off file indexing after the panel is visible. No-op if no folder is open. */
	async showWorkspaceSearch(): Promise<void> {
		if (!this.fuzzySearchPanel.prepareShowWorkspace()) {
			return;
		}

		await this.showMode('search', this.fuzzySearchPanel);
		await this.fuzzySearchPanel.loadPreparedWorkspaceItems();
	}

	/** Opens the buffer/open-editors picker. */
	async showOpenEditors(): Promise<void> {
		this.openEditorsPanel.prepareShow();
		await this.showMode('buffers', this.openEditorsPanel);
	}

	/** Opens the buffer/open-editors picker without any filter. */
	async showAllOpenEditors(): Promise<void> {
		this.openEditorsPanel.prepareShow(true, false);
		await this.showMode('buffers', this.openEditorsPanel);
	}

	/** Opens the project file picker (Doom SPC SPC). Falls back to recent projects when no workspace is open. */
	async showProjectFiles(onProjectSelected?: (projectUri: vscode.Uri, projectLabel: string) => Promise<void>): Promise<void> {
		if (!this.projectFilePanel.prepareShow()) {
			if (onProjectSelected) {
				await this.showRecentProjectsForFilePick(onProjectSelected);
			} else {
				await this.showRecentProjects();
			}
			return;
		}

		await this.showMode('project', this.projectFilePanel);
		await this.projectFilePanel.loadItems();
	}

	/**
	 * Opens the recent-projects picker in "file-pick" mode.
	 * When the user selects a project, instead of opening the folder immediately,
	 * `onProjectSelected` is called so the caller can chain to a file picker.
	 */
	async showRecentProjectsForFilePick(
		onProjectSelected: (projectUri: vscode.Uri, projectLabel: string) => Promise<void>,
	): Promise<void> {
		this.recentProjectsPanel.prepareShow(async (item) => {
			await onProjectSelected(item.uri, item.label);
		});
		await this.showMode('recent', this.recentProjectsPanel);
		await this.recentProjectsPanel.loadItems();
	}

	/** Opens the directory browser (Doom SPC . / SPC f f) starting in `startUri`. */
	async showFindFile(startUri: vscode.Uri): Promise<void> {
		this.findFilePanel.prepareShow(startUri);
		await this.showMode('findFile', this.findFilePanel);
		await this.findFilePanel.loadItems();
	}

	/** Opens the recent-projects picker. Can also be invoked directly from other locations. */
	async showRecentProjects(): Promise<void> {
		this.recentProjectsPanel.prepareShow();
		await this.showMode('recent', this.recentProjectsPanel);
		await this.recentProjectsPanel.loadItems();
	}

	/** Opens the searchable which-key bindings list. */
	async showWhichKeyBindings(): Promise<void> {
		this.whichKeyBindingsPanel.prepareShow();
		await this.showMode('bindings', this.whichKeyBindingsPanel);
	}

	/**
	 * Core show routine: swaps the active controller, moves the panel to the bottom,
	 * reveals the container, waits for the view to exist, then focuses it.
	 * The `hadView` check avoids double-attaching when the view is already live.
	 */
	private async showMode(mode: SharedPanelMode, controller: SharedPanelController): Promise<void> {
		const hadView = this.view !== undefined;
		this.setActiveController(mode, controller);
		if (hadView && this.view) {
			controller.attachToView(this.view);
		}

		await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
		await vscode.commands.executeCommand(`workbench.view.extension.${DoomSharedPanel.containerId}`);
		await this.waitForView();

		await vscode.commands.executeCommand(`${DoomSharedPanel.viewId}.focus`);
		await this.syncVisibilityContexts(true);
	}

	/** Swaps the active controller, detaching the previous one first. No-op if same controller is reused. */
	private setActiveController(mode: SharedPanelMode, controller: SharedPanelController): void {
		if (this.activeController === controller) {
			this.activeMode = mode;
			return;
		}

		this.activeController?.detachFromView();
		this.activeController = controller;
		this.activeMode = mode;
	}

	/** Updates visibility context keys for all panel modes. */
	private async syncVisibilityContexts(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand(
			'setContext',
			DoomWhichKeyMenu.visibleContextKey,
			isVisible && this.activeMode === 'whichkey'
		);
		await vscode.commands.executeCommand(
			'setContext',
			DoomFuzzySearchPanel.visibleContextKey,
			isVisible && this.activeMode === 'search'
		);
		await vscode.commands.executeCommand(
			'setContext',
			DoomProjectFilePanel.visibleContextKey,
			isVisible && this.activeMode === 'project'
		);
		await vscode.commands.executeCommand(
			'setContext',
			DoomFindFilePanel.visibleContextKey,
			isVisible && this.activeMode === 'findFile'
		);
		await vscode.commands.executeCommand(
			'setContext',
			DoomRecentProjectsPanel.visibleContextKey,
			isVisible && this.activeMode === 'recent'
		);
		await vscode.commands.executeCommand(
			'setContext',
			DoomOpenEditorsPanel.visibleContextKey,
			isVisible && this.activeMode === 'buffers'
		);
		await vscode.commands.executeCommand(
			'setContext',
			DoomWhichKeyBindingsPanel.visibleContextKey,
			isVisible && this.activeMode === 'bindings'
		);
	}

	/** Resolves immediately if the view exists, otherwise queues a resolver that fires when `resolveWebviewView` is called. */
	private waitForView(): Promise<vscode.WebviewView> {
		if (this.view) {
			return Promise.resolve(this.view);
		}

		return new Promise((resolve) => {
			this.pendingViewResolvers.push(resolve);
		});
	}

	/** Returns minimal idle-state HTML shown before any command activates the panel. No scripts needed. */
	private getPlaceholderHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Doom</title>
	<style>
		body {
			margin: 0;
			padding: 12px;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: var(--vscode-editor-font-size, 13px);
			line-height: var(--vscode-editor-line-height, 20px);
			background: var(--vscode-panel-background);
			color: var(--vscode-descriptionForeground);
		}
	</style>
</head>
<body>Run a Doom command to open which-key, search, or buffers.</body>
</html>`;
	}
}
