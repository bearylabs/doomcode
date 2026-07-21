import * as vscode from 'vscode';
import { relocateTabsAndCloseGroup } from '../buffers/openEditors';
import { DoomWhichKeyMenu } from '../whichkey/menu';
import { focusWindowDown, focusWindowLeft, focusWindowRight, focusWindowUp } from './mru';

export type WindowDeleteAction =
	| 'closePanel'
	| 'relocateAndCloseGroup'
	| 'keepGroup';
export type WindowDownAction = 'panelTerminal' | 'default';

/**
 * Pure function: determines the correct `doom.windowDelete` action based on focus context.
 * - Terminal panel focus (no editor terminal active) → close the panel.
 * - Another editor group exists → relocate every tab in the closing group to it, then remove the
 *   emptied group (files, diffs and terminals alike; terminals never go to the panel).
 * - Only one editor group → keep it untouched: there is nowhere to relocate its tabs, so `SPC w d`
 *   is a no-op rather than closing the group's editors (and never exiles a terminal to the panel).
 */
export function resolveWindowDeleteAction(
	terminalFocus: boolean,
	activeTerminalEditor: boolean,
	hasOtherEditorGroup: boolean,
): WindowDeleteAction {
	if (terminalFocus && !activeTerminalEditor) {
		return 'closePanel';
	}

	if (!hasOtherEditorGroup) {
		return 'keepGroup';
	}

	return 'relocateAndCloseGroup';
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

			if (action === 'keepGroup') {
				// Only one editor group is open, so there is nowhere to relocate its tabs. Leave it
				// untouched rather than closing its editors (and never exile a terminal to the panel).
				return;
			}

			// action === 'relocateAndCloseGroup': move every tab in the closing group — files, diffs and
			// terminals alike — into the adjacent group, then remove the emptied source group. The
			// closing group is the one active when whichkey opened (preWhichKeyEditorGroupColumn is set
			// during whichkey command execution and undefined for direct invocations); using it avoids
			// relying on focus being honoured after the whichkey panel closes. The destination is the
			// next-higher column (or the next-lower one when the source is the last group). Nothing is
			// force-closed, so dirty editors survive, and terminals land in an editor group rather than
			// the panel. Focus ends up in the destination group.
			const sourceColumn = whichKeyMenu.preWhichKeyEditorGroupColumn ?? activeGroup.viewColumn;
			const targetColumn = resolveAdjacentEditorColumn(sourceColumn, vscode.window.tabGroups.all);
			if (targetColumn === undefined) {
				return;
			}

			await relocateTabsAndCloseGroup(sourceColumn, targetColumn);
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
