import * as vscode from 'vscode';

/**
 * Single, extension-scoped source of workspace-file discovery and change
 * notification.
 *
 * Owns the one and only `vscode.workspace.createFileSystemWatcher('**\/*')` for
 * the extension. The find-file and search panels each used to lazily create —
 * and never dispose — their own full-tree watcher to invalidate their cached
 * file lists; that leaked two workspace-wide watchers for the whole session.
 * They now share this service: it watches the tree once and fires
 * {@link onCacheInvalidated} on any create/delete/change so each panel can clear
 * its own derived cache.
 *
 * Created and pushed to `context.subscriptions` in `activate()`, so the watcher
 * and event emitter are disposed when the extension deactivates.
 */
export class WorkspaceFileIndex implements vscode.Disposable {
	private readonly watcher: vscode.FileSystemWatcher;
	private readonly cacheInvalidated = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[] = [];
	private fileCache: vscode.Uri[] | undefined;

	/** Fires whenever a workspace file is created, deleted, or changed. */
	readonly onCacheInvalidated = this.cacheInvalidated.event;

	constructor() {
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
		const invalidate = (): void => {
			this.fileCache = undefined;
			this.cacheInvalidated.fire();
		};
		this.disposables.push(
			this.watcher,
			this.cacheInvalidated,
			this.watcher.onDidCreate(invalidate),
			this.watcher.onDidDelete(invalidate),
			this.watcher.onDidChange(invalidate),
		);
	}

	/** Returns all workspace files, cached until the next filesystem change. */
	async getFiles(): Promise<vscode.Uri[]> {
		if (!this.fileCache) {
			this.fileCache = await vscode.workspace.findFiles('**/*');
		}

		return this.fileCache;
	}

	dispose(): void {
		this.disposables.forEach((disposable) => disposable.dispose());
		this.disposables.length = 0;
	}
}
