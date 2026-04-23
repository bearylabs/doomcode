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

/** Reads `whichkey.bindings` from workspace config and filters out malformed entries. */
export function getConfiguredWhichKeyBindings(): WhichKeyBinding[] {
	const configured = vscode.workspace.getConfiguration().get<unknown>('whichkey.bindings', []);

	if (!Array.isArray(configured)) {
		return [];
	}

	return configured.filter(isWhichKeyBinding);
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
