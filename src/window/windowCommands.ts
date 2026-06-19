import * as vscode from 'vscode';
import { DoomWhichKeyMenu } from '../whichkey/menu';
import { focusEditorGroup, focusWindowDown, focusWindowLeft, focusWindowRight, focusWindowUp } from './mru';

export type WindowDeleteAction = 'closeGroup' | 'closePanel' | 'moveTerminalEditorToPanelAndCloseGroup';
export type WindowDownAction = 'panelTerminal' | 'default';

/**
 * Pure function: determines the correct `doom.windowDelete` action based on focus context.
 * Terminal panel focus → close panel. Terminal editor tab → move back to panel first. Otherwise → close group.
 */
export function resolveWindowDeleteAction(
	terminalFocus: boolean,
	activeTerminalEditor: boolean,
): WindowDeleteAction {
	if (terminalFocus && !activeTerminalEditor) {
		return 'closePanel';
	}

	if (activeTerminalEditor) {
		return 'moveTerminalEditorToPanelAndCloseGroup';
	}

	return 'closeGroup';
}

/**
 * Pure function: `SPC w j` from a bottom-most editor terminal should descend into the panel
 * terminal, but VS Code has no API to focus a terminal by location when an editor terminal and
 * a panel terminal coexist — `focusPanel`/`terminal.focus` target the editor terminal and leave
 * the which-key view stuck in the panel. The `doom.openPanelTerminal` primitive selects the panel
 * terminal by name instead, so route to it whenever both terminals are present.
 */
export function resolveWindowDownAction(
	isEditorTerminal: boolean,
	hasPanelTerminal: boolean,
): WindowDownAction {
	return isEditorTerminal && hasPanelTerminal ? 'panelTerminal' : 'default';
}

export interface WindowCommandDeps {
	whichKeyMenu: DoomWhichKeyMenu;
}

/** Registers `doom.windowDelete` and the window focus/split commands. */
export function register(context: vscode.ExtensionContext, deps: WindowCommandDeps): void {
	const { whichKeyMenu } = deps;

	const windowDeleteCmd = vscode.commands.registerCommand(
		"doom.windowDelete",
		async () => {
			const activeGroup = vscode.window.tabGroups.activeTabGroup;
			const activeTerminalEditor = activeGroup.activeTab?.input instanceof vscode.TabInputTerminal;
			const action = resolveWindowDeleteAction(
				whichKeyMenu.showContext.terminalFocus,
				activeTerminalEditor,
			);

			if (action === 'closePanel') {
				await vscode.commands.executeCommand('workbench.action.closePanel');
				return;
			}

			if (action === 'moveTerminalEditorToPanelAndCloseGroup') {
				await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
				await focusEditorGroup(activeGroup.viewColumn);
				await vscode.commands.executeCommand('workbench.action.closeGroup');
				return;
			}

			// Use the group that was active when whichkey opened (preWhichKeyEditorGroupColumn is set
			// during whichkey command execution and undefined for direct invocations). This avoids
			// relying on workbench.action.closeGroup honouring focus, which VS Code does not guarantee
			// after the whichkey panel closes.
			const targetColumn = whichKeyMenu.preWhichKeyEditorGroupColumn ?? activeGroup.viewColumn;
			const groupToClose = vscode.window.tabGroups.all.find(g => g.viewColumn === targetColumn)
				?? activeGroup;
			await vscode.window.tabGroups.close(groupToClose);
		}
	);

	const windowLeftCmd = vscode.commands.registerCommand(
		"doom.windowLeft",
		async () => {
			const activeGroup = vscode.window.tabGroups.activeTabGroup;
			const explorerVisible = whichKeyMenu.trackedUiContext.explorerViewletVisible;
			await focusWindowLeft(activeGroup, vscode.window.tabGroups.all, explorerVisible, whichKeyMenu.showContext.explorerFocused);
		}
	);

	const windowRightCmd = vscode.commands.registerCommand(
		"doom.windowRight",
		async () => {
			const activeGroup = vscode.window.tabGroups.activeTabGroup;
			await focusWindowRight(whichKeyMenu.showContext.explorerFocused, activeGroup, vscode.window.tabGroups.all);
		}
	);

	const windowUpCmd = vscode.commands.registerCommand(
		"doom.windowUp",
		async () => {
			const panelFocused = whichKeyMenu.showContext.terminalFocus && whichKeyMenu.showContext.terminalPanelOpen;
			await focusWindowUp(panelFocused);
		}
	);

	const windowDownCmd = vscode.commands.registerCommand(
		"doom.windowDown",
		async () => {
			const activeGroup = vscode.window.tabGroups.activeTabGroup;
			const isEditorTerminal = activeGroup.activeTab?.input instanceof vscode.TabInputTerminal;

			// A panel terminal is any terminal not represented as an editor-area terminal tab.
			const editorTerminalLabels = new Set(
				vscode.window.tabGroups.all
					.flatMap(g => g.tabs)
					.filter(t => t.input instanceof vscode.TabInputTerminal)
					.map(t => t.label)
			);
			const hasPanelTerminal = vscode.window.terminals.some(t => !editorTerminalLabels.has(t.name));

			if (resolveWindowDownAction(isEditorTerminal, hasPanelTerminal) === 'panelTerminal') {
				// Descend into the panel terminal only when the editor terminal is the bottom-most group.
				// If a group exists below, focusBelowGroup moves there and we keep normal down behaviour.
				const before = activeGroup.viewColumn;
				await vscode.commands.executeCommand('workbench.action.focusBelowGroup');
				if (vscode.window.tabGroups.activeTabGroup.viewColumn === before) {
					await vscode.commands.executeCommand('doom.openPanelTerminal');
				}
				return;
			}

			const panelVisible = whichKeyMenu.trackedUiContext.activePanel !== '';
			await focusWindowDown(activeGroup, panelVisible);
		}
	);

	context.subscriptions.push(
		windowDeleteCmd,
		windowLeftCmd,
		windowRightCmd,
		windowUpCmd,
		windowDownCmd,
	);
}
