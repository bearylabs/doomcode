import * as vscode from 'vscode';
import { DoomWebviewController } from '../panel/controller';
import { createNonce, createPanelHtml, substringMatch } from '../panel/helpers';
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

// ---------------------------------------------------------------------------
// Which-key bindings panel
// ---------------------------------------------------------------------------

/** Three-column result-row layout: highlighted key path · binding name · command detail. */
const BINDINGS_LAYOUT_CSS = `		.item {
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
		}`;

/** Builds one bindings row: highlighted key path, binding name, command detail. */
const BINDINGS_RENDER_ITEM = `				const button = document.createElement('button');
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
				results.appendChild(button);`;

export class DoomWhichKeyBindingsPanel extends DoomWebviewController {
	static readonly visibleContextKey = 'doom.whichKeyBindingsVisible';

	protected readonly visibleContextKey = DoomWhichKeyBindingsPanel.visibleContextKey;

	private bindings: WhichKeyExecutableBinding[] = [];
	private matches: WhichKeyBindingMatch[] = [];

	/** Call before making the panel visible. Resets query so prior search doesn't bleed into next open. */
	prepareShow(resetQuery = true): void {
		if (resetQuery) {
			this.query = '';
		}

		this.refreshItems();
	}

	protected get itemCount(): number {
		return this.matches.length;
	}

	/** Stamps static title/description onto the sidebar pane header. */
	protected updateViewMetadata(): void {
		if (!this.view) {
			return;
		}

		this.view.title = 'Show bindings';
		this.view.description = 'Which-key command list';
	}

	/** Re-reads live config and re-renders each time the panel is revealed. */
	protected onVisibilityChanged(visible: boolean): void {
		if (!visible) {
			return;
		}

		this.refreshItems();
		this.render();
	}

	/** Re-reads live config and re-applies current filter — call when config may have changed. */
	private refreshItems(): void {
		this.bindings = getFlattenedWhichKeyBindings();
		this.filterItems();
	}

	/**
	 * Applies fuzzy search against `searchText` and sorts by score desc, then path/name asc.
	 * Empty query shows all bindings unranked. Clamps `activeIndex` so it never goes out of bounds.
	 * Match indices are computed against `path` only — highlight stays in the key column.
	 */
	protected filterItems(): void {
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

				const searchMatch = substringMatch(item.searchText, query);
				if (!searchMatch) {
					return undefined;
				}

				const pathMatch = substringMatch(item.path.toLowerCase(), query);
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

	/** Executes the active match's binding then closes the panel. No-op if list is empty. */
	protected async activateSelection(): Promise<void> {
		const match = this.matches[this.activeIndex];
		if (!match) {
			return;
		}

		await executeWhichKeyBindingCommands(match.item.binding);
		await this.close();
	}

	/** Serializes current match/index state into the render payload. Clamps `activeIndex` into range. */
	protected buildRenderState(): WhichKeyBindingsState {
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

		return state;
	}

	protected getHtml(webview: vscode.Webview): string {
		return createPanelHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			title: 'Which-Key Bindings',
			layoutCss: BINDINGS_LAYOUT_CSS,
			renderItem: BINDINGS_RENDER_ITEM,
		});
	}
}