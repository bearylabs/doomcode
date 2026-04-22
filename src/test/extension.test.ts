import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	const extensionId = 'bearylabs.doom';
	const expectedRuntimeCommands = [
		'doom.cleanup',
		'doom.fuzzySearchActiveTextEditor',
		'doom.fuzzySearchMoveDown',
		'doom.fuzzySearchMoveUp',
		'doom.fuzzySearchWorkspace',
		'doom.install',
		'doom.showOpenEditors',
		'doom.whichKeyHide',
		'doom.whichKeyShow',
		'doom.whichKeyShowBindings',
		'doom.windowMru',
	] as const;
	const expectedContributedCommands = [
		'doom.cleanup',
		'doom.fuzzySearchActiveTextEditor',
		'doom.fuzzySearchWorkspace',
		'doom.install',
		'doom.showOpenEditors',
		'doom.whichKeyShow',
		'doom.whichKeyShowBindings',
		'doom.windowMru',
	] as const;

	test('activates and registers Doom commands', async () => {
		const extension = vscode.extensions.getExtension(extensionId);
		assert.ok(extension, `Expected extension ${extensionId} to be installed`);

		await extension.activate();

		const commands = await vscode.commands.getCommands(true);
			for (const command of expectedRuntimeCommands) {
			assert.ok(commands.includes(command), `Expected command ${command} to be registered`);
		}
	});

	test('exposes expected package defaults', async () => {
		const extension = vscode.extensions.getExtension(extensionId);
		assert.ok(extension, `Expected extension ${extensionId} to be installed`);

		const packageJson = extension.packageJSON as {
			contributes?: {
				commands?: Array<{ command: string }>;
				configuration?: {
					properties?: Record<string, { default?: unknown }>;
				};
				configurationDefaults?: Record<string, unknown>;
			};
			extensionDependencies?: string[];
			extensionPack?: string[];
		};

		const contributedCommands = new Set(
			packageJson.contributes?.commands?.map((entry) => entry.command) ?? []
		);
			for (const command of expectedContributedCommands) {
			assert.ok(contributedCommands.has(command), `Expected command ${command} in package.json contributes.commands`);
		}

		assert.strictEqual(
			packageJson.contributes?.configuration?.properties?.['doom.whichKey.menuStyle']?.default,
			'doom'
		);
		assert.strictEqual(packageJson.contributes?.configurationDefaults?.['whichkey.sortOrder'], 'none');
		assert.deepStrictEqual(packageJson.extensionDependencies, ['vscodevim.vim', 'VSpaceCode.whichkey']);
		assert.deepStrictEqual(packageJson.extensionPack, ['wayou.vscode-todo-highlight']);
	});
});
