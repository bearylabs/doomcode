import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createFilePickerHtml, createNonce, formatFileSize, formatPermissions, formatRelativeTime, normalizePath, tildeCollapse, tildeExpand } from '../panel/helpers';
import { SelectionHistory } from './selectionHistory';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface FindFileItem {
	isDir: boolean;
	lastModifiedMs: number | undefined;
	name: string;      // display: dirs have trailing /
	fsPath: string;    // absolute path (no trailing slash)
	permissions: string;
	searchText: string;
	size: string;
}

interface FindFileRenderItem {
	index: number;
	lastModified: string;
	matches: number[];
	path: string;
	permissions: string;
	size: string;
	type: 'result';
}

interface FindFileState {
	activeIndex: number;
	emptyText: string;
	forceQuery: boolean;
	items: FindFileRenderItem[];
	placeholder: string;
	promptLabel: string;
	query: string;
	statusLabel: string;
	statusWidthCh: number;
	title: string;
}

interface FindFileMessage {
	index?: number;
	query?: string;
	type: 'activate' | 'close' | 'move' | 'query' | 'ready' | 'tab';
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Directory browser — mirrors Doom Emacs `SPC .` / `find-file`.
 *
 * The query input IS the path being typed (e.g. `/home/user/dev/proj/src/ext`).
 * On every keystroke the text is split at the last `/`:
 *   dir    = everything up to and including the last `/`
 *   filter = everything after the last `/`
 * When `dir` changes the directory listing reloads. When `filter` changes the
 * existing listing is re-filtered by substring. Activating a directory item
 * appends its name to the query, advancing into the directory. Backspacing
 * past a `/` retreats into the parent.
 */
export class DoomFindFilePanel {
	static readonly visibleContextKey = 'doom.findFileVisible';

	constructor(private readonly history: SelectionHistory) {}

	private activeIndex = 0;
	private allItems: FindFileItem[] = [];
	private baseAuthority = '';
	private baseScheme = 'file';
	private currentDir = '';
	private filter = '';
	private filteredItems: FindFileItem[] = [];
	private forceQueryUpdate = false;
	private loading = false;
	private query = '';
	private ready = false;
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	/**
	 * Sets the starting directory. `startDir` should be an absolute path
	 * with a trailing slash (e.g. `/home/user/dev/`).
	 */
	prepareShow(startUri: vscode.Uri): void {
		this.baseScheme = startUri.scheme;
		this.baseAuthority = startUri.authority;
		const raw = startUri.path;
		const normalised = raw.endsWith('/') ? raw : raw + '/';
		this.query = normalised;
		this.currentDir = normalised.slice(0, -1); // strip trailing slash
		this.filter = '';
		this.activeIndex = 0;
		this.allItems = [];
		this.filteredItems = [];
		this.forceQueryUpdate = false;
	}

	/** Reads the starting directory and renders the initial listing. */
	async loadItems(): Promise<void> {
		this.loading = true;
		this.render();
		await this.readCurrentDir();
		this.loading = false;
		this.filterItems();
		this.render();
	}

	attachToView(webviewView: vscode.WebviewView): void {
		this.resolveWebviewView(webviewView);
	}

	detachFromView(): void {
		this.viewDisposables.forEach((d) => d.dispose());
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

		if (item.isDir) {
			// Append dir name to query — drives the path-as-query mechanism.
			this.query = item.fsPath + '/';
			this.forceQueryUpdate = true;
			await this.applyQueryChange();
			return;
		}

		const uri = this.makeUri(item.fsPath);
		this.history.record(item.fsPath);
		const activeGroup = vscode.window.tabGroups.activeTabGroup;
		await this.close();
		const document = await vscode.workspace.openTextDocument(uri);

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.fsPath !== uri.fsPath) {
					continue;
				}
				if (group !== activeGroup && tab === group.activeTab) {
					await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false, viewColumn: activeGroup.viewColumn });
					return;
				}
				await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false, viewColumn: group.viewColumn });
				return;
			}
		}

		await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposables.forEach((d) => d.dispose());
		this.viewDisposables = [];
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);
		webviewView.title = 'Find File';
		webviewView.description = undefined;

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
			webviewView.webview.onDidReceiveMessage((message: FindFileMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	/**
	 * Parses `this.query` into dir + filter. Reloads directory if dir changed;
	 * otherwise just re-filters and re-renders.
	 */
	private async applyQueryChange(): Promise<void> {
		const lastSlash = this.query.lastIndexOf('/');
		const newDir = lastSlash >= 0 ? (this.query.slice(0, lastSlash) || '/') : '';
		const newFilter = lastSlash >= 0 ? this.query.slice(lastSlash + 1) : this.query;

		const dirChanged = newDir !== this.currentDir && newDir.startsWith('/');

		this.filter = newFilter;

		if (dirChanged) {
			this.currentDir = newDir;
			this.loading = true;
			this.render();
			await this.readCurrentDir();
			this.loading = false;
		}

		this.filterItems();
		this.render();
	}

	private makeUri(absPath: string): vscode.Uri {
		return vscode.Uri.from({ scheme: this.baseScheme, authority: this.baseAuthority, path: absPath });
	}

	private async readCurrentDir(): Promise<void> {
		const dirUri = this.makeUri(this.currentDir);
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(dirUri);
		} catch {
			this.allItems = [];
			return;
		}

		const dirs: FindFileItem[] = [];
		const files: FindFileItem[] = [];

		const joinPath = (name: string) =>
			this.currentDir === '/' ? `/${name}` : `${this.currentDir}/${name}`;

		const isSsh = this.baseScheme === 'vscode-remote' && this.baseAuthority.startsWith('ssh-remote+');
		const stats = isSsh
			? undefined
			: await Promise.allSettled(
				entries.map(([name]) => fs.promises.stat(this.makeUri(joinPath(name)).fsPath))
			);

		for (let i = 0; i < entries.length; i++) {
			const [name, type] = entries[i];
			const isDir = (type & vscode.FileType.Directory) !== 0;
			const stat = stats?.[i];
			const lastModifiedMs = stat?.status === 'fulfilled' ? stat.value.mtimeMs : undefined;
			const permissions = stat?.status === 'fulfilled' ? formatPermissions(stat.value.mode) : '----------';
			const size = stat?.status === 'fulfilled' ? formatFileSize(stat.value.size) : '0';
			const displayName = isDir ? name + '/' : name;
			const entry: FindFileItem = {
				isDir,
				lastModifiedMs,
				name: displayName,
				fsPath: joinPath(name),
				permissions,
				searchText: displayName.toLowerCase(),
				size,
			};
			if (isDir) {
				dirs.push(entry);
			} else {
				files.push(entry);
			}
		}

		dirs.sort((a, b) => a.name.localeCompare(b.name));
		files.sort((a, b) => {
			const aHistory = this.history.getScore(a.fsPath);
			const bHistory = this.history.getScore(b.fsPath);
			if (bHistory !== aHistory) { return bHistory - aHistory; }
			return (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0);
		});

		this.allItems = [...dirs, ...files];
	}

	private filterItems(): void {
		this.activeIndex = 0;
		const q = this.filter.toLowerCase();

		if (q.length === 0) {
			this.filteredItems = this.allItems;
			return;
		}

		this.filteredItems = this.allItems.filter((item) => item.searchText.includes(q));
	}

	private async handleMessage(message: FindFileMessage): Promise<void> {
		switch (message.type) {
		case 'ready':
			this.ready = true;
			this.render();
			return;
		case 'query': {
			const expanded = tildeExpand(message.query ?? '');
			if (!expanded && this.query === normalizePath(os.homedir()) + '/') {
				this.query = normalizePath(path.dirname(normalizePath(os.homedir()))) + '/';
				this.forceQueryUpdate = true;
			} else {
				this.query = expanded;
			}
			await this.applyQueryChange();
			return;
		}
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
		case 'tab': {
			if (this.filteredItems.length === 0 || message.index === undefined) {
				return;
			}
			const tabItem = this.filteredItems[message.index];
			if (!tabItem) {
				return;
			}
			this.query = tabItem.isDir ? tabItem.fsPath + '/' : tabItem.fsPath;
			this.forceQueryUpdate = true;
			await this.applyQueryChange();
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
		const items: FindFileRenderItem[] = this.filteredItems.map((entry, index) => ({
			index,
			lastModified: entry.lastModifiedMs !== undefined
				? formatRelativeTime(entry.lastModifiedMs, now)
				: '',
			matches: [],
			path: entry.name,
			permissions: entry.permissions,
			size: entry.size,
			type: 'result',
		}));

		const forceQuery = this.forceQueryUpdate;
		this.forceQueryUpdate = false;

		const state: FindFileState = {
			activeIndex,
			emptyText: this.loading ? 'Reading directory...' : 'No matches.',
			forceQuery,
			items,
			placeholder: '',
			promptLabel: 'Find file:',
			query: tildeCollapse(this.query),
			statusLabel: this.getStatusLabel(),
			statusWidthCh: this.getStatusWidthCh(),
			title: 'Find File',
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

	private async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', DoomFindFilePanel.visibleContextKey, isVisible);
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
