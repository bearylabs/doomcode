import * as vscode from 'vscode';
import { moveTerminalEditorToGroup, revealExistingTab } from '../buffers/openEditors';
import { hasPanelTerminal } from '../terminal/terminalCommands';
import { DoomWhichKeyMenu } from '../whichkey/menu';
import { focusWindowDown, focusWindowLeft, focusWindowRight, focusWindowUp } from './mru';

export type WindowDeleteAction =
	| 'closePanel'
	| 'keepGroup'
	| 'closeGroup'
	| 'moveTerminalsThenCloseGroup';
export type WindowDownAction = 'panelTerminal' | 'default';

/**
 * Pure function: determines the correct `doom.windowDelete` action based on focus context.
 * - Terminal panel focus (no editor terminal active) → close the panel.
 * - Only one editor group → keep it untouched: there is nowhere to send a terminal, so `SPC w d`
 *   is a no-op rather than closing the group's editors (and never exiles a terminal to the panel).
 * - Source group has file editors only → close it natively; VS Code focuses the adjacent group and
 *   expands it to fill (fast, no relocation, no flashing).
 * - Source group holds a terminal editor → evacuate the terminal(s) into the neighbour first (a
 *   terminal would otherwise be exiled to the panel on close), then close the emptied source group.
 */
export function resolveWindowDeleteAction(
	terminalFocus: boolean,
	activeTerminalEditor: boolean,
	hasOtherEditorGroup: boolean,
	sourceGroupHasTerminal: boolean,
): WindowDeleteAction {
	if (terminalFocus && !activeTerminalEditor) {
		return 'closePanel';
	}

	if (!hasOtherEditorGroup) {
		return 'keepGroup';
	}

	return sourceGroupHasTerminal ? 'moveTerminalsThenCloseGroup' : 'closeGroup';
}

/**
 * Pure function: picks the editor-group column that should receive the relocated tabs when its group
 * is closed — the next-higher column, or the next-lower column when the closing group is the last one.
 * Returns undefined when there is no other editor group to receive them.
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
 * the which-key view stuck in the panel. The `doom.openPanelTerminal` primitive reveals the panel
 * itself, so route to it whenever both terminals are present.
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
			// The closing group is the one active when whichkey opened (preWhichKeyEditorGroupColumn is
			// set during whichkey command execution and undefined for direct invocations); using it is
			// robust against the which-key menu's focus handoff — the menu opens in its own editor group
			// since 0.9.0.
			const sourceColumn = whichKeyMenu.preWhichKeyEditorGroupColumn ?? activeGroup.viewColumn;
			const sourceGroup = vscode.window.tabGroups.all.find((group) => group.viewColumn === sourceColumn);

			const activeTerminalEditor = activeGroup.activeTab?.input instanceof vscode.TabInputTerminal;
			const hasOtherEditorGroup = vscode.window.tabGroups.all.some(
				(group) => group.viewColumn !== sourceColumn,
			);
			const sourceGroupHasTerminal = sourceGroup?.tabs.some(
				(tab) => tab.input instanceof vscode.TabInputTerminal,
			) ?? false;
			const action = resolveWindowDeleteAction(
				whichKeyMenu.showContext.terminalFocus,
				activeTerminalEditor,
				hasOtherEditorGroup,
				sourceGroupHasTerminal,
			);

			if (action === 'closePanel') {
				await vscode.commands.executeCommand('workbench.action.closePanel');
				return;
			}

			if (action === 'keepGroup') {
				// Only one editor group is open, so there is nowhere to send a terminal. Leave it
				// untouched rather than closing its editors (and never exile a terminal to the panel).
				return;
			}

			if (!sourceGroup) {
				return;
			}

			if (action === 'closeGroup') {
				// File editors only: close the focused group natively. VS Code focuses an adjacent group
				// automatically and expands it to fill — fast, no relocation, no flashing. Unsaved files
				// trigger VS Code's normal save prompt.
				await vscode.window.tabGroups.close(sourceGroup);
				return;
			}

			// action === 'moveTerminalsThenCloseGroup': the source group holds terminal editor(s), which
			// cannot simply be dropped like files (closing the group would exile them to the panel).
			// Evacuate each terminal into the adjacent group, then close the source group to drop its
			// remaining file editors. The destination is the next-higher column (or the next-lower one
			// when the source is the last group).
			const targetColumn = resolveAdjacentEditorColumn(sourceColumn, vscode.window.tabGroups.all);
			if (targetColumn === undefined) {
				return;
			}

			// Capture the neighbour's active tab before moving anything: VS Code always activates a moved
			// editor at its destination, so the terminal(s) would cover the neighbour's editor otherwise.
			const targetGroup = vscode.window.tabGroups.all.find((group) => group.viewColumn === targetColumn);
			const neighborActiveTab = targetGroup?.activeTab;

			// Move each terminal tab out of the source group. Re-read the source group each pass because
			// moving a tab invalidates prior Tab references.
			const terminalCount = sourceGroup.tabs.filter((tab) => tab.input instanceof vscode.TabInputTerminal).length;
			for (let pass = 0; pass < terminalCount; pass++) {
				const currentSource = vscode.window.tabGroups.all.find((group) => group.viewColumn === sourceColumn);
				const terminalTab = currentSource?.tabs.find((tab) => tab.input instanceof vscode.TabInputTerminal);
				if (!terminalTab) {
					break;
				}

				if (!(await revealExistingTab(terminalTab))) {
					break;
				}
				await moveTerminalEditorToGroup(terminalTab, targetColumn);
			}

			// Close the now terminal-free source group to drop its remaining file editors. Skip only when
			// a terminal is still stuck there (a move failed), so a failed move never force-closes it.
			const leftoverGroup = vscode.window.tabGroups.all.find((group) => group.viewColumn === sourceColumn);
			const holdsTerminal = leftoverGroup?.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal);
			if (leftoverGroup && !holdsTerminal) {
				await vscode.window.tabGroups.close(leftoverGroup);
			}

			// Re-activate the neighbour's previously-active tab so the moved terminal(s) sit in the
			// background rather than covering it.
			if (neighborActiveTab) {
				await revealExistingTab(neighborActiveTab);
			}
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

			if (resolveWindowDownAction(isEditorTerminal, hasPanelTerminal()) === 'panelTerminal') {
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
