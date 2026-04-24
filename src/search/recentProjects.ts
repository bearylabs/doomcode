import * as vscode from 'vscode';
import { createFilePickerHtml, createNonce, formatRelativeTime, fuzzyMatch } from '../panel/helpers';

// ---------------------------------------------------------------------------
// Recent project models
// ---------------------------------------------------------------------------

export interface RecentProjectItem {
	label: string;
	/** Unix timestamp (ms) of the workspace folder/file mtime, or undefined if stat failed. */
	lastModifiedMs: number | undefined;
	path: string;
	/** Concatenation `label + ' ' + path` (lower-cased) used as the fuzzy search target. */
	searchText: string;
	uri: vscode.Uri;
}

interface RecentProjectMatch {
	item: RecentProjectItem;
	/** Match indices into `item.label`. */
	labelMatches: number[];
	/** Match indices into `item.path`. */
	pathMatches: number[];
	score: number;
}

interface RecentProjectRenderItem {
	index: number;
	lastModified: string;
	matches: number[];
	path: string;
	type: 'result';
}

interface RecentProjectState {
	activeIndex: number;
	emptyText: string;
	items: RecentProjectRenderItem[];
	placeholder: string;
	promptLabel: string;
	query: string;
	statusLabel: string;
	statusWidthCh: number;
	title: string;
}

interface RecentProjectMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready';
}

// ---------------------------------------------------------------------------
// Loader (exported for reuse outside this panel)
// ---------------------------------------------------------------------------

// Internal VS Code API shape — intentionally loose so forward-compat breakage is limited.
type RawRecentEntry =
	| { folderUri: unknown; label?: string }
	| { workspace: { configPath: unknown }; label?: string };

function extractEntryUri(entry: RawRecentEntry): vscode.Uri | undefined {
	if ('folderUri' in entry && entry.folderUri instanceof vscode.Uri) {
		return entry.folderUri;
	}

	if ('workspace' in entry && entry.workspace.configPath instanceof vscode.Uri) {
		return entry.workspace.configPath;
	}

	return undefined;
}

/**
 * Returns recent workspace/folder entries from VS Code's built-in MRU list.
 * Uses the internal `_workbench.getRecentlyOpened` command which has been stable
 * across VS Code versions and is widely used by other extensions.
 * Items arrive in MRU order (most recently opened first).
 */
export async function getRecentProjects(): Promise<RecentProjectItem[]> {
	let raw: unknown;
	try {
		raw = await vscode.commands.executeCommand('_workbench.getRecentlyOpened');
	} catch {
		return [];
	}

	if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { workspaces?: unknown }).workspaces)) {
		return [];
	}

	const entries = (raw as { workspaces: RawRecentEntry[] }).workspaces;

	// Build items first, then stat all paths in parallel.
	const uriList: Array<{ uri: vscode.Uri; label: string; path: string }> = [];

	for (const entry of entries) {
		const uri = extractEntryUri(entry);
		if (!uri) {
			continue;
		}

		const path = uri.fsPath.replace(/\\/g, '/');
		const basename = path.split('/').filter(Boolean).pop() ?? path;
		const label = entry.label ?? basename;
		uriList.push({ uri, label, path });
	}

	const stats = await Promise.allSettled(
		uriList.map(({ uri }) => vscode.workspace.fs.stat(uri))
	);

	return uriList.map(({ uri, label, path }, i) => {
		const stat = stats[i];
		const lastModifiedMs = stat.status === 'fulfilled' ? stat.value.mtime : undefined;
		return {
			label,
			lastModifiedMs,
			path,
			searchText: `${label} ${path}`.toLowerCase(),
			uri,
		};
	});
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Reusable webview panel that lists recent workspaces/folders.
 *
 * Implements the same `attachToView` / `detachFromView` contract as other
 * Doom panels so it can be dropped into any `DoomSharedPanel` slot.
 * Selecting an entry opens the workspace in the current window.
 */
export class DoomRecentProjectsPanel {
	static readonly visibleContextKey = 'doom.recentProjectsVisible';

	private activeIndex = 0;
	private allItems: RecentProjectItem[] = [];
	private filteredItems: RecentProjectMatch[] = [];
	private loading = false;
	private query = '';
	private ready = false;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	/** Resets state. Always returns true — no precondition needed. */
	prepareShow(): boolean {
		this.query = '';
		this.activeIndex = 0;
		this.allItems = [];
		this.filteredItems = [];
		return true;
	}

	/** Loads recent projects from VS Code's MRU list and renders them. */
	async loadItems(): Promise<void> {
		this.loading = true;
		this.render();
		this.allItems = await getRecentProjects();
		this.loading = false;
		this.filterItems();
		this.render();
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

	/** Opens the selected workspace in the current window and closes the panel. */
	async activateSelection(): Promise<void> {
		if (!this.view?.visible || this.filteredItems.length === 0) {
			return;
		}

		const item = this.filteredItems[this.activeIndex];
		if (!item) {
			return;
		}

		await this.close();
		await vscode.commands.executeCommand('vscode.openFolder', item.item.uri, { forceReuseWindow: true });
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
		webviewView.title = 'Open Recent';
		webviewView.description = 'Select a workspace';

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
			}),
			webviewView.webview.onDidReceiveMessage((message: RecentProjectMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	/** Syncs the `doom.recentProjectsVisible` context key. */
	private async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', DoomRecentProjectsPanel.visibleContextKey, isVisible);
	}

	/**
	 * Fuzzy-filters `allItems` (already in MRU order).
	 * Runs against `searchText` (label + path); splits match indices into separate
	 * label and path arrays so both portions can be highlighted independently.
	 * Spaces in the query are collapsed before matching.
	 */
	private filterItems(): void {
		this.activeIndex = 0;
		const query = this.query.trim().toLowerCase().replace(/\s+/g, '');

		if (query.length === 0) {
			this.filteredItems = this.allItems.map((item) => ({
				item,
				labelMatches: [],
				pathMatches: [],
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

				// searchText = label + ' ' + path, so path starts at label.length + 1.
				const labelLen = item.label.length;
				const labelMatches = match.indices.filter((i) => i < labelLen);
				const pathMatches = match.indices
					.filter((i) => i > labelLen)
					.map((i) => i - labelLen - 1);

				return { item, labelMatches, pathMatches, score: match.score };
			})
			.filter((entry): entry is RecentProjectMatch => entry !== undefined)
			.sort((a, b) => b.score - a.score);
	}

	/** Dispatches webview messages. */
	private async handleMessage(message: RecentProjectMessage): Promise<void> {
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

	/** Builds the full state and pushes it to the webview. Guards against rendering before 'ready'. */
	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const activeIndex = this.filteredItems.length === 0
			? 0
			: Math.min(this.activeIndex, this.filteredItems.length - 1);
		this.activeIndex = activeIndex;

		const items: RecentProjectRenderItem[] = this.filteredItems.map((entry, index) => ({
			index,
			lastModified: entry.item.lastModifiedMs !== undefined
				? formatRelativeTime(entry.item.lastModifiedMs, Date.now())
				: '',
			matches: entry.pathMatches,
			path: entry.item.path,
			type: 'result',
		}));

		const state: RecentProjectState = {
			activeIndex,
			emptyText: this.loading ? 'Loading recent projects...' : 'No recent projects found.',
			items,
			placeholder: 'Filter projects...',
			promptLabel: `[${vscode.workspace.name ?? 'no project'}] Switch to project:`,
			query: this.query,
			statusLabel: this.getStatusLabel(),
			statusWidthCh: this.getStatusWidthCh(),
			title: 'Open Recent Project',
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

	/** Collapses the bottom panel. */
	private async close(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
	}

	/** Generates the webview HTML using the shared file-picker template. */
	private getHtml(webview: vscode.Webview): string {
		return createFilePickerHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			title: 'Open Recent Project',
		});
	}
}

