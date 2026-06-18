import * as vscode from 'vscode';
import {
	ApplyDefaultsOptions,
	ApplyDefaultsResult,
	applyDefaultsToConfiguration,
	runInstallFlow,
	type VimBindingConflict,
	type VimBindingConflictDecision,
} from './install';
import { cleanStaleKeybindings, installDoomKeybindings } from './keybindingsFile';
import { cleanStaleSettings, migrateLegacyWhichKeyShowBindings } from './staleCleanup';

const KEEP_EXISTING_BINDING_ACTION = 'Keep Existing';
const OVERWRITE_WITH_DOOM_ACTION = 'Overwrite with Doom';
const KEEP_ALL_EXISTING_BINDINGS_ACTION = 'Keep All Existing';
const OVERWRITE_ALL_WITH_DOOM_ACTION = 'Overwrite All with Doom';

// ---------------------------------------------------------------------------
// Conflicting extensions that override the same settings Doom Code manages.
// ---------------------------------------------------------------------------
export const CONFLICTING_EXTENSIONS = [
	{
		id: "VSpaceCode.vspacecode",
		name: "VSpaceCode",
		reason: "overrides whichkey.bindings and vim keybindings with its own defaults",
	},
];

/** Returns the subset of `CONFLICTING_EXTENSIONS` that are currently installed. */
export function detectConflictingExtensions(): typeof CONFLICTING_EXTENSIONS {
	return CONFLICTING_EXTENSIONS.filter(
		(ext) => vscode.extensions.getExtension(ext.id) !== undefined
	);
}

/** Shows a modal warning for each conflicting extension with an "Open Extensions" action. */
async function warnAboutConflicts(conflicts: typeof CONFLICTING_EXTENSIONS): Promise<void> {
	for (const ext of conflicts) {
		const choice = await vscode.window.showWarningMessage(
			`Doom Code: "${ext.name}" is installed and ${ext.reason}. This will cause keybinding conflicts. Please uninstall "${ext.name}" and reload.`,
			"Open Extensions"
		);
		if (choice === "Open Extensions") {
			await vscode.commands.executeCommand("workbench.extensions.action.showInstalledExtensions");
		}
	}
}

/**
 * Writes install defaults to the user's global settings, skipping user-owned keys.
 * Optionally shows a toast summarising applied/skipped/failed counts.
 */
async function applyDefaultsToUserSettings(
	defaults: Record<string, unknown>,
	showResultMessage = false,
	options: ApplyDefaultsOptions = {},
): Promise<ApplyDefaultsResult> {
	const config = vscode.workspace.getConfiguration();
	const result = await applyDefaultsToConfiguration(config, defaults, vscode.ConfigurationTarget.Global, options);

	if (showResultMessage) {
		if (result.total === 0) {
			void vscode.window.showWarningMessage("No Doom install defaults are configured in package.json.");
			return result;
		}

		const parts: string[] = [
			`${result.applied} applied`,
			`${result.skipped} skipped (already customized by you)`,
		];
		if (result.unsupported > 0) {
			parts.push(`${result.unsupported} not recognized by VS Code`);
		}
		if (result.failed > 0) {
			parts.push(`${result.failed} failed`);
		}
		const failureDetails = result.failures.length > 0
			? ` Failures: ${result.failures.slice(0, 3).map((failure) => (
				`${failure.key} (${failure.reason})`
			)).join('; ')}${result.failures.length > 3 ? `; +${result.failures.length - 3} more` : ''}.`
			: '';
		void vscode.window.showInformationMessage(
			`Doom defaults applied to your global User settings: ${parts.join(', ')}.${failureDetails}`
		);
	}

	return result;
}

function summarizeValueForUi(value: unknown, maxLength = 180): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		serialized = String(value);
	}

	return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 1)}…`;
}

function formatVimBindingChord(before: readonly string[]): string {
	return before.join(' ');
}

function createVimBindingConflictResolver(): ApplyDefaultsOptions['resolveVimBindingConflict'] {
	let rememberedDecision: VimBindingConflictDecision | undefined;

	return async (conflict: VimBindingConflict) => {
		if (rememberedDecision) {
			return rememberedDecision;
		}

		const choice = await vscode.window.showWarningMessage(
			`Doom Code: ${conflict.settingKey} already contains a binding for ${formatVimBindingChord(conflict.before)}.`,
			{
				modal: true,
				detail: [
					`Existing: ${conflict.existingEntries.map((entry) => summarizeValueForUi(entry)).join(' | ')}`,
					`Doom: ${summarizeValueForUi(conflict.defaultEntry)}`,
					'Keep existing preserves your current mapping. Overwrite replaces all conflicting bindings for this chord with Doom\'s default.',
				].join('\n'),
			},
			KEEP_EXISTING_BINDING_ACTION,
			OVERWRITE_WITH_DOOM_ACTION,
			KEEP_ALL_EXISTING_BINDINGS_ACTION,
			OVERWRITE_ALL_WITH_DOOM_ACTION,
		);

		if (choice === OVERWRITE_ALL_WITH_DOOM_ACTION) {
			rememberedDecision = 'overwrite';
			return 'overwrite';
		}

		if (choice === KEEP_ALL_EXISTING_BINDINGS_ACTION) {
			rememberedDecision = 'keep';
			return 'keep';
		}

		if (choice === OVERWRITE_WITH_DOOM_ACTION) {
			return 'overwrite';
		}

		return 'keep';
	};
}

/** Runs both setting and keybinding cleanup, then shows a summary toast with a "Reload" action. */
async function runCleanup(context: vscode.ExtensionContext): Promise<void> {
	const cleanedSettings = await cleanStaleSettings();
	const removedKeybindings = await cleanStaleKeybindings(context);

	const conflicts = detectConflictingExtensions();

	const parts: string[] = [];
	if (cleanedSettings.length > 0) {
		parts.push(`cleaned ${cleanedSettings.length} setting(s)`);
	}
	if (removedKeybindings > 0) {
		parts.push(`removed ${removedKeybindings} stale keybinding(s)`);
	}
	if (conflicts.length > 0) {
		parts.push(`${conflicts.length} conflicting extension(s) detected`);
	}

	if (parts.length > 0) {
		void vscode.window.showInformationMessage(
			`Doom Code cleanup: ${parts.join(', ')}. Please reload the window.`,
			"Reload"
		).then((choice: string | undefined) => {
			if (choice === "Reload") {
				void vscode.commands.executeCommand("workbench.action.reloadWindow");
			}
		});
	} else {
		void vscode.window.showInformationMessage("Doom Code: no stale settings or conflicts found.");
	}
}

export interface OnboardingCommandDeps {
	/** The `doomInstallDefaults` map applied by `doom.install`. */
	installDefaults: Record<string, unknown>;
	/** Debounced dashboard re-render, invoked after install/cleanup mutate state. */
	scheduleDashboardRefresh: (delayMs?: number) => void;
	/** Opens the start page in `startup` mode (the `doom.dashboard` target). */
	showStartupDashboard: () => Promise<void>;
}

/** Registers the onboarding commands: `doom.install`, `doom.cleanup`, and `doom.dashboard`. */
export function register(context: vscode.ExtensionContext, deps: OnboardingCommandDeps): void {
	const { installDefaults, scheduleDashboardRefresh, showStartupDashboard } = deps;

	// Manual install command
	const installCmd = vscode.commands.registerCommand(
		"doom.install",
		async () => {
			const result = await runInstallFlow(
				async () => {
					const choice = await vscode.window.showWarningMessage(
						"Apply Doom default settings and keybindings to your User settings? Existing user-owned values stay untouched unless you choose to overwrite a conflicting Doom Vim binding.",
						{ modal: true },
						"Apply"
					);
					return choice === "Apply";
				},
				async () => {
					await migrateLegacyWhichKeyShowBindings();
					const settingsResult = await applyDefaultsToUserSettings(installDefaults, true, {
						resolveVimBindingConflict: createVimBindingConflictResolver(),
					});
					const addedKeybindings = await installDoomKeybindings(context);
					if (addedKeybindings > 0) {
						void vscode.window.showInformationMessage(
							`Doom Code: installed ${addedKeybindings} magit keybinding(s) into keybindings.json so the magit dispatch recognises them.`
						);
					}
					return settingsResult;
				},
			);

			if (!result) {
				return;
			}

			scheduleDashboardRefresh(0);
		}
	);

	// Manual cleanup command
	const cleanupCmd = vscode.commands.registerCommand(
		"doom.cleanup",
		async () => {
			const choice = await vscode.window.showWarningMessage(
				"This will remove stale settings and keybindings left behind by conflicting extensions (e.g. vspacecode.* commands) from your User settings.json and keybindings.json. Note: keybindings.json will be rewritten — all comments and custom formatting will be lost. This cannot be undone.",
				{ modal: true },
				"Clean Up"
			);
			if (choice !== "Clean Up") {
				return;
			}
			const conflicts = detectConflictingExtensions();
			if (conflicts.length > 0) {
				await warnAboutConflicts(conflicts);
			}
			await runCleanup(context);
			scheduleDashboardRefresh(0);
		}
	);

	const showDashboardCmd = vscode.commands.registerCommand(
		"doom.dashboard",
		async () => {
			await showStartupDashboard();
		}
	);

	context.subscriptions.push(installCmd, cleanupCmd, showDashboardCmd);
}
