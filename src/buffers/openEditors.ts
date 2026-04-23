import * as fs from 'fs';
import * as vscode from 'vscode';
import { createNonce, fuzzyMatch } from '../panel/helpers';
import { focusEditorGroup } from '../window/mru';

// ---------------------------------------------------------------------------
// Open editor models
// ---------------------------------------------------------------------------

interface OpenEditorItem {
	description: string;
	kind: string;
	groupColumn: vscode.ViewColumn;
	groupLabel: string;
	isDirty: boolean;
	isRemote: boolean;
	isReadonly: boolean;
	isPinned: boolean;
	label: string;
	searchText: string;
	tab: vscode.Tab;
}

interface OpenEditorMatch {
	displayMatches: number[];
	index: number;
	item: OpenEditorItem;
	score: number;
}

interface OpenEditorState {
	activeIndex: number;
	emptyText: string;
	items: Array<{
		flags: string;
		index: number;
		isPinned: boolean;
		kind: string;
		label: string;
		location: string;
		matches: number[];
	}>;
	promptLabel: string;
	placeholder: string;
	query: string;
	statusLabel: string;
	title: string;
}

interface OpenEditorMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready';
}

function viewColumnToGroupLabel(viewColumn: vscode.ViewColumn): string {
	return `G${viewColumn}`;
}

// ---------------------------------------------------------------------------
// Tab metadata helpers
// ---------------------------------------------------------------------------

function getRelativeLabel(uri: vscode.Uri): string {
	if (uri.scheme === 'file') {
		return vscode.workspace.asRelativePath(uri, false);
	}

	return uri.path.length > 0 ? uri.path : uri.toString(true);
}

function getWorkspaceLabel(): string {
	const namedWorkspace = vscode.workspace.name?.trim();
	if (namedWorkspace) {
		return namedWorkspace;
	}

	const firstFolder = vscode.workspace.workspaceFolders?.[0]?.name?.trim();
	return firstFolder && firstFolder.length > 0 ? firstFolder : 'workspace';
}

function inferKindFromUri(uri: vscode.Uri, fallback = 'Text'): string {
	if (uri.scheme !== 'file') {
		return uri.scheme.slice(0, 6) || fallback;
	}

	const slashIndex = uri.path.lastIndexOf('/');
	const basename = slashIndex >= 0 ? uri.path.slice(slashIndex + 1) : uri.path;
	const dotIndex = basename.lastIndexOf('.');
	if (dotIndex <= 0 || dotIndex === basename.length - 1) {
		return fallback;
	}

	return basename.slice(dotIndex + 1, dotIndex + 7).toUpperCase();
}

function getTabInputDetails(tab: vscode.Tab): { description: string; kind: string; searchText: string } {
	const input = tab.input;

	if (input instanceof vscode.TabInputText) {
		const description = getRelativeLabel(input.uri);
		return {
			description,
			kind: inferKindFromUri(input.uri),
			searchText: `${tab.label} ${description}`,
		};
	}

	if (input instanceof vscode.TabInputTextDiff) {
		const original = getRelativeLabel(input.original);
		const modified = getRelativeLabel(input.modified);
		const description = `${original} ↔ ${modified}`;
		return {
			description,
			kind: 'Diff',
			searchText: `${tab.label} ${original} ${modified} diff`,
		};
	}

	if (input instanceof vscode.TabInputCustom) {
		const description = getRelativeLabel(input.uri);
		return {
			description,
			kind: input.viewType.slice(0, 8) || 'Custom',
			searchText: `${tab.label} ${description} ${input.viewType}`,
		};
	}

	if (input instanceof vscode.TabInputNotebook) {
		const description = getRelativeLabel(input.uri);
		return {
			description,
			kind: 'Notebook',
			searchText: `${tab.label} ${description} ${input.notebookType}`,
		};
	}

	if (input instanceof vscode.TabInputNotebookDiff) {
		const original = getRelativeLabel(input.original);
		const modified = getRelativeLabel(input.modified);
		const description = `${original} ↔ ${modified}`;
		return {
			description,
			kind: 'NBDiff',
			searchText: `${tab.label} ${original} ${modified} ${input.notebookType} diff`,
		};
	}

	if (input instanceof vscode.TabInputWebview) {
		return {
			description: input.viewType,
			kind: 'Webview',
			searchText: `${tab.label} ${input.viewType} webview`,
		};
	}

	if (input instanceof vscode.TabInputTerminal) {
		return {
			description: 'Terminal editor',
			kind: 'VTerm',
			searchText: `${tab.label} terminal`,
		};
	}

	return {
		description: 'Editor',
		kind: 'Editor',
		searchText: tab.label,
	};
}

function isUriReadonly(uri: vscode.Uri): boolean {
	const isWritable = vscode.workspace.fs.isWritableFileSystem(uri.scheme);
	if (isWritable === false) {
		return true;
	}

	if (uri.scheme !== 'file') {
		return false;
	}

	try {
		fs.accessSync(uri.fsPath, fs.constants.W_OK);
		return false;
	} catch {
		return true;
	}
}

function isTabReadonly(tab: vscode.Tab): boolean {
	const input = tab.input;

	if (input instanceof vscode.TabInputTerminal) {
		return true;
	}

	if (input instanceof vscode.TabInputText) {
		return isUriReadonly(input.uri);
	}

	if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
		return true;
	}

	if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
		return isUriReadonly(input.uri);
	}

	if (input instanceof vscode.TabInputWebview) {
		return true;
	}

	return false;
}

function isRemoteUri(uri: vscode.Uri): boolean {
	return uri.scheme === 'vscode-remote';
}

function isTabRemote(tab: vscode.Tab): boolean {
	const input = tab.input;

	if (input instanceof vscode.TabInputText) {
		return isRemoteUri(input.uri);
	}

	if (input instanceof vscode.TabInputTextDiff) {
		return isRemoteUri(input.original) || isRemoteUri(input.modified);
	}

	if (input instanceof vscode.TabInputCustom) {
		return isRemoteUri(input.uri);
	}

	if (input instanceof vscode.TabInputNotebook) {
		return isRemoteUri(input.uri);
	}

	if (input instanceof vscode.TabInputNotebookDiff) {
		return isRemoteUri(input.original) || isRemoteUri(input.modified);
	}

	return false;
}

function getBufferFlags(item: Pick<OpenEditorItem, 'isDirty' | 'isReadonly' | 'isRemote'>): string {
	const primaryFlag = item.isReadonly ? '%' : item.isDirty ? '*' : '-';
	const modifiedFlag = item.isDirty ? '*' : item.isReadonly ? '%' : '-';
	const remoteFlag = item.isRemote ? '@' : '-';
	return `${primaryFlag}${modifiedFlag}${remoteFlag}`;
}

function shouldHideFromBufferSwitcher(tab: vscode.Tab): boolean {
	const input = tab.input;
	if (tab.label === '*doom*') {
		return true;
	}

	if (input instanceof vscode.TabInputWebview) {
		return input.viewType === 'doom.startPage' || input.viewType.includes('doom.startPage');
	}

	if (input instanceof vscode.TabInputCustom) {
		return input.viewType === 'doom.startPage' || input.viewType.includes('doom.startPage');
	}

	return false;
}

// ---------------------------------------------------------------------------
// Tab navigation helpers
// ---------------------------------------------------------------------------

function getTabDedupKey(tab: vscode.Tab): string {
	const input = tab.input;

	if (input instanceof vscode.TabInputText) {
		return `text:${input.uri.toString()}`;
	}

	if (input instanceof vscode.TabInputTextDiff) {
		return `textdiff:${input.original.toString()}::${input.modified.toString()}`;
	}

	if (input instanceof vscode.TabInputCustom) {
		return `custom:${input.viewType}:${input.uri.toString()}`;
	}

	if (input instanceof vscode.TabInputNotebook) {
		return `notebook:${input.notebookType}:${input.uri.toString()}`;
	}

	if (input instanceof vscode.TabInputNotebookDiff) {
		return `notebookdiff:${input.notebookType}:${input.original.toString()}::${input.modified.toString()}`;
	}

	if (input instanceof vscode.TabInputWebview) {
		return `webview:${input.viewType}:${tab.label}`;
	}

	if (input instanceof vscode.TabInputTerminal) {
		return `terminal:${tab.label}`;
	}

	return `unknown:${tab.label}`;
}

async function revealExistingTab(tab: vscode.Tab): Promise<boolean> {
	const group = tab.group;
	const targetGroup = group.viewColumn;
	const targetIndex = group.tabs.indexOf(tab);
	if (targetGroup === undefined || targetIndex < 0) {
		return false;
	}

	const focused = await focusEditorGroup(targetGroup);
	if (!focused) {
		return false;
	}

	const activeTab = group.activeTab;
	if (!activeTab) {
		return false;
	}

	const activeIndex = group.tabs.indexOf(activeTab);
	if (activeIndex < 0) {
		return false;
	}

	const tabCount = group.tabs.length;
	const forwardSteps = (targetIndex - activeIndex + tabCount) % tabCount;
	const backwardSteps = (activeIndex - targetIndex + tabCount) % tabCount;
	const moveForward = forwardSteps <= backwardSteps;
	const command = moveForward
		? 'workbench.action.nextEditorInGroup'
		: 'workbench.action.previousEditorInGroup';
	const steps = moveForward ? forwardSteps : backwardSteps;

	for (let step = 0; step < steps; step++) {
		await vscode.commands.executeCommand(command);
	}

	const freshGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === targetGroup);
	return freshGroup?.activeTab !== undefined && getTabDedupKey(freshGroup.activeTab) === getTabDedupKey(tab);
}

async function moveActiveEditorToGroup(targetGroup: vscode.ViewColumn): Promise<boolean> {
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
	if (!activeTab) {
		return false;
	}

	if (vscode.window.tabGroups.activeTabGroup.viewColumn === targetGroup) {
		return true;
	}

	await vscode.commands.executeCommand('moveActiveEditor', {
		by: 'group',
		to: 'position',
		value: targetGroup,
	});

	const newActiveGroup = vscode.window.tabGroups.activeTabGroup;
	return newActiveGroup.viewColumn === targetGroup
		&& newActiveGroup.activeTab !== undefined
		&& getTabDedupKey(newActiveGroup.activeTab) === getTabDedupKey(activeTab);
}

function isTerminalTabActiveInGroup(targetGroup: vscode.ViewColumn, label: string): boolean {
	const activeGroup = vscode.window.tabGroups.activeTabGroup;
	return activeGroup.viewColumn === targetGroup
		&& activeGroup.activeTab?.input instanceof vscode.TabInputTerminal
		&& activeGroup.activeTab.label === label;
}

async function moveTerminalEditorToGroup(tab: vscode.Tab, targetGroup: vscode.ViewColumn): Promise<boolean> {
	if (!(tab.input instanceof vscode.TabInputTerminal)) {
		return false;
	}

	if (await moveActiveEditorToGroup(targetGroup) && isTerminalTabActiveInGroup(targetGroup, tab.label)) {
		return true;
	}

	await vscode.commands.executeCommand('workbench.action.terminal.focus');
	await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');

	const focused = await focusEditorGroup(targetGroup);
	if (!focused) {
		return false;
	}

	await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');

	return isTerminalTabActiveInGroup(targetGroup, tab.label);
}

async function openTabInGroup(tab: vscode.Tab, targetGroup: vscode.ViewColumn): Promise<boolean> {
	return openTabInGroupWithOptions(tab, targetGroup, {
		preserveFocus: false,
		preview: false,
	});
}

async function openTabInGroupWithOptions(
	tab: vscode.Tab,
	targetGroup: vscode.ViewColumn,
	options: {
		preserveFocus: boolean;
		preview: boolean;
	},
): Promise<boolean> {
	const input = tab.input;
	const showOptions = {
		...options,
		viewColumn: targetGroup,
	};

	if (input instanceof vscode.TabInputText) {
		await vscode.commands.executeCommand('vscode.open', input.uri, showOptions);
		return true;
	}

	if (input instanceof vscode.TabInputTextDiff) {
		await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, showOptions);
		return true;
	}

	if (input instanceof vscode.TabInputCustom) {
		await vscode.commands.executeCommand('vscode.openWith', input.uri, input.viewType, showOptions);
		return true;
	}

	if (input instanceof vscode.TabInputNotebook) {
		await vscode.commands.executeCommand('vscode.openWith', input.uri, input.notebookType, showOptions);
		return true;
	}

	if (input instanceof vscode.TabInputNotebookDiff) {
		await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, {
			...showOptions,
			override: input.notebookType,
		});
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// Open editors panel
// ---------------------------------------------------------------------------

export class DoomOpenEditorsPanel {
	private accepted = false;
	private activeIndex = 0;
	private items: OpenEditorItem[] = [];
	private lastPreviewKey: string | undefined;
	private matches: OpenEditorMatch[] = [];
	private query = '';
	private ready = false;
	private restoreTabKey: string | undefined;
	private targetGroup: vscode.ViewColumn | undefined;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	prepareShow(resetQuery = true): void {
		const activeGroup = vscode.window.tabGroups.activeTabGroup;
		this.accepted = false;
		this.lastPreviewKey = undefined;
		this.restoreTabKey = activeGroup.activeTab ? getTabDedupKey(activeGroup.activeTab) : undefined;
		this.targetGroup = activeGroup.viewColumn;
		this.activeIndex = 0;
		if (resetQuery) {
			this.query = '';
		}

		this.refreshItems();
	}

	attachToView(webviewView: vscode.WebviewView): void {
		this.resolveWebviewView(webviewView);
	}

	detachFromView(): void {
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = undefined;
		this.ready = false;
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.updateViewMetadata();

		this.viewDisposables.push(
			webviewView.onDidDispose(() => {
				if (this.view === webviewView) {
					this.view = undefined;
					this.ready = false;
				}
			}),
			webviewView.onDidChangeVisibility(() => {
				if (!webviewView.visible) {
					return;
				}

				this.refreshItems();
				this.render();
			}),
			vscode.window.tabGroups.onDidChangeTabs(() => {
				if (!webviewView.visible) {
					return;
				}

				this.refreshItems();
				this.render();
			}),
			webviewView.webview.onDidReceiveMessage((message: OpenEditorMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	private updateViewMetadata(): void {
		if (!this.view) {
			return;
		}

		this.view.title = 'Switch to buffer';
		this.view.description = getWorkspaceLabel();
	}

	private refreshItems(): void {
		const items: OpenEditorItem[] = [];
		const seen = new Set<string>();

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (shouldHideFromBufferSwitcher(tab)) {
					continue;
				}

				const dedupKey = getTabDedupKey(tab);
				if (seen.has(dedupKey)) {
					continue;
				}

				seen.add(dedupKey);
				const details = getTabInputDetails(tab);
				items.push({
					description: details.description,
					kind: details.kind,
					groupColumn: group.viewColumn,
					groupLabel: viewColumnToGroupLabel(group.viewColumn),
					isDirty: tab.isDirty,
					isRemote: isTabRemote(tab),
					isReadonly: isTabReadonly(tab),
					isPinned: tab.isPinned,
					label: tab.label,
					searchText: `${details.searchText} ${viewColumnToGroupLabel(group.viewColumn)}`.toLowerCase(),
					tab,
				});
			}
		}

		this.items = items;
		this.filterItems();
	}

	private filterItems(): void {
		const query = this.query.trim().toLowerCase();
		const matches = this.items
			.map((item, index) => {
				if (query.length === 0) {
					return {
						displayMatches: [],
						index,
						item,
						score: 0,
					};
				}

				const searchMatch = fuzzyMatch(item.searchText, query);
				if (!searchMatch) {
					return undefined;
				}

				const labelMatch = fuzzyMatch(item.label.toLowerCase(), query);

				return {
					displayMatches: labelMatch?.indices ?? [],
					index,
					item,
					score: searchMatch.score,
				};
			})
			.filter((entry): entry is OpenEditorMatch => entry !== undefined);

		if (query.length === 0) {
			this.matches = matches;
		} else {
			this.matches = matches.sort(
				(left, right) => right.score - left.score || left.item.label.localeCompare(right.item.label)
			);
		}

		this.activeIndex = this.matches.length === 0
			? 0
			: Math.min(this.activeIndex, this.matches.length - 1);
	}

	private async handleMessage(message: OpenEditorMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.ready = true;
				this.render();
				await this.previewSelection();
				return;
			case 'query':
				this.query = message.query ?? '';
				this.filterItems();
				this.render();
				await this.previewSelection();
				return;
			case 'move': {
				if (this.matches.length === 0 || message.index === undefined) {
					return;
				}

				this.activeIndex = Math.min(Math.max(message.index, 0), this.matches.length - 1);
				this.render();
				await this.previewSelection();
				return;
			}
			case 'activate': {
				if (message.index !== undefined) {
					this.activeIndex = Math.min(Math.max(message.index, 0), this.matches.length - 1);
				}

				await this.activateSelection();
				return;
			}
			case 'close':
				await this.close();
				return;
			default:
				return;
		}
	}

	private async activateSelection(): Promise<void> {
		const match = this.matches[this.activeIndex];
		if (!match) {
			return;
		}

		const targetGroup = this.targetGroup ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
		const opened = await openTabInGroup(match.item.tab, targetGroup);
		if (!opened) {
			const revealedExistingTab = await revealExistingTab(match.item.tab);
			if (revealedExistingTab) {
				if (match.item.groupColumn !== targetGroup) {
					if (match.item.tab.input instanceof vscode.TabInputTerminal) {
						const moved = await moveTerminalEditorToGroup(match.item.tab, targetGroup);
						if (!moved) {
							void vscode.window.showWarningMessage(
								`Doom Code: cannot move terminal "${match.item.label}" to ${viewColumnToGroupLabel(targetGroup)}.`
							);
							return;
						}
					} else {
						const moved = await moveActiveEditorToGroup(targetGroup);
						if (!moved) {
							void vscode.window.showWarningMessage(
								`Doom Code: cannot move "${match.item.label}" to ${viewColumnToGroupLabel(targetGroup)}.`
							);
							return;
						}
					}
				}

				this.accepted = true;
				await this.close();
				if (match.item.tab.input instanceof vscode.TabInputTerminal) {
					await vscode.commands.executeCommand('workbench.action.terminal.focus');
				}
				return;
			}

			const sourceGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === match.item.groupColumn);
			if (sourceGroup?.activeTab !== undefined && getTabDedupKey(sourceGroup.activeTab) === getTabDedupKey(match.item.tab)) {
				await focusEditorGroup(match.item.groupColumn);
				this.accepted = true;
				await this.close();
				if (match.item.tab.input instanceof vscode.TabInputTerminal) {
					await vscode.commands.executeCommand('workbench.action.terminal.focus');
				}
				return;
			}

			void vscode.window.showWarningMessage(
				`Doom Code: cannot move "${match.item.label}" from ${match.item.groupLabel}.`
			);
			return;
		}

		this.accepted = true;
		await this.close();
	}

	private async previewSelection(): Promise<void> {
		const match = this.matches[this.activeIndex];
		if (!match) {
			return;
		}

		const targetGroup = this.targetGroup ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
		const previewKey = getTabDedupKey(match.item.tab);
		if (previewKey === this.lastPreviewKey) {
			return;
		}

		const previewed = await openTabInGroupWithOptions(match.item.tab, targetGroup, {
			preserveFocus: true,
			preview: true,
		});
		if (!previewed) {
			return;
		}

		this.lastPreviewKey = previewKey;
	}

	private async restorePreviewIfNeeded(): Promise<void> {
		if (this.accepted || !this.lastPreviewKey) {
			return;
		}

		const targetGroup = this.targetGroup ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
		const previewKey = this.lastPreviewKey;
		const restoreTabKey = this.restoreTabKey;
		this.lastPreviewKey = undefined;

		if (restoreTabKey) {
			const group = vscode.window.tabGroups.all.find((entry) => entry.viewColumn === targetGroup);
			const restoreTab = group?.tabs.find((tab) => getTabDedupKey(tab) === restoreTabKey);
			if (restoreTab) {
				const restored = await openTabInGroup(restoreTab, targetGroup);
				if (restored) {
					return;
				}

				if (group?.activeTab !== restoreTab) {
					await revealExistingTab(restoreTab);
				}
				return;
			}
		}

		const group = vscode.window.tabGroups.all.find((entry) => entry.viewColumn === targetGroup);
		const activeTab = group?.activeTab;
		if (!activeTab || getTabDedupKey(activeTab) !== previewKey) {
			return;
		}

		const focused = await focusEditorGroup(targetGroup);
		if (!focused) {
			return;
		}

		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	}

	private async close(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
		await this.restorePreviewIfNeeded();
	}

	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const state: OpenEditorState = {
			activeIndex: this.activeIndex,
			emptyText: this.matches.length === 0 ? 'No open editors match.' : '',
			items: this.matches.map((entry, index) => ({
				flags: getBufferFlags(entry.item),
				index,
				isPinned: entry.item.isPinned,
				kind: entry.item.kind,
				label: entry.item.label,
				location: entry.item.description,
				matches: entry.displayMatches,
			})),
			promptLabel: `Switch to buffer (${getWorkspaceLabel()}):`,
			placeholder: 'Type to narrow open editors',
			query: this.query,
			statusLabel: `${this.matches.length === 0 ? 0 : this.activeIndex + 1}/${this.matches.length}`,
			title: `Switch to buffer (${getWorkspaceLabel()})`,
		};

		void this.view.webview.postMessage({
			type: 'render',
			state,
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = createNonce();
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Open Editors</title>
	<style>
		html {
			height: 100%;
		}

		:root {
			color-scheme: dark;
			--bg: var(--vscode-editorWidget-background, var(--vscode-editor-background));
			--border: var(--vscode-panel-border, color-mix(in srgb, var(--bg) 82%, white 18%));
			--input-fg: var(--vscode-input-foreground, var(--vscode-editor-foreground));
			--muted: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
			--text: var(--vscode-editor-foreground);
			--selected: var(--vscode-editor-lineHighlightBackground, color-mix(in srgb, var(--bg) 80%, white 20%));
			--accent: var(--vscode-focusBorder, var(--vscode-editorCursor-foreground));
			--match-bg: var(--vscode-editor-findMatchHighlightBackground, color-mix(in srgb, var(--accent) 62%, transparent));
			--match-fg: var(--vscode-editor-findMatchForeground, var(--text));
			--font-family: var(--vscode-editor-font-family, monospace);
			--font-size: var(--vscode-editor-font-size, 13px);
			--line-height: var(--vscode-editor-line-height, 20px);
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			height: 100%;
			background: var(--bg);
			color: var(--text);
			font-family: var(--font-family);
			font-size: var(--font-size);
			line-height: var(--line-height);
			overflow: hidden;
			display: flex;
		}

		.shell {
			display: flex;
			flex-direction: column;
			flex: 1 1 auto;
			min-height: 0;
		}

		.promptbar {
			display: grid;
			grid-template-columns: auto auto 1fr;
			align-items: center;
			gap: 10px;
			padding: 2px 8px;
			border-bottom: 1px solid var(--border);
		}

		.status {
			color: var(--muted);
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
		}

		.input {
			width: 100%;
			padding: 0;
			border: none;
			outline: none;
			background: transparent;
			color: var(--input-fg);
			font: inherit;
			caret-color: var(--accent);
		}

		.input::placeholder {
			color: color-mix(in srgb, var(--muted) 72%, transparent);
		}

		.prompt {
			color: var(--muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.results {
			flex: 1 1 0;
			min-height: 0;
			overflow: auto;
			display: flex;
			flex-direction: column;
			padding: 2px 0;
		}

		.item {
			display: grid;
			grid-template-columns: minmax(18ch, 28ch) 4ch 10ch minmax(0, 1fr);
			gap: 2ch;
			align-items: center;
			min-height: var(--line-height);
			padding: 0 10px;
			border: none;
			background: transparent;
			color: inherit;
			text-align: left;
			font: inherit;
			cursor: pointer;
		}

		.item.active {
			background: var(--selected);
			outline: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
			outline-offset: -1px;
		}

		.flags,
		.kind,
		.location {
			color: var(--muted);
			white-space: nowrap;
			font-variant-numeric: tabular-nums;
		}

		.flags,
		.kind {
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.label {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.location {
			min-width: 0;
			color: var(--muted);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.match {
			background: var(--match-bg);
			color: var(--match-fg);
		}

		.empty {
			color: var(--muted);
			padding: 4px 10px;
			white-space: nowrap;
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="promptbar">
			<div class="status" id="status">0/0</div>
			<div class="prompt" id="prompt">Switch to buffer:</div>
			<input class="input" id="query" type="text" spellcheck="false" placeholder="Type to narrow open editors" />
		</div>
		<div class="results" id="results"></div>
		<div class="empty" id="empty" hidden>No open editors match.</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const empty = document.getElementById('empty');
		const query = document.getElementById('query');
		const prompt = document.getElementById('prompt');
		const results = document.getElementById('results');
		const status = document.getElementById('status');
		let items = [];

		function appendHighlightedText(container, text, matches) {
			if (!matches || matches.length === 0) {
				container.textContent = text;
				return;
			}

			let cursor = 0;
			let matchCursor = 0;
			while (cursor < text.length) {
				if (matchCursor >= matches.length || matches[matchCursor] !== cursor) {
					const nextMatch = matchCursor < matches.length ? matches[matchCursor] : text.length;
					container.append(document.createTextNode(text.slice(cursor, nextMatch)));
					cursor = nextMatch;
					continue;
				}

				let end = cursor;
				while (matchCursor < matches.length && matches[matchCursor] === end) {
					end++;
					matchCursor++;
				}

				const mark = document.createElement('span');
				mark.className = 'match';
				mark.textContent = text.slice(cursor, end);
				container.append(mark);
				cursor = end;
			}
		}

		function render(state) {
			items = state.items;
			document.title = state.title;
			query.placeholder = state.placeholder;
			prompt.textContent = state.promptLabel;
			empty.textContent = state.emptyText;

			if (document.activeElement !== query) {
				query.value = state.query;
			}

			status.textContent = state.statusLabel;
			results.innerHTML = '';
			empty.hidden = items.length > 0;

			items.forEach((item) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = item.index === state.activeIndex ? 'item active' : 'item';
				button.dataset.index = String(item.index);

				const label = document.createElement('span');
				label.className = 'label';
				appendHighlightedText(label, item.label, item.matches);

				const flags = document.createElement('span');
				flags.className = 'flags';
				flags.textContent = item.flags;

				const kind = document.createElement('span');
				kind.className = 'kind';
				kind.textContent = item.kind;

				const location = document.createElement('span');
				location.className = 'location';
				location.textContent = item.location;

				button.append(label, flags, kind, location);
				button.addEventListener('click', () => {
					vscode.postMessage({ type: 'activate', index: item.index });
				});
				results.appendChild(button);
			});

			const activeButton = results.querySelector('[data-index="' + state.activeIndex + '"]');
			if (activeButton instanceof HTMLElement) {
				activeButton.scrollIntoView({ block: 'nearest' });
			}

			query.focus();
			query.setSelectionRange(query.value.length, query.value.length);
		}

		query.addEventListener('input', () => {
			vscode.postMessage({ type: 'query', query: query.value });
		});

		window.addEventListener('message', (event) => {
			if (event.data.type === 'render') {
				render(event.data.state);
			}
		});

		window.addEventListener('keydown', (event) => {
			const isCtrlMoveDown = event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'j';
			const isCtrlMoveUp = event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'k';

			if (event.metaKey || event.altKey || (event.ctrlKey && !isCtrlMoveDown && !isCtrlMoveUp)) {
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				vscode.postMessage({ type: 'close' });
				return;
			}

			if (event.key === 'ArrowDown' || isCtrlMoveDown) {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'move', index: Math.min(activeIndex + 1, items.length - 1) });
				return;
			}

			if (event.key === 'ArrowUp' || isCtrlMoveUp) {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'move', index: Math.max(activeIndex - 1, 0) });
				return;
			}

			if (event.key === 'Enter') {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'activate', index: Math.max(activeIndex, 0) });
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
