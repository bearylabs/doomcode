import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { createFilePickerHtml, createNonce, formatFileSize, formatPermissions, formatRelativeTime, orderlessMatch } from '../panel/helpers';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Project file models
// ---------------------------------------------------------------------------

interface ProjectFileItem {
	basename: string;
	lastModifiedMs: number | undefined;
	permissions: string;
	relativePath: string;
	searchText: string;
	size: string;
	uri: vscode.Uri;
}

interface ProjectFileMatch {
	item: ProjectFileItem;
	matches: number[];
	score: number;
}

interface ProjectFileRenderItem {
	index: number;
	lastModified: string;
	matches: number[];
	path: string;
	permissions: string;
	size: string;
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
// File listing
// ---------------------------------------------------------------------------

/**
 * Lists project files using `git ls-files` (respects .gitignore exactly).
 * Falls back to VS Code's findFiles if git is unavailable or the folder isn't a repo.
 * Uses null-terminated output (-z) to safely handle filenames with spaces.
 */
async function listProjectFiles(rootUri: vscode.Uri, loadId: number, loadSequence: number): Promise<vscode.Uri[]> {
	try {
		const { stdout } = await execFileAsync(
			'git',
			['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
			{ cwd: rootUri.fsPath, maxBuffer: 50 * 1024 * 1024 },
		);
		if (loadId !== loadSequence) {
			return [];
		}
		return stdout
			.split('\0')
			.filter(Boolean)
			.map((rel) => vscode.Uri.joinPath(rootUri, rel));
	} catch {
		if (loadId !== loadSequence) {
			return [];
		}
		const uris = await vscode.workspace.findFiles('**/*');
		return uris.filter((u) => u.scheme === 'file');
	}
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
		// Capture before close() shifts focus.
		const activeGroup = vscode.window.tabGroups.activeTabGroup;
		await this.close();
		const document = await vscode.workspace.openTextDocument(uri);

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.fsPath !== uri.fsPath) {
					continue;
				}
				// Visible (active) in a different group → open new copy in our group.
				if (group !== activeGroup && tab === group.activeTab) {
					await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false, viewColumn: activeGroup.viewColumn });
					return;
				}
				// Exists somewhere (inactive or same group) → switch to it.
				await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false, viewColumn: group.viewColumn });
				return;
			}
		}

		// Not open anywhere → open in active group.
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

		const rootUri = vscode.workspace.workspaceFolders![0].uri;
		const fileUris = await listProjectFiles(rootUri, loadId, this.loadSequence);

		if (loadId !== this.loadSequence) {
			return;
		}
		const stats = await Promise.allSettled(
			fileUris.map((uri) => fs.promises.stat(uri.fsPath))
		);

		if (loadId !== this.loadSequence) {
			return;
		}

		const items: ProjectFileItem[] = fileUris
			.map((uri, i) => {
				const relativePath = vscode.workspace.asRelativePath(uri, false);
				const slashIndex = relativePath.lastIndexOf('/');
				const basename = slashIndex >= 0 ? relativePath.slice(slashIndex + 1) : relativePath;
				const stat = stats[i];
				const lastModifiedMs = stat.status === 'fulfilled' ? stat.value.mtimeMs : undefined;
				const permissions = stat.status === 'fulfilled' ? formatPermissions(stat.value.mode) : '';
				const size = stat.status === 'fulfilled' ? formatFileSize(stat.value.size) : '';
				return {
					basename,
					lastModifiedMs,
					permissions,
					relativePath,
					searchText: relativePath.toLowerCase(),
					size,
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
					openItems.push({ basename, lastModifiedMs: undefined, permissions: '', relativePath, searchText: relativePath.toLowerCase(), size: '', uri });
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
		const query = this.query.trim().toLowerCase();

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
				const match = orderlessMatch(item.searchText, query);
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
			lastModified: entry.item.lastModifiedMs !== undefined
				? formatRelativeTime(entry.item.lastModifiedMs, Date.now())
				: '',
			matches: entry.matches,
			path: entry.item.relativePath,
			permissions: entry.item.permissions,
			size: entry.item.size,
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

	/** Generates the webview HTML using the shared file-picker template. */
	private getHtml(webview: vscode.Webview): string {
		return createFilePickerHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			title: 'Find File in Project',
		});
	}
}
