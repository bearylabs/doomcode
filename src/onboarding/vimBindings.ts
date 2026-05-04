const DOOM_VIM_BINDING_MODES = [
	'normalMode',
	'visualMode',
] as const;

const DOOM_VIM_BINDING_ARRAY_KINDS = [
	'KeyBindingsNonRecursive',
] as const;

type VimBindingEntry = {
	before?: unknown;
	commands?: unknown;
	after?: unknown;
};

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isVimBindingEntry(value: unknown): value is VimBindingEntry {
	return value !== null && typeof value === 'object';
}

function normalizeBindingSequence(value: unknown): string | undefined {
	if (!isStringArray(value)) {
		return undefined;
	}

	return value.join('\u001f');
}

/** Single source of truth for the Vim binding arrays Doom currently manages during install. */
export const DOOM_MANAGED_VIM_BINDING_SETTINGS = DOOM_VIM_BINDING_MODES.flatMap((mode) => (
	DOOM_VIM_BINDING_ARRAY_KINDS.map((kind) => `vim.${mode}${kind}`)
));

const DOOM_MANAGED_VIM_BINDING_SETTING_SET = new Set(DOOM_MANAGED_VIM_BINDING_SETTINGS);

export function isDoomManagedVimBindingSetting(key: string): boolean {
	return DOOM_MANAGED_VIM_BINDING_SETTING_SET.has(key);
}

/**
 * Uses only the `before` chord as install-time conflict key.
 * If user already owns same key sequence, Doom treats it as an override and will not append another binding.
 */
export function getDoomManagedVimBindingConflictKey(entry: unknown): string | undefined {
	if (!isVimBindingEntry(entry)) {
		return undefined;
	}

	return normalizeBindingSequence(entry.before);
}

/**
 * Compares bindings by the fields Doom needs for identity.
 * Extra Vim flags like `silent` intentionally do not affect equivalence.
 */
export function getDoomManagedVimBindingSignature(entry: unknown): string | undefined {
	if (!isVimBindingEntry(entry)) {
		return undefined;
	}

	const before = normalizeBindingSequence(entry.before);
	const commands = normalizeBindingSequence(entry.commands);
	const after = normalizeBindingSequence(entry.after);

	if (!before) {
		return undefined;
	}

	return `before:${before}|commands:${commands ?? ''}|after:${after ?? ''}`;
}

/** Returns true when any existing binding is equivalent to the candidate under Doom's identity rules. */
export function hasEquivalentDoomManagedVimBinding(bindings: readonly unknown[], candidate: unknown): boolean {
	const candidateSignature = getDoomManagedVimBindingSignature(candidate);
	if (!candidateSignature) {
		return false;
	}

	return bindings.some((binding) => getDoomManagedVimBindingSignature(binding) === candidateSignature);
}