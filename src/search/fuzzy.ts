import * as vscode from 'vscode';

interface SearchItem {
	label: string;
	line: number;
	searchText: string;
}

interface SearchRenderItem {
	label: string;
	line: number;
}

interface SearchState {
	activeIndex: number;
	items: SearchRenderItem[];
	query: string;
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
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			void vscode.window.showInformationMessage('Open a file first to use fuzzy search.');
			return;
		}

		this.targetEditor = activeEditor;
		this.startingSelection = activeEditor.selection;
		this.accepted = false;
		this.activeIndex = 0;
		this.query = '';
		this.currentItems = this.buildItems(activeEditor.document);
		this.filteredItems = this.currentItems.slice(0, 200);

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

	private buildItems(document: vscode.TextDocument): SearchItem[] {
		const lines = document.getText().split(/\r?\n/);
		const lineCountWidth = lines.length.toString().length;

		return lines
			.map((text, index) => ({
				label: `${String(index + 1).padStart(lineCountWidth, '0')}: ${text.trim()}`,
				line: index,
				searchText: text.toLowerCase(),
			}))
			.filter((item) => item.label.trim().length > lineCountWidth + 1);
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

		const state: SearchState = {
			activeIndex: this.activeIndex,
			items: this.filteredItems.map((item) => ({
				label: item.label,
				line: item.line,
			})),
			query: this.query,
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
			--bg: var(--vscode-panel-background);
			--border: var(--vscode-panel-border, transparent);
			--input-bg: var(--vscode-input-background);
			--input-fg: var(--vscode-input-foreground);
			--muted: var(--vscode-descriptionForeground);
			--text: var(--vscode-editor-foreground);
			--selected: var(--vscode-list-activeSelectionBackground);
			--selected-text: var(--vscode-list-activeSelectionForeground);
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
			gap: 6px;
			flex: 1 1 auto;
			min-height: 0;
			overflow: hidden;
		}

		.input {
			width: 100%;
			padding: 2px 6px;
			border: 1px solid var(--border);
			background: var(--input-bg);
			color: var(--input-fg);
			font: inherit;
		}

		.results {
			flex: 1 1 0;
			min-height: 0;
			overflow: auto;
			display: flex;
			flex-direction: column;
			gap: 1px;
		}

		.item {
			flex: 0 0 auto;
			padding: 0;
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
		}

		.empty,
		.footer {
			color: var(--muted);
			white-space: nowrap;
		}

		.footer {
			display: flex;
			justify-content: space-between;
			gap: 12px;
		}
	</style>
</head>
<body>
	<div class="shell">
		<input class="input" id="query" type="text" spellcheck="false" placeholder="Type to fuzzy search current file" />
		<div class="results" id="results"></div>
		<div class="empty" id="empty" hidden>No matches.</div>
		<div class="footer">
			<div>Current file</div>
			<div>Enter jump. Esc close.</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const query = document.getElementById('query');
		const results = document.getElementById('results');
		const empty = document.getElementById('empty');
		let items = [];

		function render(state) {
			items = state.items;
			if (document.activeElement !== query) {
				query.value = state.query;
			}

			results.innerHTML = '';
			empty.hidden = items.length > 0;

			items.forEach((item, index) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = index === state.activeIndex ? 'item active' : 'item';
				button.textContent = item.label;
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
