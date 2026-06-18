import * as vscode from 'vscode';

/**
 * Messages every Doom bottom-panel picker webview posts back to its controller.
 * Panels may post additional `type` values (e.g. `findFile`'s `tab`); those are
 * routed to {@link DoomWebviewController.onMessage}.
 */
export interface PanelWebviewMessage {
	index?: number;
	query?: string;
	type: string;
}

/**
 * Shared lifecycle + message-dispatch base for Doom's bottom-panel pickers
 * (find-file, project files, recent projects, open editors, search, which-key bindings).
 *
 * Owns the parts every panel re-implemented identically:
 *   - the `view` / `ready` / `viewDisposables` / `activeIndex` / `query` state,
 *   - `attachToView` / `detachFromView`,
 *   - the `resolveWebviewView` bootstrap (dispose old listeners → enable scripts → set HTML
 *     → stamp metadata → wire dispose/visibility/message listeners),
 *   - the render guard (`!view || !ready || !visible`),
 *   - the `handleMessage` dispatch skeleton (`ready | query | move | activate | close`),
 *   - `updateVisibilityContext`, and `close()`.
 *
 * Subclasses provide the five panel-specific members ({@link getHtml}, {@link filterItems},
 * {@link activateSelection}, {@link buildRenderState}, {@link itemCount}) and may override the
 * optional hooks where their behavior genuinely differs.
 */
export abstract class DoomWebviewController {
	protected activeIndex = 0;
	protected query = '';
	protected ready = false;
	protected view: vscode.WebviewView | undefined;
	protected viewDisposables: vscode.Disposable[] = [];

	/** Context key flipped true while this panel is the visible bottom-panel mode. */
	protected abstract readonly visibleContextKey: string;

	// -----------------------------------------------------------------------
	// Public contract consumed by DoomSharedPanel / keybinding commands
	// -----------------------------------------------------------------------

	/** Wires the panel to an already-created WebviewView (e.g. on panel restore). */
	attachToView(webviewView: vscode.WebviewView): void {
		this.resolveWebviewView(webviewView);
	}

	/** Tears down listeners and clears the view ref without destroying the panel instance. */
	detachFromView(): void {
		this.onDetach();
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = undefined;
		this.ready = false;
	}

	/**
	 * Bootstraps a WebviewView: disposes any previous listeners, enables scripts, injects HTML,
	 * stamps metadata, then wires dispose/visibility/message (plus any panel-specific) listeners.
	 * Re-entrant — safe to call on view recycle.
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.updateViewMetadata();

		this.viewDisposables.push(
			webviewView.onDidDispose(() => {
				if (this.view !== webviewView) {
					return;
				}

				this.onDispose();
				this.view = undefined;
				this.ready = false;
				void this.updateVisibilityContext(false);
			}),
			webviewView.onDidChangeVisibility(() => {
				void this.updateVisibilityContext(webviewView.visible);
				this.onVisibilityChanged(webviewView.visible);
			}),
			webviewView.webview.onDidReceiveMessage((message: PanelWebviewMessage) => {
				void this.handleMessage(message);
			}),
			...this.extraViewDisposables(webviewView),
		);
	}

	// -----------------------------------------------------------------------
	// Message dispatch skeleton
	// -----------------------------------------------------------------------

	/** Standard panel message dispatch. Subclasses customize via the hooks rather than overriding this. */
	protected async handleMessage(message: PanelWebviewMessage): Promise<void> {
		switch (message.type) {
		case 'ready':
			this.ready = true;
			this.onReady();
			this.render();
			await this.afterRender(true);
			return;
		case 'query':
			await this.onQuery(message.query ?? '');
			return;
		case 'move':
			await this.onMove(message.index);
			return;
		case 'activate':
			if (message.index !== undefined) {
				this.activeIndex = this.clampIndex(message.index);
			}

			await this.activateSelection();
			return;
		case 'close':
			await this.close();
			return;
		default:
			await this.onMessage(message);
			return;
		}
	}

	/** Default query handling: store, re-filter, re-render. Overridden by `findFile` for path traversal. */
	protected async onQuery(query: string): Promise<void> {
		this.query = query;
		this.filterItems();
		this.render();
		await this.afterRender(false);
	}

	/** Default move handling: clamp into range, re-render. */
	protected async onMove(index: number | undefined): Promise<void> {
		if (this.itemCount === 0 || index === undefined) {
			return;
		}

		this.activeIndex = this.clampIndex(index);
		this.render();
		await this.afterRender(false);
	}

	// -----------------------------------------------------------------------
	// Render + context + close (shared)
	// -----------------------------------------------------------------------

	/** Pushes the current render payload to the webview. Guards against rendering before 'ready'/visible. */
	protected render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		void this.view.webview.postMessage({ type: 'render', state: this.buildRenderState() });
	}

	/** Syncs this panel's visibility context key so keybindings can scope to panel visibility. */
	protected async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', this.visibleContextKey, isVisible);
	}

	/** Collapses the bottom panel. */
	protected async close(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.closePanel');
	}

	/** Clamps an index into the current result range (never negative, never past the last row). */
	protected clampIndex(index: number): number {
		return Math.min(Math.max(index, 0), Math.max(this.itemCount - 1, 0));
	}

	// -----------------------------------------------------------------------
	// Members each panel must provide
	// -----------------------------------------------------------------------

	/** Number of currently selectable (filtered) rows — drives move/clamp/guards. */
	protected abstract get itemCount(): number;
	/** Returns the full webview HTML for this panel. */
	protected abstract getHtml(webview: vscode.Webview): string;
	/** Recomputes the filtered result list from the current `query`. */
	protected abstract filterItems(): void;
	/** Handles Enter / click on the active row. */
	protected abstract activateSelection(): Promise<void>;
	/** Builds the render-state payload posted to the webview. */
	protected abstract buildRenderState(): object;

	// -----------------------------------------------------------------------
	// Optional hooks (no-op defaults)
	// -----------------------------------------------------------------------

	/** Stamps title/description onto the pane header. Called from `resolveWebviewView`. */
	protected updateViewMetadata(): void {}
	/** Runs after `ready` is set, before the first render (e.g. seed items). */
	protected onReady(): void {}
	/** Runs after every render. `initial` is true only for the post-'ready' render. */
	protected async afterRender(_initial: boolean): Promise<void> {}
	/** Extra cleanup when the panel is detached (runs before disposables are released). */
	protected onDetach(): void {}
	/** Extra cleanup when the underlying view is disposed. */
	protected onDispose(): void {}
	/** Reacts to the panel becoming visible/hidden (after the context key is synced). */
	protected onVisibilityChanged(_visible: boolean): void {}
	/** Additional view-scoped listeners to register and auto-dispose with the view. */
	protected extraViewDisposables(_webviewView: vscode.WebviewView): vscode.Disposable[] {
		return [];
	}
	/** Handles message types outside the common set (e.g. `findFile`'s `tab`). */
	protected async onMessage(_message: PanelWebviewMessage): Promise<void> {}
}
