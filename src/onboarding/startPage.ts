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
	description: string;
	defaultCount: number;
	installedDefaultCount: number;
	hasInstalledDefaults: boolean;
	hasStaleSettings: boolean;
	hasStaleKeybindings: boolean;
	openOnActivation: boolean;
	startupCommands: StartPageCommand[];
	conflicts: StartPageConflict[];
	repositoryUrl?: string;
	homepageUrl?: string;
	issuesUrl?: string;
	changelogMarkdown: string;
}

export interface StartPageCommand {
	label: string;
	keybinding: string;
	command: string;
}

export interface InstallDefaultsState {
	matchingDefaults: number;
	totalDefaults: number;
	isInstalled: boolean;
}

interface WhichKeyBindingNode {
	key?: string;
	type?: string;
	command?: string;
	bindings?: unknown;
}

const STARTUP_COMMAND_CANDIDATES = [
	{
		label: 'Recently opened files',
		keyPath: ['f', 'r'],
		command: 'workbench.action.openRecent',
	},
	{
		label: 'Reload last session',
		keyPath: ['q', 'l'],
		command: 'doom.reloadLastSession',
	},
	{
		label: 'Open org-agenda',
		keyPath: ['o', 'A'],
		command: 'doom.openOrgAgenda',
	},
	{
		label: 'Open project',
		keyPath: ['p', 'p'],
		command: 'workbench.action.openRecent',
	},
	{
		label: 'Jump to bookmark',
		keyPath: ['RET'],
		command: 'doom.jumpToBookmark',
	},
	{
		label: 'Open private configuration',
		keyPath: ['f', 'P'],
		command: 'doom.openPrivateConfig',
	},
	{
		label: 'Open documentation',
		keyPath: ['h', 'd', 'h'],
		command: 'doom.openDocumentation',
	},
] as const;

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

function resolveBindingCommand(bindings: unknown, keyPath: readonly string[]): string | undefined {
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
		return currentEntry.command;
	}

	const defaultBinding = currentBindings.find((entry) => entry.key === '');
	return typeof defaultBinding?.command === 'string' ? defaultBinding.command : undefined;
}

export function resolveStartupCommandsFromBindings(bindings: unknown): StartPageCommand[] {
	return STARTUP_COMMAND_CANDIDATES.flatMap((candidate) => {
		const command = resolveBindingCommand(bindings, candidate.keyPath);
		if (command !== candidate.command) {
			return [];
		}

		return [{
			label: candidate.label,
			keybinding: `SPC ${candidate.keyPath.join(' ')}`,
			command,
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
						<span class="menu-label">${this.escapeHtml(entry.label)}</span>
						<span class="menu-key">${this.escapeHtml(entry.keybinding)}</span>
					</button>
				</li>`).join('')
			: '<li class="menu-item menu-empty">No default startup commands found in current which-key config.</li>';
		const conflictMarkup = state.conflicts.length > 0
			? `<p class="status-line status-warning">Conflicting extension still installed: ${this.escapeHtml(state.conflicts.map((conflict) => conflict.name).join(', '))}.</p>`
			: '';
		const bootSummary = `Doom Code ${state.currentVersion} loaded ${state.startupCommands.length} startup command${state.startupCommands.length === 1 ? '' : 's'} and ${state.defaultCount} default${state.defaultCount === 1 ? '' : 's'} in current profile`;

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
			width: min(520px, 100%);
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
			gap: 24px;
			align-items: baseline;
			background: transparent;
			border: 0;
			color: inherit;
			font: inherit;
			cursor: pointer;
			text-align: left;
		}

		.menu-label {
			color: var(--doom-cyan);
		}

		.menu-key {
			color: var(--doom-orange);
			white-space: pre;
		}

		.menu-link:hover .menu-label,
		.menu-link:focus-visible .menu-label,
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
			<p class="eyebrow">${this.escapeHtml(this.getEyebrow(state))}</p>
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
				return `Startup ${state.currentVersion}`;
		}
	}

	private escapeHtml(value: string): string {
		return escapeHtml(value);
	}
}