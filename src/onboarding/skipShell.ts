/** The which-key host keybinding. While a chord is open its keys must reach the workbench, not the shell. */
export const DOOM_TRIGGER_KEY_COMMAND = 'doom.triggerKey';

/**
 * VS Code merges this list with its own built-in defaults, and an entry prefixed with `-` removes a
 * command again. Doom therefore appends to it rather than owning it.
 */
export const COMMANDS_TO_SKIP_SHELL_SETTING = 'terminal.integrated.commandsToSkipShell';

const DOOM_MERGED_COMMAND_LIST_SETTING_SET = new Set([COMMANDS_TO_SKIP_SHELL_SETTING]);

/** True for command lists Doom contributes entries to instead of replacing wholesale. */
export function isDoomMergedCommandListSetting(key: string): boolean {
	return DOOM_MERGED_COMMAND_LIST_SETTING_SET.has(key);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * True when `command` is effectively part of the list: listed verbatim and not cancelled by the
 * `-command` removal form, which is how a user opts back out of something Doom added.
 */
export function listContainsCommand(value: unknown, command: string): boolean {
	if (!isStringArray(value)) {
		return false;
	}

	return value.includes(command) && !value.includes(`-${command}`);
}

/**
 * Appends the Doom entries a user's list is missing. Returns `currentValue` unchanged when they are
 * all accounted for — including entries the user disabled with the `-command` form, which install
 * must not silently undo. Returns undefined when either side is not a string list, leaving the
 * caller to fall back to its plain write path.
 */
export function mergeCommandList(currentValue: unknown, defaultValue: unknown): string[] | undefined {
	if (!isStringArray(currentValue) || !isStringArray(defaultValue)) {
		return undefined;
	}

	const missing = defaultValue.filter((entry) => (
		!currentValue.includes(entry) && !currentValue.includes(`-${entry}`)
	));

	return missing.length === 0 ? currentValue : [...currentValue, ...missing];
}
