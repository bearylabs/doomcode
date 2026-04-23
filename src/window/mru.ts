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
