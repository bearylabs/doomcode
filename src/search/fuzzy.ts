import * as vscode from 'vscode';

interface SearchItem {
	line: number;
	lineLabel: string;
	searchText: string;
	text: string;
}

interface SearchRenderItem {
	line: number;
	lineLabel: string;
	text: string;
}

interface SearchState {
	activeIndex: number;
	activeLine?: number;
	items: SearchRenderItem[];
	query: string;
	totalLines: number;
}

interface SearchMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready';
}

function getNonce(): string {
	return Math.random().toString(36).slice(2, 12);
}

function fuzzyScore(text: string, query: string): number | undefined {
	if (query.length === 0) {
		return 0;
	}

	let score = 0;
	let queryIndex = 0;
	let streak = 0;
	let firstMatch = -1;

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
		score += 8 + streak * 4;
	}

	if (queryIndex !== query.length) {
		return undefined;
	}

	return score - Math.max(firstMatch, 0);
}

export class DoomFuzzySearchPanel implements vscode.WebviewViewProvider {
	static readonly containerId = 'doomFuzzySearchPanel';
	static readonly viewId = 'doom.fuzzySearchView';

	private accepted = false;
	private activeIndex = 0;
	private currentItems: SearchItem[] = [];
	private filteredItems: SearchItem[] = [];
	private query = '';
	private ready = false;
	private startingSelection: vscode.Selection | undefined;
	private targetEditor: vscode.TextEditor | undefined;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	async show(): Promise<void> {
		if (!this.initializeFromActiveEditor({ notifyWhenMissing: true, resetQuery: true })) {
			return;
		}

		await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
		await vscode.commands.executeCommand(`workbench.view.extension.${DoomFuzzySearchPanel.containerId}`);
		await vscode.commands.executeCommand(`${DoomFuzzySearchPanel.viewId}.focus`);
		this.render();
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = webviewView;
		webviewView.title = 'Fuzzy Search';
		webviewView.description = 'Search current file';
		webviewView.webview.options = {
			enableScripts: true,
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.initializeFromActiveEditor({ resetQuery: true });

		this.viewDisposables.push(
			webviewView.onDidDispose(() => {
				if (this.view === webviewView) {
					this.restoreSelectionIfNeeded();
					this.view = undefined;
					this.ready = false;
				}
			}),
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					this.initializeFromActiveEditor({ resetQuery: true });
					this.render();
					return;
				}

				this.restoreSelectionIfNeeded();
			}),
			webviewView.webview.onDidReceiveMessage((message: SearchMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	private initializeFromActiveEditor(options: {
		notifyWhenMissing?: boolean;
		resetQuery?: boolean;
	} = {}): boolean {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			this.accepted = false;
			this.activeIndex = 0;
			this.currentItems = [];
			this.filteredItems = [];
			this.startingSelection = undefined;
			this.targetEditor = undefined;
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
		this.startingSelection = activeEditor.selection;
		this.targetEditor = activeEditor;
		if (options.resetQuery) {
			this.query = '';
		}
		this.currentItems = this.buildItems(activeEditor.document);
		this.filterItems();
		return true;
	}

	private buildItems(document: vscode.TextDocument): SearchItem[] {
		const lines = document.getText().split(/\r?\n/);
		const lineCountWidth = lines.length.toString().length;

		return lines
			.map((text, index) => ({
				line: index,
				lineLabel: String(index + 1).padStart(lineCountWidth, '0'),
				searchText: text.toLowerCase(),
				text: text.trim(),
			}))
			.filter((item) => item.text.length > 0);
	}

	private filterItems(): void {
		const query = this.query.trim().toLowerCase();
		if (query.length === 0) {
			this.filteredItems = this.currentItems.slice(0, 200);
			return;
		}

		this.filteredItems = this.currentItems
			.map((item) => ({
				item,
				score: fuzzyScore(item.searchText, query),
			}))
			.filter((entry): entry is { item: SearchItem; score: number } => entry.score !== undefined)
			.sort((left, right) => right.score - left.score || left.item.line - right.item.line)
			.slice(0, 200)
			.map((entry) => entry.item);
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
			this.activeIndex = 0;
			this.render();
			if (this.filteredItems.length > 0) {
				await this.revealLine(this.filteredItems[0].line);
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
			await this.revealLine(item.line);
			this.render();
			return;
		}
		case 'activate': {
			if (message.index === undefined) {
				return;
			}

			const item = this.filteredItems[message.index];
			if (!item) {
				return;
			}

			this.accepted = true;
			await this.revealLine(item.line);
			await this.close();
			return;
		}
		case 'close':
			await this.close();
			return;
		default:
			return;
		}
	}

	private async revealLine(line: number): Promise<void> {
		const editor = this.targetEditor;
		if (!editor) {
			return;
		}

		const position = new vscode.Position(line, 0);
		const range = new vscode.Range(position, position);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(position, position);
	}

	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const activeItem = this.filteredItems[this.activeIndex];
		const state: SearchState = {
			activeIndex: this.activeIndex,
			items: this.filteredItems.map((item) => ({
				line: item.line,
				lineLabel: item.lineLabel,
				text: item.text,
			})),
			query: this.query,
			activeLine: activeItem?.line,
			totalLines: this.targetEditor?.document.lineCount ?? 0,
		};

		void this.view.webview.postMessage({
			type: 'render',
			state,
		});
	}

	private restoreSelectionIfNeeded(): void {
		if (this.accepted || !this.startingSelection || !this.targetEditor) {
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
			grid-template-columns: auto 1fr;
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
			background: var(--selected);
			color: var(--selected-text);
			outline: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
			outline-offset: -1px;
		}

		.line {
			color: var(--muted);
			font-variant-numeric: tabular-nums;
			opacity: 0.95;
		}

		.content {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
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
			<label class="prompt" for="query">Go to line:</label>
			<input class="input" id="query" type="text" spellcheck="false" placeholder="Type to fuzzy search current file" />
		</div>
		<div class="results" id="results"></div>
		<div class="empty" id="empty" hidden>No matches.</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const query = document.getElementById('query');
		const results = document.getElementById('results');
		const empty = document.getElementById('empty');
		const status = document.getElementById('status');
		let items = [];

		function render(state) {
			items = state.items;
			if (document.activeElement !== query) {
				query.value = state.query;
			}

			results.innerHTML = '';
			empty.hidden = items.length > 0;
			status.style.width = (String(state.totalLines).length * 2 + 1) + 'ch';
			status.textContent = state.activeLine === undefined
				? '0/' + state.totalLines
				: (state.activeLine + 1) + '/' + state.totalLines;

			items.forEach((item, index) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = index === state.activeIndex ? 'item active' : 'item';

				const line = document.createElement('span');
				line.className = 'line';
				line.textContent = item.lineLabel;

				const content = document.createElement('span');
				content.className = 'content';
				content.textContent = item.text;

				button.append(line, content);
				button.addEventListener('click', () => {
					vscode.postMessage({ type: 'activate', index });
				});
				results.appendChild(button);
			});

			const activeButton = results.children[state.activeIndex];
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
				const activeIndex = Array.from(results.children).findIndex((item) => item.classList.contains('active'));
				vscode.postMessage({ type: 'move', index: Math.min(activeIndex + 1, items.length - 1) });
				return;
			}

			if (event.key === 'ArrowUp' || isCtrlMoveUp) {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Array.from(results.children).findIndex((item) => item.classList.contains('active'));
				vscode.postMessage({ type: 'move', index: Math.max(activeIndex - 1, 0) });
				return;
			}

			if (event.key === 'Enter') {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Array.from(results.children).findIndex((item) => item.classList.contains('active'));
				vscode.postMessage({ type: 'activate', index: Math.max(activeIndex, 0) });
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
