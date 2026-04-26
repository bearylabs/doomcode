import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Which-key binding model
// ---------------------------------------------------------------------------

export type WhichKeyBindingType = 'bindings' | 'command' | 'commands' | 'conditional';

export interface WhichKeyBinding {
	key: string;
	name: string;
	type: WhichKeyBindingType;
	command?: string;
	commands?: string[];
	args?: unknown;
	bindings?: WhichKeyBinding[];
}

// ---------------------------------------------------------------------------
// Binding validation and lookup
// ---------------------------------------------------------------------------

/** Guards against null — `typeof null === 'object'` would otherwise pass. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

/** Minimal structural check — intentionally loose so unknown extra fields pass through. */
function isWhichKeyBinding(value: unknown): value is WhichKeyBinding {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.key === 'string'
		&& typeof value.name === 'string'
		&& typeof value.type === 'string';
}

interface BindingOverride {
	keys: string;
	position?: number;
	name?: string;
	type?: WhichKeyBindingType;
	command?: string;
	commands?: string[];
	args?: unknown;
	bindings?: WhichKeyBinding[];
}

function isBindingOverride(value: unknown): value is BindingOverride {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.keys === 'string'
		&& (value.position === undefined || typeof value.position === 'number');
}

/**
 * Applies `whichkey.bindingOverrides` to a binding tree in place.
 * position -1 removes the binding; any other value inserts/moves it.
 */
function applyBindingOverrides(bindings: WhichKeyBinding[], overrides: BindingOverride[]): WhichKeyBinding[] {
	let result = bindings;

	for (const override of overrides) {
		const segments = override.keys.split('.');
		if (segments.length === 0) {
			continue;
		}

		result = applyOverrideAtPath(result, segments, override);
	}

	return result;
}

function applyOverrideAtPath(
	bindings: WhichKeyBinding[],
	segments: string[],
	override: BindingOverride,
): WhichKeyBinding[] {
	if (segments.length === 0) {
		return bindings;
	}

	const [head, ...tail] = segments;

	if (tail.length === 0) {
		// Leaf: apply the override directly to this level
		if (override.position === -1) {
			return bindings.filter((b) => b.key !== head);
		}

		// For non-removal overrides, splice in the new binding at the given position
		const without = bindings.filter((b) => b.key !== head);
		const newBinding: WhichKeyBinding = {
			key: head,
			name: override.name ?? head,
			type: override.type ?? 'command',
			...(override.command !== undefined && { command: override.command }),
			...(override.commands !== undefined && { commands: override.commands }),
			...(override.args !== undefined && { args: override.args }),
			...(override.bindings !== undefined && { bindings: override.bindings }),
		};
		const insertAt = override.position === undefined
			? without.length
			: Math.max(0, Math.min(override.position, without.length));
		return [...without.slice(0, insertAt), newBinding, ...without.slice(insertAt)];
	}

	// Intermediate: recurse into the child group matching `head`
	return bindings.map((b) => {
		if (b.key !== head || b.type !== 'bindings' || !b.bindings) {
			return b;
		}

		return {
			...b,
			bindings: applyOverrideAtPath(b.bindings, tail, override),
		};
	});
}

/** Reads `whichkey.bindings` from workspace config and filters out malformed entries. */
export function getConfiguredWhichKeyBindings(): WhichKeyBinding[] {
	const configured = vscode.workspace.getConfiguration().get<unknown>('whichkey.bindings', []);

	if (!Array.isArray(configured)) {
		return [];
	}

	const bindings = configured.filter(isWhichKeyBinding);

	const rawOverrides = vscode.workspace.getConfiguration().get<unknown>('whichkey.bindingOverrides', []);
	if (!Array.isArray(rawOverrides)) {
		return bindings;
	}

	const overrides = rawOverrides.filter(isBindingOverride);
	if (overrides.length === 0) {
		return bindings;
	}

	return applyBindingOverrides(bindings, overrides);
}

// ---------------------------------------------------------------------------
// Binding execution
// ---------------------------------------------------------------------------

/**
 * Executes a VS Code command with correct argument spreading.
 * Array args are spread as positional params; single args pass as-is; missing args omitted entirely
 * so commands that inspect `arguments.length` behave correctly.
 */
export function executeConfiguredCommand(command: string, arg?: unknown): Thenable<unknown> {
	if (Array.isArray(arg)) {
		return vscode.commands.executeCommand(command, ...arg);
	}

	if (arg !== undefined && arg !== null) {
		return vscode.commands.executeCommand(command, arg);
	}

	return vscode.commands.executeCommand(command);
}

/**
 * Runs a binding's command(s) in sequence, awaiting each before the next.
 * For `commands`, args are positionally matched by index — missing args silently become undefined.
 * `afterCommand` fires after each successful execution, useful for telemetry or menu state updates.
 */
export async function executeWhichKeyBindingCommands(
	binding: Pick<WhichKeyBinding, 'args' | 'command' | 'commands'>,
	afterCommand?: (command: string, arg: unknown) => void
): Promise<void> {
	if (binding.command) {
		await executeConfiguredCommand(binding.command, binding.args);
		afterCommand?.(binding.command, binding.args);
		return;
	}

	if (!binding.commands) {
		return;
	}

	const args = Array.isArray(binding.args) ? binding.args : [];
	for (let index = 0; index < binding.commands.length; index++) {
		const command = binding.commands[index];
		const arg = args[index];
		await executeConfiguredCommand(command, arg);
		afterCommand?.(command, arg);
	}
}
