import * as vscode from 'vscode';
import { executeWhichKeyBindingCommands } from './bindings';
import {
    getFlattenedWhichKeyBindings,
    type WhichKeyExecutableBinding,
} from './showBindings';

// ---------------------------------------------------------------------------
// Which-key binding picker models
// ---------------------------------------------------------------------------

interface WhichKeyBindingMatch {
	index: number;
	item: WhichKeyExecutableBinding;
	matches: number[];
	score: number;
}

interface WhichKeyBindingsState {
	activeIndex: number;
	emptyText: string;
	items: Array<{
		detail: string;
		index: number;
		matches: number[];
		name: string;
		path: string;
	}>;
	promptLabel: string;
	placeholder: string;
	query: string;
	statusLabel: string;
	title: string;
}

interface WhichKeyBindingsMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready';
}

interface FuzzyMatch {
	indices: number[];
	score: number;
}

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

// ---------------------------------------------------------------------------
// Which-key bindings panel
// ---------------------------------------------------------------------------

export class DoomWhichKeyBindingsPanel {
	private activeIndex = 0;
	private bindings: WhichKeyExecutableBinding[] = [];
	private matches: WhichKeyBindingMatch[] = [];
	private query = '';
	private ready = false;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	prepareShow(resetQuery = true): void {
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
			webviewView.webview.onDidReceiveMessage((message: WhichKeyBindingsMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	private updateViewMetadata(): void {
		if (!this.view) {
			return;
		}

		this.view.title = 'Show bindings';
		this.view.description = 'Which-key command list';
	}

	private refreshItems(): void {
		this.bindings = getFlattenedWhichKeyBindings();
		this.filterItems();
	}

	private filterItems(): void {
		const query = this.query.trim().toLowerCase();
		const matches = this.bindings
			.map((item, index) => {
				if (query.length === 0) {
					return {
						index,
						item,
						matches: [],
						score: 0,
					};
				}

				const searchMatch = fuzzyMatch(item.searchText, query);
				if (!searchMatch) {
					return undefined;
				}

				const pathMatch = fuzzyMatch(item.path.toLowerCase(), query);
				return {
					index,
					item,
					matches: pathMatch?.indices ?? [],
					score: searchMatch.score,
				};
			})
			.filter((entry): entry is WhichKeyBindingMatch => entry !== undefined);

		this.matches = query.length === 0
			? matches
			: matches.sort(
				(left, right) => right.score - left.score
					|| left.item.path.localeCompare(right.item.path)
					|| left.item.name.localeCompare(right.item.name)
			);

		this.activeIndex = this.matches.length === 0
			? 0
			: Math.min(this.activeIndex, this.matches.length - 1);
	}

	private async handleMessage(message: WhichKeyBindingsMessage): Promise<void> {
		switch (message.type) {
		case 'ready':
			this.ready = true;
			this.render();
			return;
		case 'query':
			this.query = message.query ?? '';
			this.filterItems();
			this.render();
			return;
		case 'move': {
			if (this.matches.length === 0 || message.index === undefined) {
				return;
			}

			this.activeIndex = Math.min(Math.max(message.index, 0), this.matches.length - 1);
			this.render();
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

		await executeWhichKeyBindingCommands(match.item.binding);
		await this.close();
	}

	private async close(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
	}

	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const state: WhichKeyBindingsState = {
			activeIndex: this.matches.length === 0
				? 0
				: Math.min(this.activeIndex, this.matches.length - 1),
			emptyText: this.matches.length === 0 ? 'No which-key bindings match.' : '',
			items: this.matches.map((entry, index) => ({
				detail: entry.item.detail,
				index,
				matches: entry.matches,
				name: entry.item.name,
				path: entry.item.path,
			})),
			promptLabel: 'Show bindings:',
			placeholder: 'Type to narrow which-key bindings',
			query: this.query,
			statusLabel: `${this.matches.length === 0 ? 0 : this.activeIndex + 1}/${this.matches.length}`,
			title: 'Which-Key Bindings',
		};

		this.activeIndex = state.activeIndex;

		void this.view.webview.postMessage({
			type: 'render',
			state,
		});
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
	<title>Which-Key Bindings</title>
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
			grid-template-columns: minmax(16ch, 24ch) minmax(18ch, 26ch) minmax(0, 1fr);
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

		.path,
		.name,
		.detail {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.name,
		.detail {
			color: var(--muted);
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
			<div class="prompt" id="prompt">Show bindings:</div>
			<input class="input" id="query" type="text" spellcheck="false" placeholder="Type to narrow which-key bindings" />
		</div>
		<div class="results" id="results"></div>
		<div class="empty" id="empty" hidden>No which-key bindings match.</div>
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

				const path = document.createElement('span');
				path.className = 'path';
				appendHighlightedText(path, item.path, item.matches);

				const name = document.createElement('span');
				name.className = 'name';
				name.textContent = item.name;

				const detail = document.createElement('span');
				detail.className = 'detail';
				detail.textContent = item.detail;

				button.append(path, name, detail);
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