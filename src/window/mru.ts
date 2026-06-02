import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Editor group focus commands
// ---------------------------------------------------------------------------

const FOCUS_GROUP_COMMANDS: Partial<Record<vscode.ViewColumn, string>> = {
	[vscode.ViewColumn.One]: "workbench.action.focusFirstEditorGroup",
	[vscode.ViewColumn.Two]: "workbench.action.focusSecondEditorGroup",
	[vscode.ViewColumn.Three]: "workbench.action.focusThirdEditorGroup",
	[vscode.ViewColumn.Four]: "workbench.action.focusFourthEditorGroup",
	[vscode.ViewColumn.Five]: "workbench.action.focusFifthEditorGroup",
	[vscode.ViewColumn.Six]: "workbench.action.focusSixthEditorGroup",
	[vscode.ViewColumn.Seven]: "workbench.action.focusSeventhEditorGroup",
	[vscode.ViewColumn.Eight]: "workbench.action.focusEighthEditorGroup",
	[vscode.ViewColumn.Nine]: "workbench.action.focusNinthEditorGroup",
};

// ---------------------------------------------------------------------------
// MRU controller
// ---------------------------------------------------------------------------

/** Focuses an editor group by column number. Returns false if column exceeds the mapped range (>9). */
export async function focusEditorGroup(viewColumn: vscode.ViewColumn): Promise<boolean> {
	const focusCommand = FOCUS_GROUP_COMMANDS[viewColumn];
	if (!focusCommand) {
		return false;
	}

	await vscode.commands.executeCommand(focusCommand);
	return true;
}

type EditorGroupLike = Pick<vscode.TabGroup, 'viewColumn'>;
export type WindowLeftTarget = 'explorer' | 'leftGroup' | 'stay';
export type WindowRightTarget = 'firstGroup' | 'rightGroup' | 'stay';

/** Returns the leftmost editor group's view column, or undefined when no editor groups exist. */
export function getLeftmostEditorGroup(tabGroups: readonly EditorGroupLike[]): vscode.ViewColumn | undefined {
	const sortedGroups = tabGroups
		.map((group) => group.viewColumn)
		.filter((viewColumn): viewColumn is vscode.ViewColumn => viewColumn !== undefined)
		.sort((left, right) => left - right);

	return sortedGroups[0];
}

/** Returns the rightmost editor group's view column, or undefined when no editor groups exist. */
export function getRightmostEditorGroup(tabGroups: readonly EditorGroupLike[]): vscode.ViewColumn | undefined {
	const sortedGroups = tabGroups
		.map((group) => group.viewColumn)
		.filter((viewColumn): viewColumn is vscode.ViewColumn => viewColumn !== undefined)
		.sort((left, right) => right - left);

	return sortedGroups[0];
}

/**
 * Resolves what `SPC w h` should target.
 * - Explorer focused → stay (explorer is already the leftmost pane).
 * - Leftmost editor + explorer visible → focus explorer.
 * - Leftmost editor + no explorer → stay (avoid wrapping to rightmost group).
 * - Otherwise → focus left group.
 */
export function resolveWindowLeftTarget(
	activeGroup: EditorGroupLike,
	tabGroups: readonly EditorGroupLike[],
	explorerVisible: boolean,
	explorerFocused: boolean,
): WindowLeftTarget {
	if (explorerFocused) { return 'stay'; }

	if (activeGroup.viewColumn === undefined) {
		return 'leftGroup';
	}

	if (getLeftmostEditorGroup(tabGroups) === activeGroup.viewColumn) {
		return explorerVisible ? 'explorer' : 'stay';
	}

	return 'leftGroup';
}

/** Executes `SPC w h` using the resolved target. */
export async function focusWindowLeft(
	activeGroup: EditorGroupLike,
	tabGroups: readonly EditorGroupLike[],
	explorerVisible: boolean,
	explorerFocused: boolean,
	executeCommand: (command: string) => Thenable<unknown> | Promise<unknown> = vscode.commands.executeCommand,
	getActiveViewColumn: () => vscode.ViewColumn | undefined = () => vscode.window.tabGroups.activeTabGroup.viewColumn,
): Promise<void> {
	const target = resolveWindowLeftTarget(activeGroup, tabGroups, explorerVisible, explorerFocused);
	if (target === 'stay') { return; }
	if (target === 'explorer') {
		await executeCommand('workbench.view.explorer');
		return;
	}
	await executeCommand('workbench.action.focusLeftGroup');
	// focusLeftGroup is a no-op when the active group is in the leftmost visual column but not
	// the minimum viewColumn (e.g. bottom pane of a top-down split). Fall back to explorer.
	if (explorerVisible && getActiveViewColumn() === activeGroup.viewColumn) {
		await executeCommand('workbench.view.explorer');
	}
}

/**
 * Resolves what `SPC w l` should target.
 * - Explorer focused → focus first editor group.
 * - Rightmost group → stay (avoid wrapping to leftmost group).
 * - Otherwise → focus right group.
 */
export function resolveWindowRightTarget(
	explorerFocused: boolean,
	activeGroup: EditorGroupLike,
	tabGroups: readonly EditorGroupLike[],
): WindowRightTarget {
	if (explorerFocused) { return 'firstGroup'; }

	if (activeGroup.viewColumn !== undefined && getRightmostEditorGroup(tabGroups) === activeGroup.viewColumn) {
		return 'stay';
	}

	return 'rightGroup';
}

/** Executes `SPC w l` using the resolved target. */
export async function focusWindowRight(
	explorerFocused: boolean,
	activeGroup: EditorGroupLike,
	tabGroups: readonly EditorGroupLike[],
	executeCommand: (command: string) => Thenable<unknown> | Promise<unknown> = vscode.commands.executeCommand,
): Promise<void> {
	const target = resolveWindowRightTarget(explorerFocused, activeGroup, tabGroups);
	if (target === 'stay') { return; }
	await executeCommand(
		target === 'firstGroup'
			? 'workbench.action.focusFirstEditorGroup'
			: 'workbench.action.focusRightGroup'
	);
}

export interface WindowMruController {
	getLastActiveGroup(): vscode.ViewColumn | undefined;
	recordActiveGroup(): void;
	toggle(): Promise<void>;
}

/**
 * Factory for the MRU toggle controller. Keeps only the two most-recent groups — enough
 * to toggle back and forth without leaking memory as groups open and close.
 */
function createEditorGroupMruToggle(): WindowMruController {
	const recentGroups: vscode.ViewColumn[] = [];

	// Move-to-back MRU update: deduplicates then pushes, trimming the list to 2 entries.
	const recordGroup = (viewColumn: vscode.ViewColumn | undefined): void => {
		if (viewColumn === undefined) {
			return;
		}

		const existingIndex = recentGroups.indexOf(viewColumn);
		if (existingIndex >= 0) {
			recentGroups.splice(existingIndex, 1);
		}

		recentGroups.push(viewColumn);

		if (recentGroups.length > 2) {
			recentGroups.splice(0, recentGroups.length - 2);
		}
	};

	return {
		// Returns the previous group if it still exists, otherwise falls back to current active group.
		getLastActiveGroup: () => {
			const fallbackGroup = vscode.window.tabGroups.activeTabGroup.viewColumn;
			const previousGroup = recentGroups.at(-2);
			if (previousGroup === undefined) {
				return fallbackGroup;
			}

			const targetExists = vscode.window.tabGroups.all.some(
				(group) => group.viewColumn === previousGroup
			);
			return targetExists ? previousGroup : fallbackGroup;
		},
		// Snapshots the current active tab group into the MRU stack.
		recordActiveGroup: () => {
			recordGroup(vscode.window.tabGroups.activeTabGroup.viewColumn);
		},
		// Jumps to the previous group. Silently no-ops if the group was closed since last record.
		toggle: async () => {
			const targetGroup = recentGroups.at(-2);
			if (targetGroup === undefined) {
				return;
			}

			const targetExists = vscode.window.tabGroups.all.some(
				(group) => group.viewColumn === targetGroup
			);
			if (!targetExists) {
				return;
			}

			const focusCommand = FOCUS_GROUP_COMMANDS[targetGroup];
			if (!focusCommand) {
				void vscode.window.showWarningMessage(
					`Doom Code: editor group ${targetGroup} cannot be focused by doom.windowMru.`
				);
				return;
			}

			await vscode.commands.executeCommand(focusCommand);
		},
	};
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

/**
 * Wires the MRU controller to tab-group and editor-change events, registers the `doom.windowMru`
 * command, and seeds the stack with the current active group on startup.
 */
export function registerWindowMru(context: vscode.ExtensionContext): WindowMruController {
	const windowMru = createEditorGroupMruToggle();

	windowMru.recordActiveGroup();
	context.subscriptions.push(
		vscode.window.tabGroups.onDidChangeTabGroups(() => {
			windowMru.recordActiveGroup();
		}),
		vscode.window.onDidChangeActiveTextEditor(() => {
			windowMru.recordActiveGroup();
		}),
		vscode.commands.registerCommand("doom.windowMru", async () => {
			await windowMru.toggle();
		})
	);

	return windowMru;
}
