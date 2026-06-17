import * as vscode from 'vscode';
import { DoomWebviewController } from '../panel/controller';
import { createNonce, createPanelHtml, substringMatch } from '../panel/helpers';

interface WorkspaceTextSearchResult {
	rel: string;
	line: number;
	text: string;
}

const MAX_RESULTS = 200;

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

interface SearchOptions {
	notifyWhenMissing?: boolean;
	resetQuery?: boolean;
}

type SearchMode = 'editor' | 'workspace';

/** Line-number + content layout, plus the workspace file-group header rows. */
const SEARCH_LAYOUT_CSS = `		.item {
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
		}`;

/** Builds a workspace file-group header or a line-number + highlighted-content row. */
const SEARCH_RENDER_ITEM = `				if (item.type === 'header') {
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
				results.appendChild(button);`;

export class DoomSearchPanel extends DoomWebviewController {
	static readonly visibleContextKey = 'doom.fuzzySearchVisible';

	protected readonly visibleContextKey = DoomSearchPanel.visibleContextKey;

	private static readonly workspaceExcludeGlob = '**/{.git,node_modules,out,dist,coverage,build,.next}/**';

	private accepted = false;
	private currentItems: SearchItem[] = [];
	private filteredItems: SearchMatch[] = [];
	private loading = false;
	private mode: SearchMode = 'editor';
	private resultsCapped = false;
	private searchCanceller: vscode.CancellationTokenSource | undefined;
	private searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private startingSelection: vscode.Selection | undefined;
	private targetEditor: vscode.TextEditor | undefined;

	constructor() {
		super();
	}

	/** Switches to editor mode and seeds search state from the active editor. Returns false if no editor is open. */
	prepareShow(): boolean {
		this.mode = 'editor';
		return this.initializeFromActiveEditor({ notifyWhenMissing: true, resetQuery: true });
	}

	/** Switches to workspace mode and primes state for a workspace search. Returns false if no folder is open. */
	prepareShowWorkspace(): boolean {
		this.mode = 'workspace';
		return this.initializeWorkspaceSearch({ notifyWhenMissing: true, resetQuery: true });
	}

	protected get itemCount(): number {
		return this.filteredItems.length;
	}

	/** Confirms the active result: opens the file/line and closes the panel. Sets `accepted` to suppress selection restore. */
	protected async activateSelection(): Promise<void> {
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
			this.revealEditorLine(item.item.line);
		}
		await this.close();
	}

	/** Live-previews the active line in editor mode after a query/move render. Skips the initial reveal. */
	protected async afterRender(initial: boolean): Promise<void> {
		if (initial || this.mode !== 'editor' || this.filteredItems.length === 0) {
			return;
		}

		this.revealEditorLine(this.filteredItems[this.activeIndex].item.line);
	}

	/** Restores the pre-search selection when the panel is detached. */
	protected onDetach(): void {
		this.restoreSelectionIfNeeded();
	}

	/** Restores the pre-search selection when the underlying view is disposed. */
	protected onDispose(): void {
		this.restoreSelectionIfNeeded();
	}

	/** Re-initializes on reveal, or restores the pre-search selection on hide. */
	protected onVisibilityChanged(visible: boolean): void {
		if (visible) {
			void this.refreshVisibleSearch();
			return;
		}

		this.restoreSelectionIfNeeded();
	}

	/** Re-initializes and re-renders when the panel becomes visible again — handles both modes. */
	private refreshVisibleSearch(): void {
		this.updateViewMetadata();
		if (this.mode === 'workspace') {
			if (!this.initializeWorkspaceSearch({ resetQuery: true })) {
				return;
			}

			this.render();
			return;
		}

		if (!this.initializeFromActiveEditor({ resetQuery: true })) {
			return;
		}

		this.render();
	}

	/** Stamps mode-appropriate title and description onto the sidebar pane header. */
	protected updateViewMetadata(): void {
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

	/**
	 * Resets all search state and loads lines from the currently active editor.
	 * Snapshots the starting selection so it can be restored on cancel.
	 * Returns false (and optionally notifies) when no editor is open.
	 */
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
				void vscode.window.showInformationMessage('Open a file first to use search.');
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

	/**
	 * Resets state for a fresh workspace search. Items are empty until a query triggers `runWorkspaceSearch`.
	 * Returns false (and optionally notifies) when no workspace folder exists.
	 */
	private initializeWorkspaceSearch(options: SearchOptions = {}): boolean {
		this.searchCanceller?.cancel();
		this.searchCanceller = undefined;
		if (this.searchDebounceTimer !== undefined) {
			clearTimeout(this.searchDebounceTimer);
			this.searchDebounceTimer = undefined;
		}

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
		this.loading = false;
		this.startingSelection = undefined;
		this.targetEditor = undefined;
		if (options.resetQuery) {
			this.query = '';
		}
		return true;
	}

	/** Overrides base query handler to debounce and delegate to `findTextInFiles` in workspace mode. */
	protected async onQuery(query: string): Promise<void> {
		this.query = query;
		if (this.mode !== 'workspace') {
			this.filterItems();
			this.render();
			await this.afterRender(false);
			return;
		}

		this.searchCanceller?.cancel();
		this.searchCanceller = undefined;
		if (this.searchDebounceTimer !== undefined) {
			clearTimeout(this.searchDebounceTimer);
			this.searchDebounceTimer = undefined;
		}

		if (query.trim().length < 2) {
			this.loading = false;
			this.currentItems = [];
			this.filterItems();
			this.render();
			return;
		}

		this.loading = true;
		this.currentItems = [];
		this.render();

		this.searchDebounceTimer = setTimeout(() => {
			this.searchDebounceTimer = undefined;
			void this.runWorkspaceSearch(query);
		}, 200);
	}

	/** Runs a text search via the `doom-workspace` sidecar, discards result if superseded. */
	private async runWorkspaceSearch(query: string): Promise<void> {
		const canceller = new vscode.CancellationTokenSource();
		this.searchCanceller = canceller;

		const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		let rawResults: WorkspaceTextSearchResult[] = [];

		if (rootUri) {
			try {
				rawResults = await vscode.commands.executeCommand<WorkspaceTextSearchResult[]>(
					'doom-workspace.searchText',
					rootUri.toString(),
					query,
					MAX_RESULTS,
				) ?? [];
			} catch {
				// doom-workspace not installed or search failed — show empty results.
			}
		}

		if (canceller.token.isCancellationRequested) {
			canceller.dispose();
			return;
		}

		canceller.dispose();
		this.searchCanceller = undefined;
		this.resultsCapped = rawResults.length >= MAX_RESULTS;
		this.loading = false;
		this.currentItems = rawResults.map(r => ({
			uri: vscode.Uri.joinPath(rootUri!, r.rel),
			fileLabel: r.rel,
			line: r.line,
			lineLabel: String(r.line + 1),
			text: r.text,
			searchText: r.text.toLowerCase(),
		}));
		this.filterItems();
		this.render();
	}

	/** Splits a document into trimmed, non-empty line items for editor-mode search. */
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

	/**
	 * Applies fuzzy filter to `currentItems` and caps results at MAX_RESULTS.
	 * Editor mode: shows first MAX_RESULTS lines unranked for queries < 2 chars, then sorts by line number.
	 * Workspace mode: shows nothing until 2+ chars are typed, then groups by file via `groupWorkspaceMatches`.
	 */
	protected filterItems(): void {
		this.activeIndex = 0;
		const query = this.query.trim().toLowerCase();

		if (this.loading) {
			this.filteredItems = [];
			return;
		}

		if (query.length < 2) {
			if (this.mode === 'workspace') {
				this.filteredItems = [];
				return;
			}

			this.filteredItems = this.currentItems
				.slice(0, MAX_RESULTS)
				.map((item) => ({
					item,
					matches: [],
					score: 0,
				}));
			return;
		}

		const matches = this.currentItems
			.map((item) => {
				const match = substringMatch(item.searchText, query);
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
			? this.groupWorkspaceMatches(matches).slice(0, MAX_RESULTS)
			: matches
				.sort((left, right) => left.item.line - right.item.line)
				.slice(0, MAX_RESULTS);
	}

	/** Groups matches by file (alphabetically), with lines within each file sorted by line number. */
	private groupWorkspaceMatches(matches: SearchMatch[]): SearchMatch[] {
		const groups = new Map<string, { fileLabel: string; matches: SearchMatch[] }>();

		for (const match of matches) {
			const fileLabel = match.item.fileLabel ?? '';
			const existing = groups.get(fileLabel);
			if (existing) {
				existing.matches.push(match);
				continue;
			}

			groups.set(fileLabel, {
				fileLabel,
				matches: [match],
			});
		}

		return Array.from(groups.values())
			.sort((left, right) => left.fileLabel.localeCompare(right.fileLabel))
			.flatMap((group) => group.matches.sort((left, right) => left.item.line - right.item.line));
	}

	/** Scrolls the target editor to `line` and moves the cursor there for live preview during navigation. */
	private revealEditorLine(line: number): void {
		const editor = this.targetEditor;
		if (!editor) {
			return;
		}

		const position = new vscode.Position(line, 0);
		const range = new vscode.Range(position, position);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		editor.selection = new vscode.Selection(position, position);
	}

	/** Opens a workspace file in a non-preview editor tab and jumps to the matched line. */
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

	/** Builds the full SearchState. Clamps `activeIndex` into range first. */
	protected buildRenderState(): SearchState {
		const activeIndex = this.filteredItems.length === 0
			? 0
			: Math.min(this.activeIndex, this.filteredItems.length - 1);
		this.activeIndex = activeIndex;

		return {
			activeIndex,
			emptyText: this.getEmptyText(),
			items: this.toRenderItems(),
			placeholder: this.mode === 'workspace'
				? 'Type to search project'
				: 'Type to search current file',
			promptLabel: this.mode === 'workspace'
				? `Search (Project ${this.getWorkspaceLabel()}):`
				: 'Go to line:',
			query: this.query,
			statusLabel: this.getStatusLabel(),
			statusWidthCh: this.getStatusWidthCh(),
			title: this.mode === 'workspace' ? 'Project Search' : 'Fuzzy Search',
		};
	}

	/** Converts filtered matches to the render model. In workspace mode inserts file header rows on group boundaries. */
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

	/** Returns the "N/M" status string — workspace uses match count, editor uses absolute line number. */
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

	/** Computes a fixed CSS `ch` width for the status column so it never causes layout shift as numbers change. */
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

	/** Returns the appropriate empty-state message depending on load state, mode, and query length. */
	private getEmptyText(): string {
		if (this.loading) {
			return 'Loading project files...';
		}

		if (this.mode === 'workspace' && this.query.trim().length === 0) {
			return 'Type to search project.';
		}

		return 'No matches.';
	}

	/** Returns the workspace name for UI labels, falling back to 'workspace' if unnamed. */
	private getWorkspaceLabel(): string {
		return vscode.workspace.name ?? 'workspace';
	}

	/** Scrolls the editor back to the pre-search cursor position when the user dismisses without confirming. */
	private restoreSelectionIfNeeded(): void {
		if (this.mode !== 'editor' || this.accepted || !this.startingSelection || !this.targetEditor) {
			return;
		}

		const range = new vscode.Range(this.startingSelection.start, this.startingSelection.end);
		this.targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		this.targetEditor.selection = this.startingSelection;
	}

	protected getHtml(webview: vscode.Webview): string {
		return createPanelHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			title: 'Fuzzy Search',
			layoutCss: SEARCH_LAYOUT_CSS,
			renderItem: SEARCH_RENDER_ITEM,
		});
	}
}
