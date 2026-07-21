import * as vscode from 'vscode';
import { moveTerminalEditorToGroup, revealExistingTab } from '../buffers/openEditors';
import { DoomWhichKeyMenu } from '../whichkey/menu';
import { focusEditorGroup, focusWindowDown, focusWindowLeft, focusWindowRight, focusWindowUp } from './mru';

export type WindowDeleteAction =
	| 'closeGroup'
	| 'closePanel'
	| 'moveTerminalEditorToGroup'
	| 'keepTerminalEditor';
export type WindowDownAction = 'panelTerminal' | 'default';

/**
 * Pure function: determines the correct `doom.windowDelete` action based on focus context.
 * - Terminal panel focus → close the panel.
 * - Terminal editor tab with another editor group present → relocate it to that group (never the panel).
 * - Terminal editor tab that is the only editor group → keep it in place (no other group to receive it).
 * - Otherwise → close the group.
 */
export function resolveWindowDeleteAction(
	terminalFocus: boolean,
	activeTerminalEditor: boolean,
	hasOtherEditorGroup: boolean,
): WindowDeleteAction {
	if (terminalFocus && !activeTerminalEditor) {
		return 'closePanel';
	}

	if (activeTerminalEditor) {
		return hasOtherEditorGroup ? 'moveTerminalEditorToGroup' : 'keepTerminalEditor';
	}

	return 'closeGroup';
}

/**
 * Pure function: picks the editor-group column that should receive a terminal when its group is
 * closed — the next-higher column, or the next-lower column when the closing group is the last one.
 * Returns undefined when there is no other editor group to receive the terminal.
 */
export function resolveAdjacentEditorColumn(
	sourceColumn: vscode.ViewColumn | undefined,
	tabGroups: readonly Pick<vscode.TabGroup, 'viewColumn'>[],
): vscode.ViewColumn | undefined {
	if (sourceColumn === undefined) {
		return undefined;
	}

	const columns = tabGroups
		.map((group) => group.viewColumn)
		.filter((column): column is vscode.ViewColumn => column !== undefined && column !== sourceColumn)
		.sort((left, right) => left - right);
	if (columns.length === 0) {
		return undefined;
	}

	return columns.find((column) => column > sourceColumn) ?? columns[columns.length - 1];
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
			const hasOtherEditorGroup = vscode.window.tabGroups.all.some(
				(group) => group.viewColumn !== activeGroup.viewColumn,
			);
			const action = resolveWindowDeleteAction(
				whichKeyMenu.showContext.terminalFocus,
				activeTerminalEditor,
				hasOtherEditorGroup,
			);

			if (action === 'closePanel') {
				await vscode.commands.executeCommand('workbench.action.closePanel');
				return;
			}

			if (action === 'keepTerminalEditor') {
				// The terminal editor is the only editor group, so there is nowhere to relocate it.
				// Leave it in place rather than exiling it to the panel.
				return;
			}

			if (action === 'moveTerminalEditorToGroup') {
				// `activeTerminalEditor` was derived from `activeGroup`, so the terminal's group is the
				// active one here (whichkey restores focus to it before this command runs).
				const sourceColumn = activeGroup.viewColumn;
				const targetColumn = resolveAdjacentEditorColumn(sourceColumn, vscode.window.tabGroups.all);
				if (targetColumn === undefined) {
					return;
				}

				// Move every terminal editor in the group to the adjacent group. Re-read the source group
				// each pass because moving a tab invalidates prior Tab references and, once the group holds
				// only that terminal, removes the (now empty) group entirely.
				const maxPasses = activeGroup.tabs.length;
				for (let pass = 0; pass < maxPasses; pass++) {
					const sourceGroup = vscode.window.tabGroups.all.find((group) => group.viewColumn === sourceColumn);
					const terminalTab = sourceGroup?.tabs.find((tab) => tab.input instanceof vscode.TabInputTerminal);
					if (!terminalTab) {
						break;
					}

					if (!(await revealExistingTab(terminalTab))) {
						break;
					}
					await moveTerminalEditorToGroup(terminalTab, targetColumn);
				}

				// Close the source group now that its terminals have left. VS Code does not reliably
				// remove the group the move leaves empty, so close it explicitly; this also closes any
				// non-terminal tabs that stayed behind. Skip only when the emptied group collapsed and
				// another group — the one now holding the relocated terminal — renumbered onto
				// `sourceColumn`, or when the move failed and the terminal is still there.
				const leftoverGroup = vscode.window.tabGroups.all.find((group) => group.viewColumn === sourceColumn);
				const holdsTerminal = leftoverGroup?.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal);
				if (leftoverGroup && !holdsTerminal) {
					await vscode.window.tabGroups.close(leftoverGroup);
				}

				// Land focus on the group that received the terminal, tolerating column renumbering.
				const remainingColumns = vscode.window.tabGroups.all
					.map((group) => group.viewColumn)
					.filter((column): column is vscode.ViewColumn => column !== undefined);
				const focusColumn = remainingColumns.includes(targetColumn)
					? targetColumn
					: remainingColumns.sort((left, right) => left - right)[0];
				if (focusColumn !== undefined) {
					await focusEditorGroup(focusColumn);
				}
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
