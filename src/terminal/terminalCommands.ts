import * as vscode from 'vscode';

const VTERM_NAME = '*vterm*';
const VTERM_PREFIX = '*vterm*';

/**
 * AI-CLI editor terminals. Each entry registers a command that opens an editor
 * terminal with a fixed name and launches the matching CLI. The name is cosmetic:
 * it labels the tab in the buffer list, but nothing dispatches on it — editor
 * terminals are identified by their tab type, see {@link countEditorTerminals}.
 */
interface CliTerminal {
	commandId: string;
	name: string;
}

const CLI_TERMINALS: CliTerminal[] = [
	{ commandId: 'doom.openClaudeCli', name: 'claude' },
	{ commandId: 'doom.openCopilotCli', name: 'copilot' },
	{ commandId: 'doom.openCodexCli', name: 'codex' },
];

/**
 * Counts terminals living in editor groups. A terminal editor is the only thing that carries a
 * `TabInputTerminal` tab input, and that tab type survives a window reload — unlike the terminal's
 * name, which VS Code restores only intermittently once persistent sessions are enabled.
 */
function countEditorTerminals(): number {
	return vscode.window.tabGroups.all.reduce(
		(total, group) => total + group.tabs.filter((tab) => tab.input instanceof vscode.TabInputTerminal).length,
		0,
	);
}

/** Terminals created with `hideFromUser` own neither a tab nor a panel entry, so they must not skew the count. */
function isHiddenTerminal(terminal: vscode.Terminal): boolean {
	const options = terminal.creationOptions;
	return 'hideFromUser' in options && options.hideFromUser === true;
}

/**
 * Whether at least one terminal sits in the panel. Every visible terminal is either an editor
 * terminal — and then owns exactly one tab — or a panel terminal, so any surplus over the tab
 * count must be in the panel.
 */
export function hasPanelTerminal(): boolean {
	const visibleTerminals = vscode.window.terminals.filter((terminal) => !isHiddenTerminal(terminal));
	return visibleTerminals.length > countEditorTerminals();
}

/**
 * Opens an AI tool CLI in an editor terminal with a fixed name so users can reliably find it
 * by name in the buffer list. Creates a new terminal each trigger (no reuse).
 */
async function openCliTerminal(name: string): Promise<void> {
	const terminal = vscode.window.createTerminal({
		name,
		location: vscode.TerminalLocation.Editor,
	});
	terminal.show();
	await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
	// A freshly created editor terminal's renderer/shell may not be ready when show() runs, so
	// focus doesn't reliably land in it (worse on a cold start while editors are still restoring).
	// terminal.focus reasserts focus into the terminal — same follow-up doom.openPanelTerminal uses.
	await vscode.commands.executeCommand('workbench.action.terminal.focus');
	terminal.sendText(name);
}

/** Registers the editor/AI-CLI terminal and panel-terminal commands. */
export function register(context: vscode.ExtensionContext): void {
	/**
	 * Creates an editor-group terminal named `*vterm*` / `*vterm*<N>`. The number continues past
	 * existing editor terminals so a reload doesn't restart the sequence at `*vterm*`.
	 */
	const createTerminalEditorCmd = vscode.commands.registerCommand(
		"doom.createTerminalEditor",
		async () => {
			const editorTerminalCount = countEditorTerminals();
			const name = editorTerminalCount === 0 ? VTERM_NAME : `${VTERM_PREFIX}<${editorTerminalCount + 1}>`;
			const terminal = vscode.window.createTerminal({
				name,
				location: vscode.TerminalLocation.Editor,
			});
			terminal.show();
			// Lock the title so the shell (bash PROMPT_COMMAND / PS1) cannot override it
			await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
			// show() alone doesn't reliably focus a freshly created editor terminal (the renderer/shell
			// may not be ready yet, especially on a cold start while editors restore), so reassert focus.
			await vscode.commands.executeCommand('workbench.action.terminal.focus');
		}
	);

	const cliTerminalCmds = CLI_TERMINALS.map((cli) =>
		vscode.commands.registerCommand(cli.commandId, () => openCliTerminal(cli.name)),
	);

	/**
	 * Opens the panel terminal without disturbing terminals in editor groups.
	 * `terminal.focus` reveals the panel and selects the panel's own active terminal, so we never
	 * have to pick a terminal ourselves. (The `workbench.view.terminal` id this used to rely on no
	 * longer exists; the terminal view container is registered as plain `terminal` these days.)
	 * Falls back to creating a new panel terminal only when none exist.
	 */
	const openPanelTerminalCmd = vscode.commands.registerCommand(
		"doom.openPanelTerminal",
		async () => {
			if (hasPanelTerminal()) {
				await vscode.commands.executeCommand('terminal.focus');
				return;
			}

			// New terminal — show(false) selects it and opens the panel, but shell
			// initialization may not be done yet so focus doesn't always land;
			// workbench.action.terminal.focus follows up to ensure it does
			const terminal = vscode.window.createTerminal({ location: vscode.TerminalLocation.Panel });
			terminal.show(false);
			await vscode.commands.executeCommand('workbench.action.terminal.focus');
		}
	);

	context.subscriptions.push(
		createTerminalEditorCmd,
		...cliTerminalCmds,
		openPanelTerminalCmd,
	);
}
