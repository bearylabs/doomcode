import * as vscode from 'vscode';
import { createNonce, fuzzyMatch } from '../panel/helpers';

// ---------------------------------------------------------------------------
// Project file models
// ---------------------------------------------------------------------------

interface ProjectFileItem {
	basename: string;
	relativePath: string;
	searchText: string;
	uri: vscode.Uri;
}

interface ProjectFileMatch {
	item: ProjectFileItem;
	matches: number[];
	score: number;
}

interface ProjectFileRenderItem {
	index: number;
	matches: number[];
	path: string;
	type: 'result';
}

interface ProjectFileState {
	activeIndex: number;
	emptyText: string;
	items: ProjectFileRenderItem[];
	placeholder: string;
	promptLabel: string;
	query: string;
	statusLabel: string;
	statusWidthCh: number;
	title: string;
}

interface ProjectFileMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready';
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Webview panel for "Find file in project" — mirrors Doom Emacs `SPC SPC`.
 *
 * Ordering follows Doom / projectile rules:
 *   1. Currently open file tabs (in tab-group order) — equivalent to open buffers.
 *   2. All remaining project files alphabetically.
 *
 * Fuzzy search runs on the full relative path so directory prefixes are matchable.
 * Results are sorted by fuzzy score when a query is present, preserving the MRU
 * ordering for equal-score items (stable sort is guaranteed by V8).
 */
export class DoomProjectFilePanel {
	static readonly visibleContextKey = 'doom.projectFileVisible';

	private static readonly excludeGlob = '**/{.git,node_modules,out,dist,coverage,build,.next}/**';

	private activeIndex = 0;
	private allItems: ProjectFileItem[] = [];
	private filteredItems: ProjectFileMatch[] = [];
	private loading = false;
	private loadSequence = 0;
	private query = '';
	private ready = false;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];
	private workspaceCache: ProjectFileItem[] | undefined;
	private workspaceCacheWatcher: vscode.FileSystemWatcher | undefined;

	/** Resets query/index and validates a workspace exists. Returns false if not. */
	prepareShow(): boolean {
		if (!vscode.workspace.workspaceFolders?.length) {
			void vscode.window.showInformationMessage('Open a folder or workspace first to find project files.');
			return false;
		}

		this.query = '';
		this.activeIndex = 0;
		return true;
	}

	/** Kicks off background file indexing after the panel is revealed. */
	async loadItems(): Promise<void> {
		await this.loadProjectItems();
	}

	/** Wires the panel to an already-created WebviewView. */
	attachToView(webviewView: vscode.WebviewView): void {
		this.resolveWebviewView(webviewView);
	}

	/** Tears down listeners and clears the view ref. */
	detachFromView(): void {
		this.viewDisposables.forEach((d) => d.dispose());
		this.viewDisposables = [];
		this.view = undefined;
		this.ready = false;
	}

	/** Moves the active result by `delta` rows. No-op at list boundaries. */
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
		this.render();
	}

	/** Opens the active result and closes the panel. */
	async activateSelection(): Promise<void> {
		if (!this.view?.visible || this.filteredItems.length === 0) {
			return;
		}

		const item = this.filteredItems[this.activeIndex];
		if (!item) {
			return;
		}

		const uri = item.item.uri;
		await this.close();
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
	}

	/**
	 * Bootstraps the WebviewView: injects HTML, wires dispose/visibility/message listeners.
	 * Re-entrant — cleans up previous listeners first.
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposables.forEach((d) => d.dispose());
		this.viewDisposables = [];
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.title = 'Find File';
		webviewView.description = `Project: ${this.getWorkspaceLabel()}`;

		this.viewDisposables.push(
			webviewView.onDidDispose(() => {
				if (this.view === webviewView) {
					this.view = undefined;
					this.ready = false;
					void this.updateVisibilityContext(false);
				}
			}),
			webviewView.onDidChangeVisibility(() => {
				void this.updateVisibilityContext(webviewView.visible);
				if (webviewView.visible) {
					this.query = '';
					this.activeIndex = 0;
					this.seedItems();
					this.render();
				}
			}),
			webviewView.webview.onDidReceiveMessage((message: ProjectFileMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	/** Syncs the `doom.projectFileVisible` context key so keybindings can scope to panel visibility. */
	private async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', DoomProjectFilePanel.visibleContextKey, isVisible);
	}

	/**
	 * Discovers all workspace files, caches them, and triggers a render.
	 * Subsequent calls reuse the cache; a FileSystemWatcher invalidates it on changes.
	 */
	private async loadProjectItems(): Promise<void> {
		if (this.workspaceCache) {
			this.loading = false;
			this.seedItems();
			this.render();
			return;
		}

		const loadId = ++this.loadSequence;
		this.loading = true;
		this.render();

		const uris = await vscode.workspace.findFiles('**/*', DoomProjectFilePanel.excludeGlob);

		if (loadId !== this.loadSequence) {
			return;
		}

		const items: ProjectFileItem[] = uris
			.filter((uri) => uri.scheme === 'file')
			.map((uri) => {
				const relativePath = vscode.workspace.asRelativePath(uri, false);
				const slashIndex = relativePath.lastIndexOf('/');
				const basename = slashIndex >= 0 ? relativePath.slice(slashIndex + 1) : relativePath;
				return {
					basename,
					relativePath,
					searchText: relativePath.toLowerCase(),
					uri,
				};
			})
			.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

		if (loadId !== this.loadSequence) {
			return;
		}

		this.workspaceCache = items;

		if (!this.workspaceCacheWatcher) {
			this.workspaceCacheWatcher = vscode.workspace.createFileSystemWatcher('**/*');
			const invalidate = (): void => { this.workspaceCache = undefined; };
			this.workspaceCacheWatcher.onDidCreate(invalidate);
			this.workspaceCacheWatcher.onDidDelete(invalidate);
			this.workspaceCacheWatcher.onDidChange(invalidate);
		}

		this.loading = false;
		this.seedItems();
		this.render();
	}

	/**
	 * Builds `allItems` with Doom Emacs MRU ordering:
	 *   1. Currently open file tabs across all groups (in group/tab order).
	 *   2. Remaining project files alphabetically.
	 *
	 * Deduplicates by `fsPath` so the same file doesn't appear twice.
	 */
	private seedItems(): void {
		const projectItems = this.workspaceCache ?? [];
		const seenPaths = new Set<string>();
		const openItems: ProjectFileItem[] = [];

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (!(tab.input instanceof vscode.TabInputText)) {
					continue;
				}

				const uri = tab.input.uri;
				if (seenPaths.has(uri.fsPath)) {
					continue;
				}

				seenPaths.add(uri.fsPath);

				const found = projectItems.find((item) => item.uri.fsPath === uri.fsPath);
				if (found) {
					openItems.push(found);
				} else {
					// File opened but not in workspace (e.g. outside workspace root)
					const relativePath = vscode.workspace.asRelativePath(uri, false);
					const slashIndex = relativePath.lastIndexOf('/');
					const basename = slashIndex >= 0 ? relativePath.slice(slashIndex + 1) : relativePath;
					openItems.push({ basename, relativePath, searchText: relativePath.toLowerCase(), uri });
				}
			}
		}

		const remainingItems = projectItems.filter((item) => !seenPaths.has(item.uri.fsPath));
		this.allItems = [...openItems, ...remainingItems];
		this.filterItems();
	}

	/**
	 * Applies fuzzy filter to `allItems`, capped at 200.
	 * Empty query: shows all items preserving MRU order.
	 * Non-empty query: sorts by fuzzy score (higher = better); MRU items retain priority at equal scores due to stable sort.
	 */
	private filterItems(): void {
		this.activeIndex = 0;
		// Collapse spaces so multi-word queries match across path separators as a single subsequence.
		const query = this.query.trim().toLowerCase().replace(/\s+/g, '');

		if (query.length === 0) {
			this.filteredItems = this.allItems.slice(0, 200).map((item) => ({
				item,
				matches: [],
				score: 0,
			}));
			return;
		}

		this.filteredItems = this.allItems
			.map((item) => {
				const match = fuzzyMatch(item.searchText, query);
				if (!match) {
					return undefined;
				}

				return { item, matches: match.indices, score: match.score };
			})
			.filter((entry): entry is ProjectFileMatch => entry !== undefined)
			.sort((a, b) => b.score - a.score)
			.slice(0, 200);
	}

	/** Dispatches webview messages. */
	private async handleMessage(message: ProjectFileMessage): Promise<void> {
		switch (message.type) {
		case 'ready':
			this.ready = true;
			if (!this.loading) {
				this.seedItems();
			}
			this.render();
			return;
		case 'query':
			this.query = message.query ?? '';
			this.filterItems();
			this.render();
			return;
		case 'move': {
			if (this.filteredItems.length === 0 || message.index === undefined) {
				return;
			}

			this.activeIndex = message.index;
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

	/** Builds the full ProjectFileState and pushes it to the webview. Guards against rendering before 'ready'. */
	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const activeIndex = this.filteredItems.length === 0
			? 0
			: Math.min(this.activeIndex, this.filteredItems.length - 1);
		this.activeIndex = activeIndex;

		const items: ProjectFileRenderItem[] = this.filteredItems.map((entry, index) => ({
			index,
			matches: entry.matches,
			path: entry.item.relativePath,
			type: 'result',
		}));

		const state: ProjectFileState = {
			activeIndex,
			emptyText: this.loading ? 'Loading project files...' : 'No matches.',
			items,
			placeholder: 'Filter files...',
			promptLabel: `[${this.getWorkspaceLabel()}] Find file:`,
			query: this.query,
			statusLabel: this.getStatusLabel(),
			statusWidthCh: this.getStatusWidthCh(),
			title: 'Find File in Project',
		};

		void this.view.webview.postMessage({ type: 'render', state });
	}

	private getStatusLabel(): string {
		const total = this.filteredItems.length;
		return total === 0 ? '0/0' : `${this.activeIndex + 1}/${total}`;
	}

	private getStatusWidthCh(): number {
		const total = Math.max(this.filteredItems.length, 0);
		const digits = Math.max(String(total).length, 1);
		return digits * 2 + 1;
	}

	private getWorkspaceLabel(): string {
		return vscode.workspace.name ?? 'workspace';
	}

	/** Collapses the bottom panel — keeps the webview alive so cache survives the next open. */
	private async close(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
	}

	/**
	 * Generates the full webview HTML. Nonce-locked CSP prevents script injection.
	 * Items are single-column file paths with fuzzy-match highlights.
	 */
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
	<title>Find File in Project</title>
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
			display: block;
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
			width: 100%;
		}

		.content {
			display: inline;
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
			<label class="prompt" id="prompt" for="query">Open:</label>
			<input class="input" id="query" type="text" spellcheck="false" placeholder="Filter files..." />
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

		// Renders text into container, wrapping fuzzy-matched char indices in <span class="match">.
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

		// Full DOM reconcile from state. Skips overwriting the input if focused to avoid caret jump.
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
				const button = document.createElement('button');
				button.type = 'button';
				button.className = item.index === state.activeIndex ? 'item active' : 'item';
				button.dataset.index = String(item.index);

				const content = document.createElement('span');
				content.className = 'content';
				appendHighlightedText(content, item.path, item.matches);

				button.append(content);
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
