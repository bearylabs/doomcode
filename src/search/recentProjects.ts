import * as fs from 'fs';
import * as vscode from 'vscode';
import { DoomWebviewController } from '../panel/controller';
import { createFilePickerHtml, createNonce, formatFileSize, formatPermissions, formatRelativeTime, orderlessMatch, tildeCollapse } from '../panel/helpers';

// ---------------------------------------------------------------------------
// Recent project models
// ---------------------------------------------------------------------------

export interface RecentProjectItem {
	label: string;
	/** Unix timestamp (ms) of the workspace folder/file mtime, or undefined if stat failed. */
	lastModifiedMs: number | undefined;
	path: string;
	permissions: string;
	/** Concatenation `label + ' ' + path` (lower-cased) used as the fuzzy search target. */
	searchText: string;
	size: string;
	uri: vscode.Uri;
	/** Remote host label (e.g. `Ubuntu`, `my-server`) if the project lives on a remote, otherwise undefined. */
	host: string | undefined;
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
	host: string | undefined;
	index: number;
	lastModified: string;
	matches: number[];
	path: string;
	permissions: string;
	size: string;
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
 * Extracts a short remote host label from a URI, or returns `undefined` for local (`file://`) URIs.
 * - `vscode-vfs://wsl+Ubuntu/…`        → `Ubuntu`
 * - `vscode-remote://wsl+Ubuntu/…`     → `Ubuntu`
 * - `vscode-remote://ssh-remote+host/…` → `host`
 * - any other non-`file` scheme         → the raw authority string
 */
function extractHostLabel(uri: vscode.Uri): string | undefined {
	if (uri.scheme === 'file') {
		return undefined;
	}

	const authority = uri.authority;
	if (authority.startsWith('wsl+')) {
		return authority.slice(4);
	}

	if (authority.startsWith('ssh-remote+')) {
		return authority.slice(11);
	}

	return authority || uri.scheme;
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
	} catch (err) {
		console.warn('[DoomRecentProjects] getRecentlyOpened failed:', err);
		return [];
	}

	if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { workspaces?: unknown }).workspaces)) {
		return [];
	}

	const entries = (raw as { workspaces: RawRecentEntry[] }).workspaces;

	// Build items first, then stat all paths in parallel.
	const uriList: Array<{ uri: vscode.Uri; label: string; path: string; host: string | undefined }> = [];

	for (const entry of entries) {
		const uri = extractEntryUri(entry);
		if (!uri) {
			continue;
		}

		const host = extractHostLabel(uri);
		const path = host ? uri.path : tildeCollapse(uri.fsPath.replace(/\\/g, '/'));
		const basename = path.split('/').filter(Boolean).pop() ?? path;
		const label = entry.label ?? basename;
		uriList.push({ uri, label, path, host });
	}

	const stats = await Promise.allSettled(
		uriList.map(({ uri }) => fs.promises.stat(uri.fsPath))
	);

	return uriList.map(({ uri, label, path, host }, i) => {
		const stat = stats[i];
		const lastModifiedMs = stat.status === 'fulfilled' ? stat.value.mtimeMs : undefined;
		const permissions = stat.status === 'fulfilled' ? formatPermissions(stat.value.mode) : '----------';
		const size = stat.status === 'fulfilled' ? formatFileSize(stat.value.size) : '0';
		return {
			host,
			label,
			lastModifiedMs,
			path,
			permissions,
			searchText: `${label} ${path}${host ? ' ' + host : ''}`.toLowerCase(),
			size,
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
export class DoomRecentProjectsPanel extends DoomWebviewController {
	static readonly visibleContextKey = 'doom.recentProjectsVisible';

	protected readonly visibleContextKey = DoomRecentProjectsPanel.visibleContextKey;

	private allItems: RecentProjectItem[] = [];
	private filteredItems: RecentProjectMatch[] = [];
	private loading = false;
	/**
	 * When set, selection calls this instead of opening the folder directly.
	 * Used by the "spc spc with no workspace" flow to chain into a file picker.
	 */
	private onProjectSelected: ((item: RecentProjectItem) => Promise<void>) | undefined;

	/**
	 * Resets state.
	 * Pass `onProjectSelected` to intercept selection instead of opening the folder.
	 */
	prepareShow(onProjectSelected?: (item: RecentProjectItem) => Promise<void>): void {
		this.onProjectSelected = onProjectSelected;
		this.query = '';
		this.activeIndex = 0;
		this.allItems = [];
		this.filteredItems = [];
	}

	/** Loads recent projects from VS Code's MRU list and renders them, excluding the current workspace. */
	async loadItems(): Promise<void> {
		this.loading = true;
		this.render();
		const currentPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const all = await getRecentProjects();
		this.allItems = currentPath
			? all.filter((item) => item.uri.fsPath !== currentPath)
			: all;
		this.loading = false;
		this.filterItems();
		this.render();
	}

	protected get itemCount(): number {
		return this.filteredItems.length;
	}

	/** Stamps the pane header. */
	protected updateViewMetadata(): void {
		if (!this.view) {
			return;
		}

		this.view.title = 'Open Recent';
		this.view.description = 'Select a workspace';
	}

	/** Opens the selected workspace, or calls `onProjectSelected` if set. */
	protected async activateSelection(): Promise<void> {
		if (!this.view?.visible || this.filteredItems.length === 0) {
			return;
		}

		const entry = this.filteredItems[this.activeIndex];
		if (!entry) {
			return;
		}

		await this.close();

		if (this.onProjectSelected) {
			await this.onProjectSelected(entry.item);
		} else {
			await vscode.commands.executeCommand('vscode.openFolder', entry.item.uri, { forceReuseWindow: true });
		}
	}

	/**
	 * Orderless-filters `allItems` (already in MRU order).
	 * Runs against `searchText` (label + path); splits match indices into separate
	 * label and path arrays so both portions can be highlighted independently.
	 */
	protected filterItems(): void {
		this.activeIndex = 0;
		const query = this.query.trim().toLowerCase();

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
				const match = orderlessMatch(item.searchText, query);
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

	/** Builds the full render state. Clamps `activeIndex` into range first. */
	protected buildRenderState(): RecentProjectState {
		const activeIndex = this.filteredItems.length === 0
			? 0
			: Math.min(this.activeIndex, this.filteredItems.length - 1);
		this.activeIndex = activeIndex;

		const items: RecentProjectRenderItem[] = this.filteredItems.map((entry, index) => ({
			host: entry.item.host,
			index,
			lastModified: entry.item.lastModifiedMs !== undefined
				? formatRelativeTime(entry.item.lastModifiedMs, Date.now())
				: '',
			matches: entry.pathMatches,
			path: entry.item.path,
			permissions: entry.item.permissions,
			size: entry.item.size,
			type: 'result',
		}));

		return {
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

	/** Generates the webview HTML using the shared file-picker template. */
	protected getHtml(webview: vscode.Webview): string {
		return createFilePickerHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			title: 'Open Recent Project',
		});
	}
}

