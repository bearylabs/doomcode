export interface FuzzyMatch {
	indices: number[];
	score: number;
}

/** Generates a random 10-char alphanumeric nonce for CSP script-src directives. */
export function createNonce(): string {
	return Math.random().toString(36).slice(2, 12);
}

/**
 * Greedy subsequence fuzzy match. Returns undefined if not all query chars are found in order.
 *
 * Scoring: +8 per matched char, +4 per consecutive streak char (rewards contiguous runs).
 * Penalises by subtracting the index of the first match (rewards prefix matches).
 * Indices point into `text` and are used by the highlight renderer.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | undefined {
	if (query.length === 0) {
		return {
			indices: [],
			score: 0,
		};
	}

	let score = 0;
	let queryIndex = 0;
	let streak = 0;
	let firstMatch = -1;
	const indices: number[] = [];

	for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex++) {
		if (text[textIndex] !== query[queryIndex]) {
			streak = 0;
			continue;
		}

		if (firstMatch === -1) {
			firstMatch = textIndex;
		}

		queryIndex++;
		streak++;
		indices.push(textIndex);
		score += 8 + streak * 4;
	}

	if (queryIndex !== query.length) {
		return undefined;
	}

	return {
		indices,
		score: score - Math.max(firstMatch, 0),
	};
}

/**
 * Orderless AND fuzzy match — mirrors Doom Emacs `orderless` style.
 * Splits query on whitespace; ALL tokens must match independently as subsequences.
 * Token order in the query does not matter. Score = sum of per-token scores.
 * Indices = sorted union of per-token indices for highlight rendering.
 */
export function orderlessMatch(text: string, query: string): FuzzyMatch | undefined {
	const tokens = query.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return { indices: [], score: 0 };
	}
	if (tokens.length === 1) {
		return fuzzyMatch(text, tokens[0]);
	}

	let totalScore = 0;
	const allIndices: number[] = [];

	for (const token of tokens) {
		const match = fuzzyMatch(text, token);
		if (!match) {
			return undefined;
		}
		totalScore += match.score;
		for (const idx of match.indices) {
			allIndices.push(idx);
		}
	}

	allIndices.sort((a, b) => a - b);
	const indices = allIndices.filter((v, i) => i === 0 || allIndices[i - 1] !== v);
	return { indices, score: totalScore };
}

/**
 * Formats a Unix timestamp (ms) as a human-readable relative time.
 *
 * - < 1 min  : "just now"
 * - < 1 hour : "Xm ago"
 * - < 24 h   : "Xh ago"
 * - < 7 days : "Xd ago"
 * - older    : "Mon N" (e.g. "Apr 3")
 */
export function formatRelativeTime(ms: number, now: number): string {
	const diffMs = now - ms;
	const diffMin = Math.floor(diffMs / 60_000);
	if (diffMin < 1) { return 'just now'; }
	if (diffMin < 60) { return `${diffMin}m ago`; }
	const diffH = Math.floor(diffMin / 60);
	if (diffH < 24) { return `${diffH}h ago`; }
	const diffD = Math.floor(diffH / 24);
	if (diffD < 7) { return `${diffD}d ago`; }
	const d = new Date(ms);
	const mon = d.toLocaleString('en', { month: 'short' });
	return `${mon} ${d.getDate()}`;
}

/**
 * Generates the full webview HTML for a two-column file-picker panel
 * (project files / recent projects).
 *
 * Items posted to the webview via `render` state must have the shape:
 *   { index, path, matches, lastModified }
 */
export function createFilePickerHtml(options: {
	cspSource: string;
	nonce: string;
	title: string;
}): string {
	const { cspSource, nonce, title } = options;
	const csp = [
		"default-src 'none'",
		`style-src ${cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title}</title>
	<style>
		html {
			height: 100%;
		}

		:root {
			color-scheme: dark;
			--bg: var(--vscode-editorWidget-background, var(--vscode-editor-background));
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
			display: grid;
			grid-template-columns: minmax(0, 55ch) 8ch;
			align-items: center;
			gap: 2ch;
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
		}

		.item-path {
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.item-time {
			color: var(--accent);
			font-variant-numeric: tabular-nums;
			white-space: nowrap;
			text-align: right;
		}

		.item.active {
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
			<input class="input" id="query" type="text" spellcheck="false" placeholder="..." />
		</div>
		<div class="results" id="results"></div>
		<div class="empty" id="empty" hidden></div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const empty = document.getElementById('empty');
		const prompt = document.getElementById('prompt');
		const query = document.getElementById('query');
		const results = document.getElementById('results');
		const status = document.getElementById('status');
		let items = [];
		let maxStatusWidth = 0;

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

			if (state.forceQuery || document.activeElement !== query) {
				query.value = state.query;
			}

			results.innerHTML = '';
			empty.hidden = items.length > 0;
			maxStatusWidth = Math.max(maxStatusWidth, state.statusWidthCh);
			status.style.width = maxStatusWidth + 'ch';
			status.textContent = state.statusLabel;

			items.forEach((item) => {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = item.index === state.activeIndex ? 'item active' : 'item';
				button.dataset.index = String(item.index);

				const pathEl = document.createElement('span');
				pathEl.className = 'item-path';
				appendHighlightedText(pathEl, item.path, item.matches);

				const timeEl = document.createElement('span');
				timeEl.className = 'item-time';
				timeEl.textContent = item.lastModified;

				button.append(pathEl, timeEl);
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
			if (event.metaKey || event.altKey || event.ctrlKey) {
				return;
			}

			if (event.key === 'Backspace') {
				const val = query.value;
				const selStart = query.selectionStart ?? val.length;
				const selEnd = query.selectionEnd ?? val.length;
				// When cursor is at end with no selection and preceding char is /, remove
				// the whole path component back to the previous / (rapid dir traversal).
				if (selStart === selEnd && selStart === val.length && val.length > 1 && val[val.length - 1] === '/') {
					event.preventDefault();
					const withoutSlash = val.slice(0, -1);
					const prevSlash = withoutSlash.lastIndexOf('/');
					const newVal = prevSlash >= 0 ? withoutSlash.slice(0, prevSlash + 1) : '';
					query.value = newVal;
					vscode.postMessage({ type: 'query', query: newVal });
					return;
				}
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				vscode.postMessage({ type: 'close' });
				return;
			}

			if (event.key === 'ArrowDown') {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'move', index: Math.min(activeIndex + 1, items.length - 1) });
				return;
			}

			if (event.key === 'ArrowUp') {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'move', index: Math.max(activeIndex - 1, 0) });
				return;
			}

			if (event.key === 'Tab') {
				if (items.length === 0) {
					return;
				}

				event.preventDefault();
				const activeIndex = Number(results.querySelector('.item.active')?.dataset.index ?? '0');
				vscode.postMessage({ type: 'tab', index: activeIndex });
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