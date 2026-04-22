import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Search models
// ---------------------------------------------------------------------------

interface SearchItem {
	fileLabel?: string;
	line: number;
	lineLabel: string;
	searchText: string;
	text: string;
	uri?: vscode.Uri;
}

interface SearchMatch {
	item: SearchItem;
	matches: number[];
	score: number;
}

interface SearchRenderHeaderItem {
	fileLabel: string;
	type: 'header';
}

interface SearchRenderResultItem {
	index: number;
	lineLabel: string;
	matches: number[];
	text: string;
	type: 'result';
}

type SearchRenderItem = SearchRenderHeaderItem | SearchRenderResultItem;

interface SearchState {
	activeIndex: number;
	emptyText: string;
	items: SearchRenderItem[];
	placeholder: string;
	promptLabel: string;
	query: string;
	statusLabel: string;
	statusWidthCh: number;
	title: string;
}

interface SearchMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready';
}

interface SearchOptions {
	notifyWhenMissing?: boolean;
	resetQuery?: boolean;
}

interface FuzzyMatch {
	indices: number[];
	score: number;
}

type SearchMode = 'editor' | 'workspace';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getNonce(): string {
	return Math.random().toString(36).slice(2, 12);
}

function fuzzyMatch(text: string, query: string): FuzzyMatch | undefined {
	if (query.length === 0) {
		return {
			indices: [],
			score: 0,
		};
	}

	let score = 0;
	let queryIndex = 0;
	let streak = 0;
	let firstMatch = -1;
	const indices: number[] = [];

	for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex++) {
		if (text[textIndex] !== query[queryIndex]) {
			streak = 0;
			continue;
		}

		if (firstMatch === -1) {
			firstMatch = textIndex;
		}

		queryIndex++;
		streak++;
		indices.push(textIndex);
		score += 8 + streak * 4;
	}

	if (queryIndex !== query.length) {
		return undefined;
	}

	return {
		indices,
		score: score - Math.max(firstMatch, 0),
	};
}

export class DoomFuzzySearchPanel {
	static readonly visibleContextKey = 'doom.fuzzySearchVisible';

	private static readonly workspaceExcludeGlob = '**/{.git,node_modules,out,dist,coverage,build,.next}/**';
	private static readonly workspaceFileSizeLimit = 1024 * 1024;

	private accepted = false;
	private activeIndex = 0;
	private currentItems: SearchItem[] = [];
	private filteredItems: SearchMatch[] = [];
	private loadSequence = 0;
	private loading = false;
	private mode: SearchMode = 'editor';
	private query = '';
	private ready = false;
	private startingSelection: vscode.Selection | undefined;
	private targetEditor: vscode.TextEditor | undefined;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	prepareShow(): boolean {
		this.mode = 'editor';
		return this.initializeFromActiveEditor({ notifyWhenMissing: true, resetQuery: true });
	}

	prepareShowWorkspace(): boolean {
		this.mode = 'workspace';
		return this.initializeWorkspaceSearch({ notifyWhenMissing: true, resetQuery: true });
	}

	async loadPreparedWorkspaceItems(): Promise<void> {
		await this.loadWorkspaceItems();
	}

	attachToView(webviewView: vscode.WebviewView): void {
		this.resolveWebviewView(webviewView);
	}

	detachFromView(): void {
		this.restoreSelectionIfNeeded();
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = undefined;
		this.ready = false;
	}

	async moveSelection(delta: number): Promise<void> {
		if (!this.view?.visible || this.filteredItems.length === 0) {
			return;
		}

		const nextIndex = Math.min(
			Math.max(this.activeIndex + delta, 0),
			this.filteredItems.length - 1
		);

		if (nextIndex === this.activeIndex) {
			return;
		}

		this.activeIndex = nextIndex;
		if (this.mode === 'editor') {
			await this.revealEditorLine(this.filteredItems[nextIndex].item.line);
		}
		this.render();
	}

	async activateSelection(): Promise<void> {
		if (!this.view?.visible || this.filteredItems.length === 0) {
			return;
		}

		const item = this.filteredItems[this.activeIndex];
		if (!item) {
			return;
		}

		this.accepted = true;
		if (this.mode === 'workspace') {
			await this.openWorkspaceItem(item.item);
		} else {
			await this.revealEditorLine(item.item.line);
		}
		await this.close();
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
					this.restoreSelectionIfNeeded();
					this.view = undefined;
					this.ready = false;
					void this.updateVisibilityContext(false);
				}
			}),
			webviewView.onDidChangeVisibility(() => {
				void this.updateVisibilityContext(webviewView.visible);
				if (webviewView.visible) {
					void this.refreshVisibleSearch();
					return;
				}

				this.restoreSelectionIfNeeded();
			}),
			webviewView.webview.onDidReceiveMessage((message: SearchMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	private async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', DoomFuzzySearchPanel.visibleContextKey, isVisible);
	}

	private async refreshVisibleSearch(): Promise<void> {
		this.updateViewMetadata();
		if (this.mode === 'workspace') {
			if (!this.initializeWorkspaceSearch({ resetQuery: true })) {
				return;
			}

			this.render();
			await this.loadWorkspaceItems();
			return;
		}

		if (!this.initializeFromActiveEditor({ resetQuery: true })) {
			return;
		}

		this.render();
	}

	private updateViewMetadata(): void {
		if (!this.view) {
			return;
		}

		if (this.mode === 'workspace') {
			this.view.title = 'Project Search';
			this.view.description = `Search project ${this.getWorkspaceLabel()}`;
			return;
		}

		this.view.title = 'Fuzzy Search';
		this.view.description = 'Search current file';
	}

	private initializeFromActiveEditor(options: SearchOptions = {}): boolean {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			this.accepted = false;
			this.activeIndex = 0;
			this.currentItems = [];
			this.filteredItems = [];
			this.startingSelection = undefined;
			this.targetEditor = undefined;
			this.loading = false;
			if (options.resetQuery) {
				this.query = '';
			}
			if (options.notifyWhenMissing) {
				void vscode.window.showInformationMessage('Open a file first to use fuzzy search.');
			}
			return false;
		}

		this.accepted = false;
		this.activeIndex = 0;
		this.loading = false;
		this.startingSelection = activeEditor.selection;
		this.targetEditor = activeEditor;
		if (options.resetQuery) {
			this.query = '';
		}
		this.currentItems = this.buildDocumentItems(activeEditor.document);
		this.filterItems();
		return true;
	}

	private initializeWorkspaceSearch(options: SearchOptions = {}): boolean {
		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			this.accepted = false;
			this.activeIndex = 0;
			this.currentItems = [];
			this.filteredItems = [];
			this.startingSelection = undefined;
			this.targetEditor = undefined;
			this.loading = false;
			if (options.resetQuery) {
				this.query = '';
			}
			if (options.notifyWhenMissing) {
				void vscode.window.showInformationMessage('Open a folder or workspace first to use project search.');
			}
			return false;
		}

		this.accepted = false;
		this.activeIndex = 0;
		this.currentItems = [];
		this.filteredItems = [];
		this.loading = true;
		this.startingSelection = undefined;
		this.targetEditor = undefined;
		if (options.resetQuery) {
			this.query = '';
		}
		return true;
	}

	private buildDocumentItems(document: vscode.TextDocument): SearchItem[] {
		const lines = document.getText().split(/\r?\n/);

		return lines
			.map((text, index) => ({
				line: index,
				lineLabel: String(index + 1),
				searchText: text.trim().toLowerCase(),
				text: text.trim(),
			}))
			.filter((item) => item.text.length > 0);
	}

	private async loadWorkspaceItems(): Promise<void> {
		const loadId = ++this.loadSequence;
		this.loading = true;
		this.render();

		const files = await vscode.workspace.findFiles('**/*', DoomFuzzySearchPanel.workspaceExcludeGlob);
		const items: SearchItem[] = [];

		for (const uri of files) {
			if (loadId !== this.loadSequence || this.mode !== 'workspace') {
				return;
			}

			let stat: vscode.FileStat | undefined;
			try {
				stat = await vscode.workspace.fs.stat(uri);
			} catch {
				stat = undefined;
			}
			if (!stat || stat.size > DoomFuzzySearchPanel.workspaceFileSizeLimit || stat.type !== vscode.FileType.File) {
				continue;
			}

			try {
				const document = await vscode.workspace.openTextDocument(uri);
				const fileItems = this.buildWorkspaceItems(document);
				items.push(...fileItems);
			} catch {
				continue;
			}
		}

		if (loadId !== this.loadSequence || this.mode !== 'workspace') {
			return;
		}

		this.loading = false;
		this.currentItems = items;
		this.filterItems();
		this.render();
	}

	private buildWorkspaceItems(document: vscode.TextDocument): SearchItem[] {
		const lines = document.getText().split(/\r?\n/);
		const fileLabel = vscode.workspace.asRelativePath(document.uri, false);

		return lines
			.map((text, index) => ({
				fileLabel,
				line: index,
				lineLabel: String(index + 1),
				searchText: text.trim().toLowerCase(),
				text: text.trim(),
				uri: document.uri,
			}))
			.filter((item) => item.text.length > 0);
	}

	private filterItems(): void {
		this.activeIndex = 0;
		const query = this.query.trim().toLowerCase();

		if (this.loading) {
			this.filteredItems = [];
			return;
		}

		if (query.length === 0) {
			if (this.mode === 'workspace') {
				this.filteredItems = [];
				return;
			}

			this.filteredItems = this.currentItems
				.slice(0, 200)
				.map((item) => ({
					item,
					matches: [],
					score: 0,
				}));
			return;
		}

		const matches = this.currentItems
			.map((item) => {
				const match = fuzzyMatch(item.searchText, query);
				if (!match) {
					return undefined;
				}

				return {
					item,
					matches: match.indices,
					score: match.score,
				};
			})
			.filter((entry): entry is SearchMatch => entry !== undefined);

		this.filteredItems = this.mode === 'workspace'
			? this.groupWorkspaceMatches(matches).slice(0, 200)
			: matches
				.sort((left, right) => right.score - left.score || left.item.line - right.item.line)
				.slice(0, 200);
	}

	private groupWorkspaceMatches(matches: SearchMatch[]): SearchMatch[] {
		const groups = new Map<string, { fileLabel: string; matches: SearchMatch[]; topScore: number }>();

		for (const match of matches) {
			const fileLabel = match.item.fileLabel ?? '';
			const existing = groups.get(fileLabel);
			if (existing) {
				existing.matches.push(match);
				existing.topScore = Math.max(existing.topScore, match.score);
				continue;
			}

			groups.set(fileLabel, {
				fileLabel,
				matches: [match],
				topScore: match.score,
			});
		}

		return Array.from(groups.values())
			.sort((left, right) => right.topScore - left.topScore || left.fileLabel.localeCompare(right.fileLabel))
			.flatMap((group) => group.matches.sort((left, right) => right.score - left.score || left.item.line - right.item.line));
	}

	private async handleMessage(message: SearchMessage): Promise<void> {
		switch (message.type) {
		case 'ready':
			this.ready = true;
			this.render();
			return;
		case 'query':
			this.query = message.query ?? '';
			this.filterItems();
			this.render();
			if (this.mode === 'editor' && this.filteredItems.length > 0) {
				await this.revealEditorLine(this.filteredItems[0].item.line);
			}
			return;
		case 'move': {
			if (this.filteredItems.length === 0 || message.index === undefined) {
				return;
			}

			const item = this.filteredItems[message.index];
			if (!item) {
				return;
			}

			this.activeIndex = message.index;
			if (this.mode === 'editor') {
				await this.revealEditorLine(item.item.line);
			}
			this.render();
			return;
		}
		case 'activate': {
			if (message.index !== undefined) {
				this.activeIndex = message.index;
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

	private async revealEditorLine(line: number): Promise<void> {
		const editor = this.targetEditor;
		if (!editor) {
			return;
		}

		const position = new vscode.Position(line, 0);
		const range = new vscode.Range(position, position);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(position, position);
	}

	private async openWorkspaceItem(item: SearchItem): Promise<void> {
		if (!item.uri) {
			return;
		}

		const document = await vscode.workspace.openTextDocument(item.uri);
		const editor = await vscode.window.showTextDocument(document, {
			preview: false,
			preserveFocus: false,
		});
		const position = new vscode.Position(item.line, 0);
		const range = new vscode.Range(position, position);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(position, position);
	}

	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const activeIndex = this.filteredItems.length === 0
			? 0
			: Math.min(this.activeIndex, this.filteredItems.length - 1);
		this.activeIndex = activeIndex;

		const state: SearchState = {
			activeIndex,
			emptyText: this.getEmptyText(),
			items: this.toRenderItems(),
			placeholder: this.mode === 'workspace'
				? 'Type to fuzzy search project'
				: 'Type to fuzzy search current file',
			promptLabel: this.mode === 'workspace'
				? `Search (Project ${this.getWorkspaceLabel()}):`
				: 'Go to line:',
			query: this.query,
			statusLabel: this.getStatusLabel(),
			statusWidthCh: this.getStatusWidthCh(),
			title: this.mode === 'workspace' ? 'Project Search' : 'Fuzzy Search',
		};

		void this.view.webview.postMessage({
			type: 'render',
			state,
		});
	}

	private toRenderItems(): SearchRenderItem[] {
		if (this.mode !== 'workspace') {
			return this.filteredItems.map((entry, index) => ({
				index,
				lineLabel: entry.item.lineLabel,
				matches: entry.matches,
				text: entry.item.text,
				type: 'result',
			}));
		}

		const items: SearchRenderItem[] = [];
		let currentFile = '';

		this.filteredItems.forEach((entry, index) => {
			const fileLabel = entry.item.fileLabel ?? '';
			if (fileLabel !== currentFile) {
				currentFile = fileLabel;
				items.push({
					fileLabel,
					type: 'header',
				});
			}

			items.push({
				index,
				lineLabel: entry.item.lineLabel,
				matches: entry.matches,
				text: entry.item.text,
				type: 'result',
			});
		});

		return items;
	}

	private getStatusLabel(): string {
		if (this.mode === 'workspace') {
			const total = this.filteredItems.length;
			if (total === 0) {
				return '0/0';
			}

			return `${this.activeIndex + 1}/${total}`;
		}

		const totalLines = this.targetEditor?.document.lineCount ?? 0;
		const activeItem = this.filteredItems[this.activeIndex]?.item;
		return activeItem ? `${activeItem.line + 1}/${totalLines}` : `0/${totalLines}`;
	}

	private getStatusWidthCh(): number {
		if (this.mode === 'workspace') {
			const total = Math.max(this.filteredItems.length, 0);
			const digits = Math.max(String(total).length, 1);
			return digits * 2 + 1;
		}

		const totalLines = Math.max(this.targetEditor?.document.lineCount ?? 0, 0);
		const digits = Math.max(String(totalLines).length, 1);
		return digits * 2 + 1;
	}

	private getEmptyText(): string {
		if (this.loading) {
			return 'Loading project files...';
		}

		if (this.mode === 'workspace' && this.query.trim().length === 0) {
			return 'Type to fuzzy search project.';
		}

		return 'No matches.';
	}

	private getWorkspaceLabel(): string {
		return vscode.workspace.name ?? 'workspace';
	}

	private restoreSelectionIfNeeded(): void {
		if (this.mode !== 'editor' || this.accepted || !this.startingSelection || !this.targetEditor) {
			return;
		}

		const range = new vscode.Range(this.startingSelection.start, this.startingSelection.end);
		this.targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		this.targetEditor.selection = this.startingSelection;
	}

	private async close(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
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
	<title>Fuzzy Search</title>
	<style>
		html {
			height: 100%;
		}

		:root {
			color-scheme: dark;
			--bg: var(--vscode-editorWidget-background, var(--vscode-editor-background));
			--chrome: color-mix(in srgb, var(--bg) 92%, white 8%);
			--border: var(--vscode-panel-border, color-mix(in srgb, var(--bg) 82%, white 18%));
			--input-fg: var(--vscode-input-foreground, var(--vscode-editor-foreground));
			--muted: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
			--text: var(--vscode-editor-foreground);
			--selected: var(--vscode-editor-lineHighlightBackground, color-mix(in srgb, var(--bg) 80%, white 20%));
			--selected-text: var(--vscode-editor-foreground);
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
			overflow: hidden;
		}

		.promptbar {
			display: grid;
			grid-template-columns: auto auto 1fr;
			align-items: center;
			gap: 8px;
			min-height: calc(var(--line-height) + 8px);
			padding: 2px 8px;
			background: var(--bg);
		}

		.status,
		.prompt {
			color: var(--muted);
			white-space: nowrap;
		}

		.status {
			font-variant-numeric: tabular-nums;
			text-align: right;
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

		.results {
			flex: 1 1 0;
			min-height: 0;
			overflow: auto;
			display: flex;
			flex-direction: column;
			padding: 2px 0 0;
		}

		.item {
			display: grid;
			grid-template-columns: minmax(4ch, auto) 1fr;
			align-items: baseline;
			gap: 12px;
			flex: 0 0 auto;
			padding: 0 10px;
			border: none;
			background: transparent;
			color: inherit;
			text-align: left;
			font: inherit;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.item.active {
			color: inherit;
		}

		.group {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 4px 8px 0;
			color: var(--muted);
			font-style: italic;
		}

		.group::before {
			content: '';
			flex: 0 0 auto;
			width: 5ch;
			border-top: 1px solid var(--border);
			opacity: 0.8;
		}

		.group::after {
			content: '';
			flex: 1 1 auto;
			border-top: 1px solid var(--border);
			opacity: 0.8;
		}

		.group-label {
			white-space: nowrap;
			color: color-mix(in srgb, var(--accent) 65%, var(--text));
		}

		.line {
			color: var(--muted);
			font-variant-numeric: tabular-nums;
			justify-self: end;
			text-align: right;
			opacity: 0.95;
		}

		.content {
			display: block;
			min-width: 0;
			padding-left: 5px;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.item.active .content {
			background: var(--selected);
			color: var(--selected-text);
			outline: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
			outline-offset: -1px;
		}

		.match {
			background: var(--match-bg);
			color: var(--match-fg);
		}

		.empty {
			color: var(--muted);
			white-space: nowrap;
			padding: 0 10px;
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="promptbar">
			<div class="status" id="status">0/0</div>
			<label class="prompt" id="prompt" for="query">Go to line:</label>
			<input class="input" id="query" type="text" spellcheck="false" placeholder="Type to fuzzy search current file" />
		</div>
		<div class="results" id="results"></div>
		<div class="empty" id="empty" hidden>No matches.</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const empty = document.getElementById('empty');
		const prompt = document.getElementById('prompt');
		const query = document.getElementById('query');
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
			prompt.textContent = state.promptLabel;
			query.placeholder = state.placeholder;
			empty.textContent = state.emptyText;

			if (document.activeElement !== query) {
				query.value = state.query;
			}

			results.innerHTML = '';
			empty.hidden = items.length > 0;
			status.style.width = state.statusWidthCh + 'ch';
			status.textContent = state.statusLabel;

			items.forEach((item) => {
				if (item.type === 'header') {
					const header = document.createElement('div');
					header.className = 'group';

					const label = document.createElement('span');
					label.className = 'group-label';
					label.textContent = item.fileLabel;
					header.append(label);
					results.appendChild(header);
					return;
				}

				const button = document.createElement('button');
				button.type = 'button';
				button.className = item.index === state.activeIndex ? 'item active' : 'item';
				button.dataset.index = String(item.index);

				const line = document.createElement('span');
				line.className = 'line';
				line.textContent = item.lineLabel;

				const content = document.createElement('span');
				content.className = 'content';
				appendHighlightedText(content, item.text, item.matches);

				button.append(line, content);
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
				const resultItems = items.filter((item) => item.type === 'result');
				if (resultItems.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'move', index: Math.min(activeIndex + 1, resultItems.length - 1) });
				return;
			}

			if (event.key === 'ArrowUp' || isCtrlMoveUp) {
				const resultItems = items.filter((item) => item.type === 'result');
				if (resultItems.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'move', index: Math.max(activeIndex - 1, 0) });
				return;
			}

			if (event.key === 'Enter') {
				const resultItems = items.filter((item) => item.type === 'result');
				if (resultItems.length === 0) {
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
