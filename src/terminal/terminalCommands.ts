import * as vscode from 'vscode';

const VTERM_NAME = '*vterm*';
const VTERM_PREFIX = '*vterm*';

/**
 * AI-CLI editor terminals. Each entry registers a command that opens an editor
 * terminal with a fixed name and launches the matching CLI. The name set also
 * seeds {@link EDITOR_TERMINAL_NAMES} so these terminals are recognised by
 * {@link isVtermName} and excluded from panel-terminal switching (`SPC o t`).
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
 * Names that identify editor-group terminals (as opposed to panel terminals),
 * derived from the CLI table.
 */
const EDITOR_TERMINAL_NAMES = new Set<string>(CLI_TERMINALS.map((cli) => cli.name));

const isVtermName = (name: string) =>
	name === VTERM_NAME
	|| name.startsWith(`${VTERM_PREFIX}<`)
	|| EDITOR_TERMINAL_NAMES.has(name.toLowerCase());

/**
 * Opens an AI tool CLI in an editor terminal with a fixed name.
 * The consistent name lets `isVtermName()` exclude it from panel terminal
 * switching (SPC o t) and lets users reliably find the CLI terminal by name.
 * Creates a new terminal each trigger (no reuse).
 */
async function openCliTerminal(name: string): Promise<void> {
	const terminal = vscode.window.createTerminal({
		name,
		location: vscode.TerminalLocation.Editor,
	});
	terminal.show();
	await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
	terminal.sendText(name);
}

/** Registers the editor/AI-CLI terminal and panel-terminal commands. */
export function register(context: vscode.ExtensionContext): void {
	const managedVtermSet = new Set<vscode.Terminal>();

	/** Creates a named editor-group terminal so `doom.openPanelTerminal` can exclude it by name. */
	const createTerminalEditorCmd = vscode.commands.registerCommand(
		"doom.createTerminalEditor",
		async () => {
			const vtermCount = vscode.window.terminals.filter((t) => isVtermName(t.name)).length;
			const name = vtermCount === 0 ? VTERM_NAME : `${VTERM_PREFIX}<${vtermCount + 1}>`;
			const terminal = vscode.window.createTerminal({
				name,
				location: vscode.TerminalLocation.Editor,
			});
			managedVtermSet.add(terminal);
			terminal.show();
			// Lock the title so the shell (bash PROMPT_COMMAND / PS1) cannot override it
			await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
		}
	);

	const cliTerminalCmds = CLI_TERMINALS.map((cli) =>
		vscode.commands.registerCommand(cli.commandId, () => openCliTerminal(cli.name)),
	);

	/**
	 * Opens the panel terminal without disturbing terminals in editor groups.
	 * Editor terminals created via `doom.createTerminalEditor` are named `*vterm*` or `*vterm*<N>`.
	 * Known CLI editor terminals such as `claude`, `copilot`, and `codex` are also excluded by name.
	 * Panel terminals are anything not carrying those names.
	 * Falls back to creating a new panel terminal only when none exist.
	 * Uses show(true) to pre-select the terminal, then workbench.view.terminal to reliably
	 * open the panel — terminal.show() alone doesn't guarantee the panel opens.
	 */
	const openPanelTerminalCmd = vscode.commands.registerCommand(
		"doom.openPanelTerminal",
		async () => {
			const panelTerminals = vscode.window.terminals.filter((t) => !isVtermName(t.name));

			if (panelTerminals.length > 0) {
				// Existing terminal — show(false) is reliable, no extra focus step needed
				panelTerminals[panelTerminals.length - 1].show(false);
			} else {
				// New terminal — show(false) selects it and opens the panel, but shell
				// initialization may not be done yet so focus doesn't always land;
				// workbench.action.terminal.focus follows up to ensure it does
				const terminal = vscode.window.createTerminal({ location: vscode.TerminalLocation.Panel });
				terminal.show(false);
				await vscode.commands.executeCommand('workbench.action.terminal.focus');
			}
		}
	);

	context.subscriptions.push(
		createTerminalEditorCmd,
		...cliTerminalCmds,
		openPanelTerminalCmd,
	);
}
