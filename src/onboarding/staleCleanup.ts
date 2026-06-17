import * as vscode from 'vscode';
import { DOOM_STALE_VIM_BINDING_SETTINGS } from './vimBindings';

// Stale command prefixes left behind by conflicting extensions.
export const STALE_COMMAND_PREFIXES = ["vspacecode."];

/**
 * Returns true if `value` (at any depth) contains a string that starts with
 * one of the stale command prefixes.
 */
export function containsStaleCommand(value: unknown): boolean {
	if (typeof value === 'string') {
		return STALE_COMMAND_PREFIXES.some((p) => value.startsWith(p));
	}
	if (Array.isArray(value)) {
		return value.some(containsStaleCommand);
	}
	if (value !== null && typeof value === 'object') {
		return Object.values(value as Record<string, unknown>).some(containsStaleCommand);
	}
	return false;
}

/**
 * Scan vim keybinding arrays in user settings for stale commands.
 * Only removes individual stale entries, preserving all user-defined bindings.
 * Returns the list of setting keys that were cleaned.
 */
export async function cleanStaleSettings(): Promise<string[]> {
	const config = vscode.workspace.getConfiguration();
	const keysToCheck = DOOM_STALE_VIM_BINDING_SETTINGS;

	const cleaned: string[] = [];

	for (const key of keysToCheck) {
		const inspected = config.inspect(key);
		const currentValue = inspected?.globalValue;
		if (!Array.isArray(currentValue)) {
			continue;
		}

		const filtered = currentValue.filter((entry) => !containsStaleCommand(entry));
		if (filtered.length !== currentValue.length) {
			await config.update(key, filtered, vscode.ConfigurationTarget.Global);
			cleaned.push(key);
		}
	}

	return cleaned;
}

/** One-time migration: rewrites `whichkey.show` → `doom.whichKeyShow` in user vim keybindings so SPC still works after install. */
export async function migrateLegacyWhichKeyShowBindings(): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	const keysToCheck = [
		"vim.normalModeKeyBindingsNonRecursive",
		"vim.visualModeKeyBindingsNonRecursive",
	];

	for (const key of keysToCheck) {
		const inspected = config.inspect(key);
		const currentValue = inspected?.globalValue;
		if (!Array.isArray(currentValue)) {
			continue;
		}

		let changed = false;
		const migrated = currentValue.map((entry) => {
			if (
				entry !== null
				&& typeof entry === 'object'
				&& 'before' in entry
				&& 'commands' in entry
			) {
				const binding = entry as {
					before?: unknown;
					commands?: unknown;
				};

				if (
					Array.isArray(binding.before)
					&& binding.before.length === 1
					&& binding.before[0] === '<space>'
					&& Array.isArray(binding.commands)
					&& binding.commands.length === 1
					&& binding.commands[0] === 'whichkey.show'
				) {
					changed = true;
					return {
						...entry,
						commands: ['doom.whichKeyShow'],
					};
				}
			}

			return entry;
		});

		if (changed) {
			await config.update(key, migrated, vscode.ConfigurationTarget.Global);
		}
	}
}
