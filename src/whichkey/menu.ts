import * as vscode from 'vscode';
import {
	executeWhichKeyBindingCommands,
	getConfiguredWhichKeyBindings,
	type WhichKeyBinding,
} from './bindings';

interface ContextSnapshot {
	activeEditorLastInGroup: boolean;
	activePanel: string;
	activeViewlet: string;
	bigModeEnabled: boolean;
	copilotVisible: boolean;
	editorHasSelection: boolean;
	explorerViewletVisible: boolean;
	markersVisible: boolean;
	multipleEditorGroups: boolean;
}

interface RenderItem {
	isGroup: boolean;
	key: string;
	name: string;
}

interface ViewState {
	footerLabel: string;
	footerPath: string;
	items: RenderItem[];
}

interface EditorLayoutGroup {
	groups?: EditorLayoutGroup[];
	size?: number;
}

interface EditorLayout {
	groups: EditorLayoutGroup[];
	orientation?: 0 | 1;
}

interface WebviewMessage {
	index?: number;
	type: 'activate' | 'back' | 'close' | 'ready';
}

function getContextValue(state: DoomWhichKeyMenu, rawCondition: string): boolean {
	const condition = rawCondition.trim();
	if (condition.length === 0) {
		return true;
	}

	if (condition === 'editorHasSelection') {
		return state.snapshot.editorHasSelection;
	}

	switch (condition) {
	case 'activeEditorLastInGroup':
		return state.snapshot.activeEditorLastInGroup;
	case 'doom.bigModeEnabled':
		return state.snapshot.bigModeEnabled;
	case 'explorerViewletVisible':
		return state.snapshot.explorerViewletVisible;
	case 'multipleEditorGroups':
		return state.snapshot.multipleEditorGroups;
	case 'view.workbench.panel.chat.view.copilot.visible':
		return state.snapshot.copilotVisible;
	case 'view.workbench.panel.markers.view.visible':
		return state.snapshot.markersVisible;
	default:
		break;
	}

	const equalsMatch = condition.match(/^([A-Za-z0-9._]+)\s*==\s*'([^']+)'$/);
	if (equalsMatch) {
		const [, left, right] = equalsMatch;
		if (left === 'activePanel') {
			return state.snapshot.activePanel === right;
		}

		if (left === 'activeViewlet') {
			return state.snapshot.activeViewlet === right;
		}
	}

	return false;
}

function buildContextSnapshot(state: DoomWhichKeyMenu): ContextSnapshot {
	const activeEditor = vscode.window.activeTextEditor;
	const activeSelection = activeEditor?.selection;
	const activeGroup = vscode.window.tabGroups.activeTabGroup;
	const activeTab = activeGroup.activeTab;

	return {
		activeEditorLastInGroup: activeTab !== undefined
			&& activeGroup.tabs.length > 0
			&& activeGroup.tabs[activeGroup.tabs.length - 1] === activeTab,
		activePanel: '',
		activeViewlet: '',
		bigModeEnabled: state.isBigModeEnabled,
		copilotVisible: false,
		editorHasSelection: activeSelection !== undefined && !activeSelection.isEmpty,
		explorerViewletVisible: false,
		markersVisible: false,
		multipleEditorGroups: vscode.window.tabGroups.all.length > 1,
	};
}

function resolveConditionalBinding(state: DoomWhichKeyMenu, binding: WhichKeyBinding): WhichKeyBinding | undefined {
	const options = binding.bindings ?? [];
	let fallback: WhichKeyBinding | undefined;

	for (const option of options) {
		const key = option.key.trim();
		if (key.length === 0) {
			fallback = option;
			continue;
		}

		const rawCondition = key.startsWith('when:')
			? key.slice('when:'.length)
			: key;

		if (getContextValue(state, rawCondition)) {
			return option;
		}
	}

	return fallback;
}

function toRenderItem(state: DoomWhichKeyMenu, binding: WhichKeyBinding): RenderItem | undefined {
	switch (binding.type) {
	case 'bindings':
		return {
			isGroup: true,
			key: binding.key,
			name: binding.name,
		};
	case 'command':
	case 'commands':
		return {
			isGroup: false,
			key: binding.key,
			name: binding.name,
		};
	case 'conditional': {
		const resolved = resolveConditionalBinding(state, binding);
		if (!resolved) {
			return undefined;
		}

		const resolvedName = resolved.name === 'default' ? binding.name : resolved.name;
		return toRenderItem(state, {
			...resolved,
			key: binding.key,
			name: resolvedName,
		});
	}
	default:
		return undefined;
	}
}

function getNonce(): string {
	return Math.random().toString(36).slice(2, 12);
}

export class DoomWhichKeyMenu {
	static readonly editorViewType = 'doom.whichKeyEditor';
	static readonly visibleContextKey = 'whichkeyVisible';
	static readonly title = 'Doom Which Key';

	private readonly extensionUri: vscode.Uri;
	private bigModeEnabled = false;
	private currentBindings: WhichKeyBinding[] = [];
	private currentItems: RenderItem[] = [];
	private groupCloseTimer: NodeJS.Timeout | undefined;
	private lastPanelColumn: vscode.ViewColumn | undefined;
	private panel: vscode.WebviewPanel | undefined;
	private panelDisposables: vscode.Disposable[] = [];
	private ready = false;
	private stack: WhichKeyBinding[] = [];
	private transientGroupColumn: vscode.ViewColumn | undefined;

	constructor(extensionUri: vscode.Uri) {
		this.extensionUri = extensionUri;
	}

	get isBigModeEnabled(): boolean {
		return this.bigModeEnabled;
	}

	get snapshot(): ContextSnapshot {
		return buildContextSnapshot(this);
	}

	private get currentLevelBindings(): WhichKeyBinding[] {
		const current = this.stack[this.stack.length - 1];
		return current?.bindings ?? this.currentBindings;
	}

	async show(): Promise<void> {
		this.currentBindings = getConfiguredWhichKeyBindings();
		this.stack = [];
		const panel = await this.ensurePanel();
		panel.reveal(panel.viewColumn, false);
		await this.updateVisibilityContext(true);
		this.render();
	}

	async hide(): Promise<void> {
		if (!this.panel) {
			await this.updateVisibilityContext(false);
			await this.closeTransientGroup();
			return;
		}

		await this.close();
	}

	private async ensurePanel(): Promise<vscode.WebviewPanel> {
		if (this.panel) {
			return this.panel;
		}

		const targetGroup = await this.createTransientGroup();
		const panel = vscode.window.createWebviewPanel(
			DoomWhichKeyMenu.editorViewType,
			DoomWhichKeyMenu.title,
			{
				viewColumn: targetGroup?.viewColumn ?? vscode.ViewColumn.Beside,
				preserveFocus: false,
			},
			{
				enableScripts: true,
			}
		);

		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'which-key.svg');
		panel.webview.html = this.getHtml(panel.webview);

		const initialColumn = panel.viewColumn ?? targetGroup?.viewColumn;
		this.panel = panel;
		this.lastPanelColumn = initialColumn;
		this.transientGroupColumn = initialColumn;
		this.ready = false;
		this.currentItems = [];

		this.panelDisposables.push(
			panel.onDidDispose(() => {
				const transientGroupColumn = this.transientGroupColumn;
				this.clearPendingGroupClose();
				this.panelDisposables.forEach((disposable) => disposable.dispose());
				this.panelDisposables = [];
				if (this.panel === panel) {
					this.panel = undefined;
				}
				this.lastPanelColumn = undefined;
				this.ready = false;
				this.currentItems = [];
				this.transientGroupColumn = undefined;
				void this.updateVisibilityContext(false);
				this.scheduleGroupClose(transientGroupColumn);
			}),
			panel.onDidChangeViewState((event) => {
				const nextColumn = event.webviewPanel.viewColumn;
				const previousColumn = this.lastPanelColumn;
				this.lastPanelColumn = nextColumn;

				if (
					this.transientGroupColumn !== undefined
					&& previousColumn === this.transientGroupColumn
					&& nextColumn !== this.transientGroupColumn
				) {
					const transientGroupColumn = this.transientGroupColumn;
					this.transientGroupColumn = undefined;
					this.scheduleGroupClose(transientGroupColumn);
				}

				if (!event.webviewPanel.visible) {
					void this.close();
					return;
				}

				void this.updateVisibilityContext(true);
				this.render();
			}),
			panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
				void this.handleMessage(message);
			})
		);

		return panel;
	}

	private async createTransientGroup(): Promise<vscode.TabGroup | undefined> {
		const currentLayout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
		if (!currentLayout?.groups?.length) {
			await vscode.commands.executeCommand('workbench.action.newGroupBelow');
			await vscode.commands.executeCommand('workbench.action.focusBelowGroup');
			return vscode.window.tabGroups.activeTabGroup;
		}

		const nextLayout: EditorLayout = {
			orientation: 1,
			groups: [
				{
					groups: this.wrapLayoutGroups(currentLayout, 0),
					size: 0.78,
				},
				{
					size: 0.22,
				},
			],
		};

		await vscode.commands.executeCommand('vscode.setEditorLayout', nextLayout);
		await vscode.commands.executeCommand('workbench.action.focusBelowGroup');
		return vscode.window.tabGroups.activeTabGroup;
	}

	private wrapLayoutGroups(layout: EditorLayout, expectedOrientation: 0 | 1): EditorLayoutGroup[] {
		const clonedGroups = layout.groups.map((group) => this.cloneLayoutGroup(group));
		if ((layout.orientation ?? 0) === expectedOrientation) {
			return clonedGroups;
		}

		return [{ groups: clonedGroups }];
	}

	private cloneLayoutGroup(group: EditorLayoutGroup): EditorLayoutGroup {
		return {
			...(group.size !== undefined ? { size: group.size } : {}),
			...(group.groups ? { groups: group.groups.map((child) => this.cloneLayoutGroup(child)) } : {}),
		};
	}

	private findGroupByColumn(viewColumn: vscode.ViewColumn): vscode.TabGroup | undefined {
		return vscode.window.tabGroups.all.find((group) => group.viewColumn === viewColumn);
	}

	private isWhichKeyTab(tab: vscode.Tab): boolean {
		return tab.input instanceof vscode.TabInputWebview
			&& tab.input.viewType === DoomWhichKeyMenu.editorViewType;
	}

	private async closeGroupIfSafe(viewColumn: vscode.ViewColumn | undefined): Promise<void> {
		if (viewColumn === undefined) {
			return;
		}

		const group = this.findGroupByColumn(viewColumn);
		if (!group) {
			return;
		}

		const hasOtherTabs = group.tabs.some((tab) => !this.isWhichKeyTab(tab));
		if (hasOtherTabs) {
			return;
		}

		await vscode.window.tabGroups.close(group, false);
	}

	private scheduleGroupClose(viewColumn: vscode.ViewColumn | undefined, attempt = 0): void {
		if (viewColumn === undefined) {
			return;
		}

		this.clearPendingGroupClose();
		this.groupCloseTimer = setTimeout(() => {
			this.groupCloseTimer = undefined;
			void this.closeGroupIfSafe(viewColumn).then(() => {
				const group = this.findGroupByColumn(viewColumn);
				if (group && group.tabs.some((tab) => this.isWhichKeyTab(tab)) && attempt < 5) {
					this.scheduleGroupClose(viewColumn, attempt + 1);
				}
			});
		}, 25);
	}

	private clearPendingGroupClose(): void {
		if (!this.groupCloseTimer) {
			return;
		}

		clearTimeout(this.groupCloseTimer);
		this.groupCloseTimer = undefined;
	}

	private async closeTransientGroup(): Promise<void> {
		this.clearPendingGroupClose();
		await this.closeGroupIfSafe(this.transientGroupColumn);
		this.transientGroupColumn = undefined;
	}

	private async waitForWhichKeyTabToClose(viewColumn: vscode.ViewColumn | undefined): Promise<void> {
		if (viewColumn === undefined) {
			return;
		}

		const groupHasWhichKeyTab = () => {
			const group = this.findGroupByColumn(viewColumn);
			return group?.tabs.some((tab) => this.isWhichKeyTab(tab)) ?? false;
		};

		if (!groupHasWhichKeyTab()) {
			return;
		}

		await new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) {
					return;
				}

				done = true;
				tabsDisposable.dispose();
				groupsDisposable.dispose();
				clearTimeout(timeout);
				resolve();
			};
			const check = () => {
				if (!groupHasWhichKeyTab()) {
					finish();
				}
			};

			const tabsDisposable = vscode.window.tabGroups.onDidChangeTabs(check);
			const groupsDisposable = vscode.window.tabGroups.onDidChangeTabGroups(check);
			const timeout = setTimeout(finish, 1000);
			check();
		});
	}

	async executeBinding(binding: WhichKeyBinding): Promise<void> {
		const transientGroupColumn = this.transientGroupColumn;
		await this.close();
		await this.waitForWhichKeyTabToClose(transientGroupColumn);
		await this.closeGroupIfSafe(transientGroupColumn);

		await executeWhichKeyBindingCommands(binding, (command, arg) => {
			this.trackContextCommand(command, arg);
		});
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		if (message.type === 'ready') {
			this.ready = true;
			this.render();
			return;
		}

		if (message.type === 'close') {
			await this.close();
			return;
		}

		if (message.type === 'back') {
			if (this.stack.length === 0) {
				await this.close();
				return;
			}

			this.stack.pop();
			this.render();
			return;
		}

		if (message.type !== 'activate' || message.index === undefined) {
			return;
		}

		const renderItem = this.currentItems[message.index];
		if (!renderItem) {
			return;
		}

		const binding = this.currentLevelBindings.find((item) => item.key === renderItem.key);
		if (!binding) {
			return;
		}

		if (binding.type === 'bindings') {
			this.stack.push(binding);
			this.render();
			return;
		}

		if (binding.type === 'conditional') {
			const resolved = resolveConditionalBinding(this, binding);
			if (!resolved) {
				return;
			}

			if (resolved.type === 'bindings') {
				this.stack.push({
					...binding,
					bindings: resolved.bindings,
				});
				this.render();
				return;
			}

			await this.executeBinding({
				...resolved,
				key: binding.key,
				name: resolved.name === 'default' ? binding.name : resolved.name,
			});
			return;
		}

		await this.executeBinding(binding);
	}

	private render(): void {
		if (!this.panel || !this.ready || !this.panel.visible) {
			return;
		}

		const levelBindings = this.currentLevelBindings;
		this.currentItems = levelBindings
			.map((binding) => toRenderItem(this, binding))
			.filter((item): item is RenderItem => item !== undefined);

		const current = this.stack[this.stack.length - 1];
		const footerPath = current
			? `SPC ${this.stack.map((binding) => binding.key).join(' ')}-`
			: 'SPC-';
		const footerLabel = current?.name.replace(/^\+/, '') ?? '<leader>';

		const state: ViewState = {
			footerLabel,
			footerPath,
			items: this.currentItems,
		};

		void this.panel.webview.postMessage({
			type: 'render',
			state,
		});
	}

	private trackContextCommand(command: string, arg?: unknown): void {
		if (command !== 'setContext' || !Array.isArray(arg) || arg.length < 2) {
			return;
		}

		const [key, value] = arg;
		if (key === 'doom.bigModeEnabled' && typeof value === 'boolean') {
			this.bigModeEnabled = value;
		}
	}

	private async close(): Promise<void> {
		await this.updateVisibilityContext(false);
		this.panel?.dispose();
	}

	private async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', DoomWhichKeyMenu.visibleContextKey, isVisible);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
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
	<title>Doom Which Key</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: var(--vscode-panel-background);
			--muted: var(--vscode-descriptionForeground);
			--text: var(--vscode-editor-foreground);
			--key: var(--vscode-errorForeground);
			--group: var(--vscode-focusBorder);
			--font-family: var(--vscode-editor-font-family, monospace);
			--font-size: var(--vscode-editor-font-size, 13px);
			--line-height: var(--vscode-editor-line-height, 20px);
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			padding: 6px 8px 2px;
			min-height: 100vh;
			font-family: var(--font-family);
			font-size: var(--font-size);
			line-height: var(--line-height);
			background: var(--bg);
			color: var(--text);
			overflow: hidden;
		}

		.shell {
			display: flex;
			flex-direction: column;
			gap: 4px;
			width: 100%;
			height: calc(100vh - 8px);
		}

		body:focus,
		.shell:focus {
			outline: none;
		}

		.grid {
			--row-count: 1;
			display: grid;
			grid-auto-columns: 248px;
			grid-auto-flow: column;
			grid-template-rows: repeat(var(--row-count), max-content);
			column-gap: 12px;
			row-gap: 1px;
			flex: 1 1 auto;
			overflow: auto;
			align-content: start;
		}

		.item {
			display: flex;
			align-items: center;
			gap: 6px;
			width: 100%;
			padding: 0;
			border: none;
			border-radius: 0;
			background: transparent;
			color: inherit;
			text-align: left;
			cursor: pointer;
			font: inherit;
			margin: 0;
		}

		.item:hover,
		.item:focus-visible {
			outline: none;
			text-decoration: underline;
			text-underline-offset: 2px;
		}

		.key {
			flex: 0 0 auto;
			min-width: 28px;
			color: var(--key);
		}

		.sep {
			color: var(--muted);
		}

		.item.group .label {
			color: var(--group);
		}

		.label {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.empty {
			padding: 6px 0;
			color: var(--muted);
		}

		.footer {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: center;
			column-gap: 12px;
			margin-top: 6px;
			color: var(--muted);
		}

		.path {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.path-label {
			color: var(--text);
		}

		.hint {
			justify-self: end;
			text-align: right;
			white-space: nowrap;
		}

		@media (max-width: 760px) {
			body {
				padding: 6px 6px 2px;
			}

			.grid {
				grid-auto-columns: 208px;
				column-gap: 10px;
			}

			.footer {
				grid-template-columns: minmax(0, 1fr);
				row-gap: 2px;
			}

			.hint {
				justify-self: start;
				text-align: left;
			}
		}
	</style>
</head>
<body tabindex="-1">
	<div class="shell" tabindex="-1">
		<div class="grid" id="grid"></div>
		<div class="empty" id="empty" hidden>No bindings here.</div>
		<div class="footer">
			<div class="path" id="path">SPC- &lt;leader&gt;</div>
			<div class="hint">Type key. Backspace go back. Esc close.</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const shell = document.querySelector('.shell');
		const grid = document.getElementById('grid');
		const empty = document.getElementById('empty');
		const path = document.getElementById('path');
		let items = [];

		function focusMenu() {
			if (shell instanceof HTMLElement) {
				shell.focus({ preventScroll: true });
				return;
			}

			if (document.body instanceof HTMLElement) {
				document.body.focus({ preventScroll: true });
			}
		}

		function updateGridRowCount() {
			if (items.length === 0) {
				grid.style.setProperty('--row-count', '1');
				return;
			}

			const firstItem = grid.querySelector('.item');
			if (!(firstItem instanceof HTMLElement)) {
				grid.style.setProperty('--row-count', String(items.length));
				return;
			}

			const itemHeight = firstItem.offsetHeight || 1;
			const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap || '0') || 0;
			const availableHeight = grid.clientHeight || itemHeight;
			const rows = Math.max(1, Math.floor((availableHeight + rowGap) / (itemHeight + rowGap)));
			grid.style.setProperty('--row-count', String(Math.min(rows, items.length)));
		}

		function layoutGrid() {
			grid.scrollTop = 0;
			grid.scrollLeft = 0;
			updateGridRowCount();
			requestAnimationFrame(() => {
				updateGridRowCount();
			});
		}

		function render(state) {
			items = state.items;
			path.innerHTML = \`<span>\${state.footerPath}</span> <span class="path-label">\${state.footerLabel}</span>\`;
			grid.innerHTML = '';

			if (items.length === 0) {
				empty.hidden = false;
				return;
			}

			empty.hidden = true;

			items.forEach((item, index) => {
				const button = document.createElement('button');
				button.className = item.isGroup ? 'item group' : 'item';
					button.type = 'button';
					button.addEventListener('click', () => {
						vscode.postMessage({ type: 'activate', index });
					});
					button.innerHTML = \`
						<span class="key">\${item.key}</span>
						<span class="sep">:</span>
						<span class="label">\${item.name}</span>
					\`;
					grid.appendChild(button);
			});

			layoutGrid();
			focusMenu();
		}

		function toBindingKey(event) {
			if (event.key === ' ') {
				return 'SPC';
			}

			if (event.key === 'Tab') {
				return 'TAB';
			}

			if (event.key.length === 1) {
				return event.key;
			}

			return null;
		}

		window.addEventListener('message', (event) => {
			if (event.data.type === 'render') {
				render(event.data.state);
			}
		});

		window.addEventListener('keydown', (event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				vscode.postMessage({ type: 'close' });
				return;
			}

			if (event.key === 'Backspace' || event.key === 'ArrowLeft') {
				event.preventDefault();
				vscode.postMessage({ type: 'back' });
				return;
			}

			const bindingKey = toBindingKey(event);
			if (!bindingKey) {
				return;
			}

			const index = items.findIndex((item) => item.key === bindingKey);
			if (index >= 0) {
				event.preventDefault();
				vscode.postMessage({ type: 'activate', index });
			}
		});

		window.addEventListener('resize', layoutGrid);
		window.addEventListener('focus', focusMenu);
		window.addEventListener('load', focusMenu);

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
