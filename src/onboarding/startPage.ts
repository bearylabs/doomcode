import { isDeepStrictEqual } from 'node:util';
import * as vscode from 'vscode';
import { createNonce } from '../panel/helpers';

export const START_PAGE_OPEN_ON_ACTIVATION_SETTING = 'doom.startPage.openOnActivation';

export type StartPageMode = 'startup' | 'update' | 'welcome';

export interface StartPageConflict {
	name: string;
	reason: string;
}

export interface DoomStartPageState {
	mode: StartPageMode;
	currentVersion: string;
	defaultCount: number;
	installedDefaultCount: number;
	hasInstalledDefaults: boolean;
	hasStaleSettings: boolean;
	hasStaleKeybindings: boolean;
	openOnActivation: boolean;
	startupCommands: StartPageCommand[];
	conflicts: StartPageConflict[];
	repositoryUrl?: string;
}

export interface StartPageCommand {
	label: string;
	keybinding: string;
	command: string;
}

const START_PAGE_COMMAND_ICONS: Record<string, string> = {
	'Recently opened files': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" aria-hidden="true"><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM248 320C234.7 320 224 330.7 224 344C224 357.3 234.7 368 248 368L392 368C405.3 368 416 357.3 416 344C416 330.7 405.3 320 392 320L248 320zM248 416C234.7 416 224 426.7 224 440C224 453.3 234.7 464 248 464L392 464C405.3 464 416 453.3 416 440C416 426.7 405.3 416 392 416L248 416z"/></svg>',
	'Reload last session': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" aria-hidden="true"><path fill="currentColor" d="M320 128C426 128 512 214 512 320C512 426 426 512 320 512C254.8 512 197.1 479.5 162.4 429.7C152.3 415.2 132.3 411.7 117.8 421.8C103.3 431.9 99.8 451.9 109.9 466.4C156.1 532.6 233 576 320 576C461.4 576 576 461.4 576 320C576 178.6 461.4 64 320 64C234.3 64 158.5 106.1 112 170.7L112 144C112 126.3 97.7 112 80 112C62.3 112 48 126.3 48 144L48 256C48 273.7 62.3 288 80 288L104.6 288C105.1 288 105.6 288 106.1 288L192.1 288C209.8 288 224.1 273.7 224.1 256C224.1 238.3 209.8 224 192.1 224L153.8 224C186.9 166.6 249 128 320 128zM344 216C344 202.7 333.3 192 320 192C306.7 192 296 202.7 296 216L296 320C296 326.4 298.5 332.5 303 337L375 409C384.4 418.4 399.6 418.4 408.9 409C418.2 399.6 418.3 384.4 408.9 375.1L343.9 310.1L343.9 216z"/></svg>',
	'Open project': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" aria-hidden="true"><path fill="currentColor" d="M264 112L376 112C380.4 112 384 115.6 384 120L384 160L256 160L256 120C256 115.6 259.6 112 264 112zM208 120L208 160L128 160C92.7 160 64 188.7 64 224L64 320L576 320L576 224C576 188.7 547.3 160 512 160L432 160L432 120C432 89.1 406.9 64 376 64L264 64C233.1 64 208 89.1 208 120zM576 368L384 368L384 384C384 401.7 369.7 416 352 416L288 416C270.3 416 256 401.7 256 384L256 368L64 368L64 480C64 515.3 92.7 544 128 544L512 544C547.3 544 576 515.3 576 480L576 368z"/></svg>',
};

const GITHUB_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.014 8.014 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

export interface InstallDefaultsState {
	matchingDefaults: number;
	totalDefaults: number;
	isInstalled: boolean;
}

interface WhichKeyBindingNode {
	key?: string;
	name?: string;
	type?: string;
	command?: string;
	bindings?: unknown;
}

const ASCII_HEADER = [
	"=================     ===============     ===============   ========  ========",
	"\\\\ . . . . . . .\\\\   //. . . . . . .\\\\   //. . . . . . .\\\\  \\\\. . .\\\\// . . //",
	"||. . ._____. . .|| ||. . ._____. . .|| ||. . ._____. . .|| || . . .\\/ . . .||",
	"|| . .||   ||. . || || . .||   ||. . || || . .||   ||. . || ||. . . . . . . ||",
	"||. . ||   || . .|| ||. . ||   || . .|| ||. . ||   || . .|| || . | . . . . .||",
	"|| . .||   ||. _-|| ||-_ .||   ||. . || || . .||   ||. _-|| ||-_.|\\ . . . . ||",
	"||. . ||   ||-'  || ||  `-||   || . .|| ||. . ||   ||-'  || ||  `|\\_ . .|. .||",
	"|| . _||   ||    || ||    ||   ||_ . || || . _||   ||    || ||   |\\ `-_/| . ||",
	"||_-' ||  .|/    || ||    \|.  || `-_|| ||_-' ||  .|/    || ||   | \\  / |-_.||",
	"||    ||_-'      || ||      `-_||    || ||    ||_-'      || ||   | \\  / |  `||",
	"||    `'         || ||         `'    || ||    `'         || ||   | \\  / |   ||",
	"||            .===' `===.         .==='.`===.         .===' /==. |  \\/  |   ||",
	"||         .=='   \\_|-_ `===. .==='   _|_   `===. .===' _-|/   `==  \\/  |   ||",
	"||      .=='    _-'    `-_  `='    _-'   `-_    `='  _-'   `-_  /|  \\/  |   ||",
	"||   .=='    _-'          '-__\\._-'         '-_./__-'         `' |. /|  |   ||",
	"||.=='    _-'                                                     `' |  /==.||",
	"=='    _-'                         C O D E                          \\/   `==",
	"\\   _-'                                                                `-_   /",
	" `''                                                                      ``'",
].join('\n');

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderInlineMarkdown(value: string): string {
	const escaped = escapeHtml(value);

	return escaped
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
}

export function extractCurrentReleaseNotes(changelogMarkdown: string, currentVersion: string): string {
	const normalized = changelogMarkdown.replace(/\r\n/g, '\n');
	const escapedVersion = currentVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const versionHeading = new RegExp(`^## \\[${escapedVersion}\\].*$`, 'm');
	const versionMatch = versionHeading.exec(normalized);

	if (!versionMatch || versionMatch.index === undefined) {
		return normalized.trim();
	}

	const sectionStart = versionMatch.index;
	const remaining = normalized.slice(sectionStart);
	const afterCurrentSectionHeading = remaining.slice(versionMatch[0].length);
	const nextSectionMatch = /^## \[.*$/m.exec(afterCurrentSectionHeading);

	if (!nextSectionMatch || nextSectionMatch.index === undefined) {
		return remaining.trim();
	}

	return remaining.slice(0, versionMatch[0].length + nextSectionMatch.index).trim();
}

export function renderMarkdownFragment(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const parts: string[] = [];
	let inList = false;
	let paragraphLines: string[] = [];

	const flushParagraph = () => {
		if (paragraphLines.length === 0) {
			return;
		}

		parts.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`);
		paragraphLines = [];
	};

	const closeList = () => {
		if (!inList) {
			return;
		}

		parts.push('</ul>');
		inList = false;
	};

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			flushParagraph();
			closeList();
			continue;
		}

		const h2 = /^##\s+(.*)$/.exec(trimmed);
		if (h2) {
			flushParagraph();
			closeList();
			parts.push(`<h2>${renderInlineMarkdown(h2[1])}</h2>`);
			continue;
		}

		const h3 = /^###\s+(.*)$/.exec(trimmed);
		if (h3) {
			flushParagraph();
			closeList();
			parts.push(`<h3>${renderInlineMarkdown(h3[1])}</h3>`);
			continue;
		}

		const bullet = /^-\s+(.*)$/.exec(trimmed);
		if (bullet) {
			flushParagraph();
			if (!inList) {
				parts.push('<ul>');
				inList = true;
			}
			parts.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
			continue;
		}

		paragraphLines.push(trimmed);
	}

	flushParagraph();
	closeList();

	return parts.join('\n');
}

type StartPageMessage = {
	command?: 'cleanup' | 'install' | 'openUrl' | 'setOpenOnActivation' | 'executeCommand';
	checked?: boolean;
	url?: string;
	vscodeCommand?: string;
};

function asBindingNodes(value: unknown): WhichKeyBindingNode[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((entry): entry is WhichKeyBindingNode => entry !== null && typeof entry === 'object');
}

function resolveBindingEntry(bindings: unknown, keyPath: readonly string[]): WhichKeyBindingNode | undefined {
	let currentBindings = asBindingNodes(bindings);
	let currentEntry: WhichKeyBindingNode | undefined;

	for (const key of keyPath) {
		currentEntry = currentBindings.find((entry) => entry.key === key);
		if (!currentEntry) {
			return undefined;
		}

		currentBindings = asBindingNodes(currentEntry.bindings);
	}

	if (typeof currentEntry?.command === 'string') {
		return currentEntry;
	}

	const defaultBinding = currentBindings.find((entry) => entry.key === '');
	return typeof defaultBinding?.command === 'string' ? defaultBinding : undefined;
}

export function resolveStartupCommandsFromBindings(
	bindings: unknown,
	startupCommandKeyPaths: readonly string[][],
): StartPageCommand[] {
	return startupCommandKeyPaths.flatMap((keyPath) => {
		const entry = resolveBindingEntry(bindings, keyPath);
		if (!entry || typeof entry.command !== 'string' || typeof entry.name !== 'string') {
			return [];
		}

		return [{
			label: entry.name,
			keybinding: `SPC ${keyPath.join(' ')}`,
			command: entry.command,
		}];
	});
}

export function evaluateInstalledDefaults(
	defaults: Record<string, unknown>,
	readSetting: (key: string) => unknown,
): InstallDefaultsState {
	const entries = Object.entries(defaults);
	const matchingDefaults = entries.reduce((count, [key, value]) => (
		isDeepStrictEqual(readSetting(key), value) ? count + 1 : count
	), 0);

	return {
		matchingDefaults,
		totalDefaults: entries.length,
		isInstalled: entries.length === 0 || matchingDefaults === entries.length,
	};
}

export function detectStartPageMode(previousVersion: string | undefined, currentVersion: string): StartPageMode {
	if (!previousVersion) {
		return 'welcome';
	}

	return previousVersion === currentVersion ? 'startup' : 'update';
}

export class DoomStartPage {
	private panel: vscode.WebviewPanel | undefined;

	constructor(private readonly extensionUri: vscode.Uri) {}

	show(state: DoomStartPageState): void {
		const panel = this.getOrCreatePanel();
		panel.title = this.getTitle(state);
		panel.webview.html = this.render(state, panel.webview);
		panel.reveal(vscode.ViewColumn.One, false);
	}

	private getOrCreatePanel(): vscode.WebviewPanel {
		if (this.panel) {
			return this.panel;
		}

		const panel = vscode.window.createWebviewPanel(
			'doom.startPage',
			'Doom Code',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'icon.png');
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
			}
		});
		panel.webview.onDidReceiveMessage((message: StartPageMessage) => {
			void this.handleMessage(message);
		});

		this.panel = panel;
		return panel;
	}

	private getTitle(state: DoomStartPageState): string {
		switch (state.mode) {
			case 'welcome':
				return 'Welcome to Doom Code';
			case 'update':
				return `Doom Code ${state.currentVersion}`;
			default:
				return 'Doom Code Start Page';
		}
	}

	private async handleMessage(message: StartPageMessage): Promise<void> {
		switch (message.command) {
			case 'executeCommand':
				if (!message.vscodeCommand) {
					return;
				}

				await vscode.commands.executeCommand(message.vscodeCommand);
				return;
			case 'install':
				await vscode.commands.executeCommand('doom.install');
				return;
			case 'cleanup':
				await vscode.commands.executeCommand('doom.cleanup');
				return;
			case 'openUrl':
				if (!message.url) {
					return;
				}

				await vscode.env.openExternal(vscode.Uri.parse(message.url));
				return;
			case 'setOpenOnActivation':
				await vscode.workspace
					.getConfiguration()
					.update(
						START_PAGE_OPEN_ON_ACTIVATION_SETTING,
						!Boolean(message.checked),
						vscode.ConfigurationTarget.Global,
					);
				return;
			default:
				return;
		}
	}

	private render(state: DoomStartPageState, webview: vscode.Webview): string {
		const nonce = createNonce();
		const staleBindingsFound = state.hasStaleSettings || state.hasStaleKeybindings;
		const installStatusText = state.defaultCount === 0
			? 'No Doom defaults configured.'
			: state.hasInstalledDefaults
				? 'Doom settings already installed.'
				: `Doom settings missing (${state.installedDefaultCount}/${state.defaultCount}).`;
		const startupCommandsMarkup = state.startupCommands.length > 0
			? state.startupCommands.map((entry) => `
				<li class="menu-item">
					<button class="menu-link" data-command="executeCommand" data-vscode-command="${this.escapeHtml(entry.command)}">
						<span class="menu-label-shell">
							<span class="menu-icon" aria-hidden="true">${this.getStartupCommandIcon(entry)}</span>
							<span class="menu-label">${this.escapeHtml(entry.label)}</span>
						</span>
						<span class="menu-key">${this.escapeHtml(entry.keybinding)}</span>
					</button>
				</li>`).join('')
			: '<li class="menu-item menu-empty">No default startup commands found in current which-key config.</li>';
		const conflictMarkup = state.conflicts.length > 0
			? `<p class="status-line status-warning">Conflicting extension still installed: ${this.escapeHtml(state.conflicts.map((conflict) => conflict.name).join(', '))}.</p>`
			: '';
		const installedDefaultsSummary = `${state.installedDefaultCount}/${state.defaultCount} installed`;
		const bootSummary = state.hasInstalledDefaults
			? `Doom settings ready (${installedDefaultsSummary})`
			: `Install Doom settings to match default profile (${installedDefaultsSummary})`;
		const eyebrow = this.getEyebrow(state);
		const repositoryMarkup = state.repositoryUrl
			? `<p class="repo-link-shell"><button class="repo-link" data-command="openUrl" data-url="${this.escapeHtml(state.repositoryUrl)}" aria-label="Open GitHub repository">${GITHUB_ICON}</button></p>`
			: '';

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${this.escapeHtml(this.getTitle(state))}</title>
	<style>
		:root {
			color-scheme: dark;
			--doom-bg: var(--vscode-editor-background, #282a36);
			--doom-fg: #a7abd8;
			--doom-muted: #7c82b6;
			--doom-cyan: #8be9fd;
			--doom-orange: #ffb86c;
			--doom-blue: #7aa2f7;
			--doom-cursor: #2bd3ff;
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			min-height: 100vh;
			padding: 28px 20px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
			background: var(--doom-bg);
			color: var(--doom-fg);
		}

		main {
			width: min(980px, 100%);
			display: grid;
			gap: 18px;
			justify-items: center;
		}

		.shell {
			width: min(880px, 100%);
			display: grid;
			gap: 20px;
			justify-items: center;
		}

		.eyebrow {
			margin: 0;
			font-size: 13px;
			letter-spacing: 0.16em;
			text-transform: uppercase;
			color: var(--doom-muted);
		}

		.ascii-header-shell {
			width: 100%;
			overflow-x: auto;
			overflow-y: hidden;
			text-align: center;
		}

		.ascii-header {
			display: inline-block;
			margin: 0;
			padding: 0;
			min-width: max-content;
			font-size: 13px;
			line-height: 13px;
			letter-spacing: 0;
			font-kerning: none;
			font-variant-ligatures: none;
			font-feature-settings: "liga" 0, "calt" 0;
			white-space: pre;
			color: var(--doom-muted);
			text-align: left;
		}

		.menu {
			width: min(460px, 100%);
			display: grid;
			gap: 18px;
		}

		.menu-list {
			list-style: none;
			margin: 0;
			padding: 0;
			display: grid;
			gap: 2px;
		}

		.menu-item {
			margin: 0;
		}

		.menu-link {
			width: 100%;
			padding: 2px 6px;
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 8px;
			align-items: baseline;
			background: transparent;
			border: 0;
			color: inherit;
			font: inherit;
			cursor: pointer;
			text-align: left;
		}

		.menu-label-shell {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			min-width: 0;
			color: var(--vscode-focusBorder, var(--doom-cyan));
		}

		.menu-icon {
			width: 1.4em;
			height: 1.4em;
			text-align: center;
			flex: 0 0 auto;
			color: inherit;
		}

		.menu-icon svg,
		.repo-link svg {
			display: block;
			width: 100%;
			height: 100%;
		}

		.menu-label {
			color: inherit;
		}

		.menu-key {
			color: var(--doom-orange);
			white-space: pre;
		}

		.menu-link:hover .menu-label-shell,
		.menu-link:focus-visible .menu-label-shell,
		.inline-link:hover,
		.inline-link:focus-visible {
			color: #b6f4ff;
		}

		.menu-link:hover .menu-key,
		.menu-link:focus-visible .menu-key {
			color: #ffd39d;
		}

		.menu-link:focus-visible,
		.inline-link:focus-visible,
		.toggle input:focus-visible {
			outline: 1px solid var(--doom-blue);
			outline-offset: 3px;
		}

		.menu-empty,
		.status-line,
		.boot,
		.toggle {
			text-align: center;
			color: var(--doom-muted);
			line-height: 1.6;
		}

		.status {
			display: grid;
			gap: 6px;
		}

		.status-warning {
			color: var(--doom-orange);
		}

		.inline-link {
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--doom-orange);
			font: inherit;
			cursor: pointer;
		}

		.boot {
			margin: 4px 0 0;
		}

		.version-indicator {
			margin: 0;
			font-size: 11px;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--doom-muted);
		}

		.repo-link-shell {
			margin: 0;
			text-align: center;
		}

		.repo-link {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 18px;
			height: 18px;
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--doom-orange);
			line-height: 1;
			cursor: pointer;
		}

		.repo-link:hover,
		.repo-link:focus-visible {
			color: #ffd39d;
		}

		.toggle {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			cursor: pointer;
		}

		.toggle input {
			width: 15px;
			height: 15px;
			margin: 0;
			accent-color: var(--doom-blue);
		}

		@media (max-width: 720px) {
			body {
				padding: 18px 14px;
			}

			.menu-link {
				gap: 12px;
			}

			.ascii-header {
				font-size: 11px;
				line-height: 11px;
			}
		}
	</style>
</head>
<body>
	<main>
		<section class="shell">
			${eyebrow ? `<p class="eyebrow">${this.escapeHtml(eyebrow)}</p>` : ''}
			<div class="ascii-header-shell">
				<pre class="ascii-header" aria-label="Doom Code ASCII art header">${this.escapeHtml(ASCII_HEADER)}</pre>
			</div>
			<section class="menu" aria-label="Startup commands">
				<ul class="menu-list">${startupCommandsMarkup}
				</ul>
				<div class="status">
					<p class="status-line">
						${staleBindingsFound ? 'Stale bindings found.' : 'No stale bindings found.'}
						${staleBindingsFound ? '<button class="inline-link" data-command="cleanup">Clean em up</button>' : ''}
					</p>
					<p class="status-line">
						${this.escapeHtml(installStatusText)}
						${!state.hasInstalledDefaults && state.defaultCount > 0 ? '<button class="inline-link" data-command="install">Install now</button>' : ''}
					</p>
					${conflictMarkup}
				</div>
			</section>
			<p class="boot">${this.escapeHtml(bootSummary)}</p>
			${repositoryMarkup}
			<p class="version-indicator">Doom v${this.escapeHtml(state.currentVersion)}</p>
			<label class="toggle" for="open-on-activation-toggle">
				<input
					id="open-on-activation-toggle"
					type="checkbox"
					${state.openOnActivation ? '' : 'checked'}
				>
				<span>Don’t show this page again</span>
			</label>
		</section>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		for (const button of document.querySelectorAll('[data-command]')) {
			button.addEventListener('click', () => {
				vscode.postMessage({
					command: button.getAttribute('data-command'),
					url: button.getAttribute('data-url'),
					vscodeCommand: button.getAttribute('data-vscode-command')
				});
			});
		}
		const startupToggle = document.getElementById('open-on-activation-toggle');
		if (startupToggle instanceof HTMLInputElement) {
			startupToggle.addEventListener('change', () => {
				vscode.postMessage({
					command: 'setOpenOnActivation',
					checked: startupToggle.checked
				});
			});
		}
	</script>
</body>
</html>`;
	}

	private getEyebrow(state: DoomStartPageState): string {
		switch (state.mode) {
			case 'welcome':
				return 'Fresh install';
			case 'update':
				return `Updated to ${state.currentVersion}`;
			default:
				return '';
		}
	}

	private escapeHtml(value: string): string {
		return escapeHtml(value);
	}

	private getStartupCommandIcon(entry: StartPageCommand): string {
		return START_PAGE_COMMAND_ICONS[entry.label] ?? '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="1.75" fill="currentColor"/></svg>';
	}
}