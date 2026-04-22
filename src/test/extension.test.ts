import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    computeWorkspaceHistoryUpdate,
    selectReloadWorkspaceTarget,
    type StoredWorkspaceTarget,
} from '../extension';
import { applyDefaultsToConfiguration, hasUserOwnedSettingValue, runInstallFlow } from '../onboarding/install';
import {
    detectStartPageMode,
    evaluateInstalledDefaults,
    extractCurrentReleaseNotes,
    renderMarkdownFragment,
    resolveStartupCommandsFromBindings,
} from '../onboarding/startPage';

suite('Extension Test Suite', () => {
	const extensionId = 'bearylabs.doom';
	const expectedRuntimeCommands = [
		'doom.cleanup',
		'doom.fuzzySearchActiveTextEditor',
		'doom.fuzzySearchMoveDown',
		'doom.fuzzySearchMoveUp',
		'doom.fuzzySearchWorkspace',
		'doom.install',
		'doom.reloadLastSession',
		'doom.showStartPage',
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
		'doom.reloadLastSession',
		'doom.showStartPage',
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

	test('treats every user-owned scope as existing user config', () => {
		assert.strictEqual(hasUserOwnedSettingValue(undefined), false);
		assert.strictEqual(hasUserOwnedSettingValue({ globalValue: '<space>' }), true);
		assert.strictEqual(hasUserOwnedSettingValue({ workspaceValue: 1 }), true);
		assert.strictEqual(hasUserOwnedSettingValue({ workspaceFolderValue: true }), true);
		assert.strictEqual(hasUserOwnedSettingValue({ globalLanguageValue: ['x'] }), true);
		assert.strictEqual(hasUserOwnedSettingValue({ workspaceLanguageValue: ['x'] }), true);
		assert.strictEqual(hasUserOwnedSettingValue({ workspaceFolderLanguageValue: ['x'] }), true);
	});

	test('only applies defaults when no user-owned scope exists', async () => {
		const updates: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
		const config = {
			inspect<T>(key: string) {
				if (key === 'doom.apply') {
					return {} as { globalValue?: T };
				}

				if (key === 'doom.keepWorkspace') {
					return { workspaceValue: true as T };
				}

				if (key === 'doom.keepLanguage') {
					return { globalLanguageValue: ['keep'] as T };
				}

				return undefined;
			},
			update(key: string, value: unknown, target: vscode.ConfigurationTarget) {
				updates.push({ key, value, target });
				return Promise.resolve();
			},
		};

		const result = await applyDefaultsToConfiguration(config, {
			'doom.apply': 'yes',
			'doom.keepWorkspace': 'no',
			'doom.keepLanguage': 'no',
			'doom.unsupported': 'skip',
		});

		assert.deepStrictEqual(updates, [
			{ key: 'doom.apply', value: 'yes', target: vscode.ConfigurationTarget.Global },
		]);
		assert.deepStrictEqual(result, {
			applied: 1,
			skipped: 2,
			unsupported: 1,
			failed: 0,
			total: 4,
		});
	});

	test('install flow stays opt-in', async () => {
		let applied = false;

		const cancelled = await runInstallFlow(
			async () => false,
			async () => {
				applied = true;
				return { applied: 1, skipped: 0, unsupported: 0, failed: 0, total: 1 };
			},
		);

		assert.strictEqual(cancelled, undefined);
		assert.strictEqual(applied, false);

		const confirmed = await runInstallFlow(
			async () => true,
			async () => {
				applied = true;
				return { applied: 1, skipped: 0, unsupported: 0, failed: 0, total: 1 };
			},
		);

		assert.ok(confirmed);
		assert.strictEqual(applied, true);
	});

	test('detects welcome update and steady-state startup modes', () => {
		assert.strictEqual(detectStartPageMode(undefined, '0.1.2'), 'welcome');
		assert.strictEqual(detectStartPageMode('0.1.1', '0.1.2'), 'update');
		assert.strictEqual(detectStartPageMode('0.1.2', '0.1.2'), 'startup');
	});

	test('extracts only the current release notes from changelog markdown', () => {
		const changelog = [
			'# Changelog',
			'',
			'## [Unreleased]',
			'',
			'- future',
			'',
			'## [0.1.2] - 2026-04-20',
			'',
			'### Added',
			'',
			'- first',
			'',
			'## [0.1.1] - 2026-04-19',
			'',
			'- old',
		].join('\n');

		assert.strictEqual(
			extractCurrentReleaseNotes(changelog, '0.1.2'),
			[
				'## [0.1.2] - 2026-04-20',
				'',
				'### Added',
				'',
				'- first',
			].join('\n')
		);
	});

	test('renders simple changelog markdown to html', () => {
		const html = renderMarkdownFragment('## [0.1.2]\n\n### Added\n\n- use `doom.install`\n');

		assert.ok(html.includes('<h2>[0.1.2]</h2>'));
		assert.ok(html.includes('<h3>Added</h3>'));
		assert.ok(html.includes('<li>use <code>doom.install</code></li>'));
	});

	test('keeps only original doom startup commands present in bindings', () => {
		const commands = resolveStartupCommandsFromBindings([
			{
				key: 'f',
				type: 'bindings',
				bindings: [
					{
						key: 'r',
						name: 'Recently opened files',
						type: 'command',
						command: 'workbench.action.openRecent',
					},
				],
			},
			{
				key: 'p',
				type: 'bindings',
				bindings: [
					{
						key: 'p',
						name: 'Open project',
						type: 'command',
						command: 'workbench.action.openRecent',
					},
				],
			},
			{
				key: 'q',
				type: 'bindings',
				bindings: [
					{
						key: 'l',
						name: 'Reload last session',
						type: 'command',
						command: 'doom.reloadLastSession',
					},
				],
			},
			{
				key: 'h',
				type: 'bindings',
				bindings: [
					{
						key: 'b',
						type: 'command',
						command: 'doom.whichKeyShowBindings',
					},
				],
			},
		], [
			['f', 'r'],
			['p', 'p'],
			['q', 'l'],
			['h', 'd', 'h'],
		]);

		assert.deepStrictEqual(commands, [
			{
				label: 'Recently opened files',
				keybinding: 'SPC f r',
				command: 'workbench.action.openRecent',
			},
			{
				label: 'Open project',
				keybinding: 'SPC p p',
				command: 'workbench.action.openRecent',
			},
			{
				label: 'Reload last session',
				keybinding: 'SPC q l',
				command: 'doom.reloadLastSession',
			},
		]);
	});

	test('tracks previous workspace and picks reload target', () => {
		const alpha: StoredWorkspaceTarget = { label: 'alpha', uri: 'file:///alpha' };
		const beta: StoredWorkspaceTarget = { label: 'beta', uri: 'file:///beta' };

		assert.deepStrictEqual(
			computeWorkspaceHistoryUpdate(beta, alpha, undefined),
			{
				changed: true,
				last: beta,
				previous: alpha,
			}
		);

		assert.strictEqual(selectReloadWorkspaceTarget(beta, beta, alpha), alpha);
		assert.strictEqual(selectReloadWorkspaceTarget(undefined, beta, alpha), beta);
		assert.strictEqual(selectReloadWorkspaceTarget(alpha, alpha, undefined), undefined);
	});

	test('reports whether install defaults already match effective settings', () => {
		const installState = evaluateInstalledDefaults(
			{
				'window.menuBarVisibility': 'compact',
				'window.restoreWindows': 'none',
			},
			(key) => key === 'window.menuBarVisibility' ? 'compact' : 'all',
		);

		assert.deepStrictEqual(installState, {
			matchingDefaults: 1,
			totalDefaults: 2,
			isInstalled: false,
		});
	});
});
