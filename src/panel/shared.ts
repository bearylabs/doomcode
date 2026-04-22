import * as vscode from 'vscode';
import { DoomOpenEditorsPanel } from '../buffers/openEditors';
import { DoomFuzzySearchPanel } from '../search/fuzzy';
import { DoomWhichKeyMenu } from '../whichkey/menu';

type SharedPanelMode = 'buffers' | 'search' | 'whichkey';

interface SharedPanelController {
	attachToView(webviewView: vscode.WebviewView): void;
	detachFromView(): void;
}

export class DoomSharedPanel implements vscode.WebviewViewProvider {
	static readonly containerId = 'doomPanel';
	static readonly viewId = 'doom.panelView';

	private activeController: SharedPanelController | undefined;
	private activeMode: SharedPanelMode | undefined;
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly whichKeyMenu: DoomWhichKeyMenu,
		private readonly fuzzySearchPanel: DoomFuzzySearchPanel,
		private readonly openEditorsPanel: DoomOpenEditorsPanel,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;

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

	async showWhichKey(): Promise<void> {
		this.whichKeyMenu.prepareShow();
		await this.showMode('whichkey', this.whichKeyMenu);
	}

	async showFuzzySearch(): Promise<void> {
		if (!this.fuzzySearchPanel.prepareShow()) {
			return;
		}

		await this.showMode('search', this.fuzzySearchPanel);
	}

	async showWorkspaceSearch(): Promise<void> {
		if (!this.fuzzySearchPanel.prepareShowWorkspace()) {
			return;
		}

		await this.showMode('search', this.fuzzySearchPanel);
		await this.fuzzySearchPanel.loadPreparedWorkspaceItems();
	}

	async showOpenEditors(): Promise<void> {
		this.openEditorsPanel.prepareShow();
		await this.showMode('buffers', this.openEditorsPanel);
	}

	private async showMode(mode: SharedPanelMode, controller: SharedPanelController): Promise<void> {
		const hadView = this.view !== undefined;
		this.setActiveController(mode, controller);
		if (hadView && this.view) {
			controller.attachToView(this.view);
		}

		await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
		await vscode.commands.executeCommand(`workbench.view.extension.${DoomSharedPanel.containerId}`);

		await vscode.commands.executeCommand(`${DoomSharedPanel.viewId}.focus`);
		await this.syncVisibilityContexts(true);
	}

	private setActiveController(mode: SharedPanelMode, controller: SharedPanelController): void {
		if (this.activeController === controller) {
			this.activeMode = mode;
			return;
		}

		this.activeController?.detachFromView();
		this.activeController = controller;
		this.activeMode = mode;
	}

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