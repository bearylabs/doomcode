import * as vscode from 'vscode';
import {
    executeWhichKeyBindingCommands,
    getConfiguredWhichKeyBindings,
    type WhichKeyBinding,
} from './bindings';

// ---------------------------------------------------------------------------
// Flattened binding model
// ---------------------------------------------------------------------------

export interface WhichKeyExecutableBinding {
	binding: Pick<WhichKeyBinding, 'args' | 'command' | 'commands'>;
	detail: string;
	name: string;
	path: string;
	searchText: string;
}

// ---------------------------------------------------------------------------
// Flattening helpers
// ---------------------------------------------------------------------------

/** Normalizes a conditional binding key into a human-readable "when <expr>" label. Empty key = 'default'. */
function formatConditionalLabel(rawKey: string): string {
	const trimmed = rawKey.trim();
	if (trimmed.length === 0) {
		return 'default';
	}

	return trimmed.startsWith('when:')
		? `when ${trimmed.slice('when:'.length)}`
		: `when ${trimmed}`;
}

/**
 * Recursively flattens a nested binding tree into a searchable list of executable bindings.
 *
 * Conditional bindings are expanded into one entry per branch so every reachable
 * command is independently addressable. The `path` accumulates pressed keys
 * (e.g. "SPC g s"), `groups` carries ancestor names for the detail breadcrumb,
 * and `condition` surfaces the active when-clause for conditional branches.
 */
function flattenWhichKeyBindings(
	bindings: WhichKeyBinding[],
	path = 'SPC',
	groups: string[] = [],
	condition?: string
): WhichKeyExecutableBinding[] {
	const flattened: WhichKeyExecutableBinding[] = [];

	for (const binding of bindings) {
		const nextPath = `${path} ${binding.key}`.trim();

		if (binding.type === 'bindings') {
			const nextGroups = [...groups, binding.name];
			flattened.push(...flattenWhichKeyBindings(binding.bindings ?? [], nextPath, nextGroups, condition));
			continue;
		}

		if (binding.type === 'command' || binding.type === 'commands') {
			const commandDetail = binding.type === 'command'
				? binding.command
				: binding.commands?.join(' -> ');
			const detailParts = [...groups];
			if (condition) {
				detailParts.push(condition);
			}
			if (commandDetail) {
				detailParts.push(commandDetail);
			}

			flattened.push({
				binding: {
					args: binding.args,
					commands: binding.commands,
					command: binding.command,
				},
				detail: detailParts.join(' — '),
				name: binding.name,
				path: nextPath,
				searchText: `${nextPath} ${binding.name} ${detailParts.join(' ')}`.toLowerCase(),
			});
			continue;
		}

		if (binding.type !== 'conditional') {
			continue;
		}

		for (const option of binding.bindings ?? []) {
			const resolvedName = option.name === 'default' ? binding.name : option.name;
			const nextCondition = formatConditionalLabel(option.key);

			if (option.type === 'bindings') {
				flattened.push(
					...flattenWhichKeyBindings(
						option.bindings ?? [],
						nextPath,
						[...groups, resolvedName],
						nextCondition
					)
				);
				continue;
			}

			if (option.type !== 'command' && option.type !== 'commands') {
				continue;
			}

			const commandDetail = option.type === 'command'
				? option.command
				: option.commands?.join(' -> ');
			const detailParts = [...groups, nextCondition];
			if (commandDetail) {
				detailParts.push(commandDetail);
			}

			flattened.push({
				binding: {
					args: option.args,
					commands: option.commands,
					command: option.command,
				},
				detail: detailParts.join(' — '),
				name: resolvedName,
				path: nextPath,
				searchText: `${nextPath} ${resolvedName} ${detailParts.join(' ')}`.toLowerCase(),
			});
		}
	}

	return flattened;
}

// ---------------------------------------------------------------------------
// Binding pickers
// ---------------------------------------------------------------------------

/** Entry point: reads live config and returns the fully-flattened binding list. */
export function getFlattenedWhichKeyBindings(): WhichKeyExecutableBinding[] {
	return flattenWhichKeyBindings(getConfiguredWhichKeyBindings());
	}

/**
 * Opens a fuzzy-searchable QuickPick over all configured which-key bindings.
 * Matches on key path, binding name, and command detail simultaneously.
 * Executes the chosen binding — no-op on dismiss.
 */
export async function showWhichKeyBindingsQuickPick(): Promise<void> {
	const flattenedBindings = getFlattenedWhichKeyBindings();

	if (flattenedBindings.length === 0) {
		void vscode.window.showInformationMessage('No which-key bindings configured.');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		flattenedBindings.map((binding) => ({
			label: binding.path,
			description: binding.name,
			detail: binding.detail,
			binding,
		})),
		{
			matchOnDescription: true,
			matchOnDetail: true,
			placeHolder: 'Search which-key bindings by key, name, or command',
			title: 'Which-Key Bindings',
		}
	);

	if (!picked) {
		return;
	}

	await executeWhichKeyBindingCommands(picked.binding.binding);
}
