import * as vscode from 'vscode';
import {
	getDoomManagedVimBindingConflictKey,
	isDoomManagedVimBindingSetting,
} from './vimBindings';

export interface SettingInspectLike<T = unknown> {
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;
	globalLanguageValue?: T;
	workspaceLanguageValue?: T;
	workspaceFolderLanguageValue?: T;
}

export interface ConfigurationLike {
	inspect<T>(section: string): SettingInspectLike<T> | undefined;
	update(section: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void>;
}

export interface ApplyDefaultsFailure {
	key: string;
	reason: string;
}

export interface ApplyDefaultsResult {
	applied: number;
	skipped: number;
	unsupported: number;
	failed: number;
	failures: ApplyDefaultsFailure[];
	total: number;
}

/** Merges only missing Doom-managed Vim bindings, preserving all existing user entries verbatim. */
function mergeVimBindings(currentValue: unknown, defaultValue: unknown): unknown[] | undefined {
	if (!Array.isArray(currentValue) || !Array.isArray(defaultValue)) {
		return undefined;
	}

	const existingConflictKeys = new Set(
		currentValue
			.map((entry) => getDoomManagedVimBindingConflictKey(entry))
			.filter((conflictKey): conflictKey is string => conflictKey !== undefined)
	);

	let changed = false;
	const merged = [...currentValue];
	for (const defaultEntry of defaultValue) {
		const conflictKey = getDoomManagedVimBindingConflictKey(defaultEntry);
		if (!conflictKey || existingConflictKeys.has(conflictKey)) {
			continue;
		}

		existingConflictKeys.add(conflictKey);
		merged.push(defaultEntry);
		changed = true;
	}

	return changed ? merged : currentValue;
}

/** Extracts a human-readable reason from a caught error, falling back to 'Unknown error'. */
function getErrorReason(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	if (typeof error === 'string' && error.trim().length > 0) {
		return error;
	}

	return 'Unknown error';
}

/** Returns true if the user has set this key at any scope — used to skip overwriting intentional user config. */
export function hasUserOwnedSettingValue(inspected: SettingInspectLike<unknown> | undefined): boolean {
	if (!inspected) {
		return false;
	}

	return inspected.globalValue !== undefined
		|| inspected.workspaceValue !== undefined
		|| inspected.workspaceFolderValue !== undefined
		|| inspected.globalLanguageValue !== undefined
		|| inspected.workspaceLanguageValue !== undefined
		|| inspected.workspaceFolderLanguageValue !== undefined;
}

/**
 * Writes each default setting to `config` at `target`, skipping keys the user already owns
 * and marking keys not recognised by VS Code as unsupported. Per-key errors are collected
 * rather than thrown so one bad setting can't abort the whole install.
 */
export async function applyDefaultsToConfiguration(
	config: ConfigurationLike,
	defaults: Record<string, unknown>,
	target = vscode.ConfigurationTarget.Global,
): Promise<ApplyDefaultsResult> {
	let applied = 0;
	let skipped = 0;
	let unsupported = 0;
	const failures: ApplyDefaultsFailure[] = [];
	const entries = Object.entries(defaults);

	for (const [key, value] of entries) {
		const inspected = config.inspect(key);

		if (!inspected) {
			unsupported++;
			continue;
		}

		if (isDoomManagedVimBindingSetting(key)) {
			// Managed Vim binding arrays are merged so new defaults can land without clobbering user customizations.
			const merged = mergeVimBindings(inspected.globalValue, value);
			if (merged !== undefined) {
				if (merged === inspected.globalValue) {
					skipped++;
					continue;
				}

				try {
					await config.update(key, merged, target);
					applied++;
				} catch (error) {
					console.warn(`Failed to apply setting '${key}':`, error);
					failures.push({
						key,
						reason: getErrorReason(error),
					});
				}
				continue;
			}
		}

		if (hasUserOwnedSettingValue(inspected)) {
			skipped++;
			continue;
		}

		try {
			await config.update(key, value, target);
			applied++;
		} catch (error) {
			console.warn(`Failed to apply setting '${key}':`, error);
			failures.push({
				key,
				reason: getErrorReason(error),
			});
		}
	}

	return {
		applied,
		skipped,
		unsupported,
		failed: failures.length,
		failures,
		total: entries.length,
	};
}

/**
 * Orchestrates the install UX: confirms with the user first, then delegates to `applyDefaults`.
 * Returns undefined if the user cancels, otherwise returns the apply result.
 * Kept side-effect-free at this level so callers can inject the confirm/apply behaviour for testing.
 */
export async function runInstallFlow(
	confirmInstall: () => Promise<boolean>,
	applyDefaults: () => Promise<ApplyDefaultsResult>,
): Promise<ApplyDefaultsResult | undefined> {
	if (!await confirmInstall()) {
		return undefined;
	}

	return applyDefaults();
}
