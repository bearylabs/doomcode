import * as vscode from 'vscode';
import { createFilePickerHtml, createNonce, formatRelativeTime, fuzzyMatch } from '../panel/helpers';

// ---------------------------------------------------------------------------
// Cross-project file models
// ---------------------------------------------------------------------------

interface CrossProjectFileItem {
	absoluteUri: vscode.Uri;
	lastModifiedMs: number | undefined;
	relativePath: string;
	searchText: string;
}

interface CrossProjectFileMatch {
	item: CrossProjectFileItem;
	matches: number[];
	score: number;
}

interface CrossProjectFileRenderItem {
	index: number;
	lastModified: string;
	matches: number[];
	path: string;
	type: 'result';
}

interface CrossProjectFileState {
	activeIndex: number;
	emptyText: string;
	items: CrossProjectFileRenderItem[];
	placeholder: string;
	promptLabel: string;
	query: string;
	statusLabel: string;
	statusWidthCh: number;
	title: string;
}

interface CrossProjectFileMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready';
}

// ---------------------------------------------------------------------------
// Folder walker
// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set([
	'.git', '.hg', 'node_modules', 'out', 'dist', 'coverage', 'build', '.next', '__pycache__', '.tox',
]);

/** Recursively lists all files under `rootUri`, excluding common generated/VCS directories. */
async function walkProjectFiles(
	rootUri: vscode.Uri,
): Promise<Array<{ relativePath: string; absoluteUri: vscode.Uri }>> {
	const files: Array<{ relativePath: string; absoluteUri: vscode.Uri }> = [];

	async function recurse(dirUri: vscode.Uri, prefix: string): Promise<void> {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dirUri);
		} catch {
			return;
		}

		const subdirPromises: Promise<void>[] = [];
		for (const [name, type] of entries) {
			const isDir = (type & vscode.FileType.Directory) !== 0;
			const isFile = (type & vscode.FileType.File) !== 0;

			if (isDir) {
				if (!EXCLUDE_DIRS.has(name)) {
					const childUri = vscode.Uri.joinPath(dirUri, name);
					const childPrefix = prefix ? `${prefix}/${name}` : name;
					subdirPromises.push(recurse(childUri, childPrefix));
				}
			} else if (isFile) {
				const relativePath = prefix ? `${prefix}/${name}` : name;
				const absoluteUri = vscode.Uri.joinPath(rootUri, relativePath);
				files.push({ relativePath, absoluteUri });
			}
		}

		await Promise.all(subdirPromises);
	}

	await recurse(rootUri, '');
	return files;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * File picker that browses an arbitrary folder URI without requiring it to be
 * an open workspace. Used for the "spc spc with no workspace" flow:
 *   1. Pick a recent project (DoomRecentProjectsPanel with callback)
 *   2. This panel walks the chosen project folder and lets the user pick a file
 *   3. On selection, calls `onFileSelected(fileUri)` — the caller is responsible
 *      for persisting the pending file and opening the folder.
 */
export class DoomCrossProjectFilePanel {
	static readonly visibleContextKey = 'doom.crossProjectFileVisible';

	private activeIndex = 0;
	private allItems: CrossProjectFileItem[] = [];
	private filteredItems: CrossProjectFileMatch[] = [];
	private loading = false;
	private loadSequence = 0;
	private onFileSelected: ((fileUri: vscode.Uri) => Promise<void>) | undefined;
	private projectLabel = '';
	private projectUri: vscode.Uri | undefined;
	private query = '';
	private ready = false;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	/**
	 * Configures the panel for a specific project folder before it is revealed.
	 * `onFileSelected` is invoked with the absolute URI when the user confirms a result.
	 */
	prepareShow(
		projectUri: vscode.Uri,
		projectLabel: string,
		onFileSelected: (fileUri: vscode.Uri) => Promise<void>,
	): void {
		this.projectUri = projectUri;
		this.projectLabel = projectLabel;
		this.onFileSelected = onFileSelected;
		this.query = '';
		this.activeIndex = 0;
		this.allItems = [];
		this.filteredItems = [];
	}

	/** Walks the project folder and populates the file list. */
	async loadItems(): Promise<void> {
		if (!this.projectUri) {
			return;
		}

		const loadId = ++this.loadSequence;
		this.loading = true;
		this.render();

		const discovered = await walkProjectFiles(this.projectUri);
		if (loadId !== this.loadSequence) {
			return;
		}

		// Stat all files in parallel to get mtime.
		const stats = await Promise.allSettled(
			discovered.map(({ absoluteUri }) => vscode.workspace.fs.stat(absoluteUri))
		);
		if (loadId !== this.loadSequence) {
			return;
		}

		this.allItems = discovered
			.map(({ relativePath, absoluteUri }, i) => {
				const stat = stats[i];
				const lastModifiedMs = stat.status === 'fulfilled' ? stat.value.mtime : undefined;
				return {
					absoluteUri,
					lastModifiedMs,
					relativePath,
					searchText: relativePath.toLowerCase(),
				};
			})
			.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

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

	/** Invokes `onFileSelected` with the chosen file URI, then closes the panel. */
	async activateSelection(): Promise<void> {
		if (!this.view?.visible || this.filteredItems.length === 0 || !this.onFileSelected) {
			return;
		}

		const item = this.filteredItems[this.activeIndex];
		if (!item) {
			return;
		}

		const callback = this.onFileSelected;
		await this.close();
		await callback(item.item.absoluteUri);
	}

	/**
	 * Bootstraps the WebviewView.
	 * Re-entrant — cleans up previous listeners first.
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposables.forEach((d) => d.dispose());
		this.viewDisposables = [];
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.title = 'Find File';
		webviewView.description = this.projectLabel;

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
			webviewView.webview.onDidReceiveMessage((message: CrossProjectFileMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	/** Syncs the context key so keybindings scope correctly. */
	private async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', DoomCrossProjectFilePanel.visibleContextKey, isVisible);
	}

	private filterItems(): void {
		this.activeIndex = 0;
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
			.filter((entry): entry is CrossProjectFileMatch => entry !== undefined)
			.sort((a, b) => b.score - a.score)
			.slice(0, 200);
	}

	private async handleMessage(message: CrossProjectFileMessage): Promise<void> {
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

	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const activeIndex = this.filteredItems.length === 0
			? 0
			: Math.min(this.activeIndex, this.filteredItems.length - 1);
		this.activeIndex = activeIndex;

		const now = Date.now();
		const items: CrossProjectFileRenderItem[] = this.filteredItems.map((entry, index) => ({
			index,
			lastModified: entry.item.lastModifiedMs !== undefined
				? formatRelativeTime(entry.item.lastModifiedMs, now)
				: '',
			matches: entry.matches,
			path: entry.item.relativePath,
			type: 'result',
		}));

		const state: CrossProjectFileState = {
			activeIndex,
			emptyText: this.loading ? `Loading files in ${this.projectLabel}...` : 'No matches.',
			items,
			placeholder: 'Filter files...',
			promptLabel: `[${this.projectLabel}] Find file:`,
			query: this.query,
			statusLabel: this.getStatusLabel(),
			statusWidthCh: this.getStatusWidthCh(),
			title: `Find File — ${this.projectLabel}`,
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

	private async close(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
	}

	private getHtml(webview: vscode.Webview): string {
		return createFilePickerHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			title: 'Find File',
		});
	}
}
