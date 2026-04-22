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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

function isWhichKeyBinding(value: unknown): value is WhichKeyBinding {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.key === 'string'
		&& typeof value.name === 'string'
		&& typeof value.type === 'string';
}

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

export function executeConfiguredCommand(command: string, arg?: unknown): Thenable<unknown> {
	if (Array.isArray(arg)) {
		return vscode.commands.executeCommand(command, ...arg);
	}

	if (arg !== undefined && arg !== null) {
		return vscode.commands.executeCommand(command, arg);
	}

	return vscode.commands.executeCommand(command);
}

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
