import * as vscode from 'vscode';
import { DoomOpenEditorsPanel } from '../buffers/openEditors';
import { DoomFuzzySearchPanel } from '../search/fuzzy';
import { DoomWhichKeyBindingsPanel } from '../whichkey/bindingsPanel';
import { DoomWhichKeyMenu } from '../whichkey/menu';

// ---------------------------------------------------------------------------
// Shared panel modes
// ---------------------------------------------------------------------------

type SharedPanelMode = 'bindings' | 'buffers' | 'search' | 'whichkey';

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
	async showWhichKey(): Promise<void> {
		this.whichKeyMenu.prepareShow();
		await this.showMode('whichkey', this.whichKeyMenu);
	}

	/** Opens which-key with an explicit context (e.g. terminal focus) so conditional bindings resolve correctly. */
	async showWhichKeyWithContext(showContext?: { terminalFocus?: boolean }): Promise<void> {
		this.whichKeyMenu.prepareShow(showContext);
		await this.showMode('whichkey', this.whichKeyMenu);
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

	/** Updates which-key and search visibility context keys so their keybindings activate only when the right mode is shown. */
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
