import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	computeWorkspaceHistoryUpdate,
	resolveWindowDeleteAction,
	selectReloadWorkspaceTarget,
	type StoredWorkspaceTarget,
} from '../extension';
import {
	detectDashboardMode,
	evaluateInstalledDefaults,
	extractCurrentReleaseNotes,
	renderMarkdownFragment,
	resolveStartupCommandsFromBindings,
} from '../onboarding/dashboard';
import { applyDefaultsToConfiguration, hasUserOwnedSettingValue, runInstallFlow } from '../onboarding/install';
import {
	DOOM_MANAGED_VIM_BINDING_SETTINGS,
	getDoomManagedVimBindingConflictKey,
	hasEquivalentDoomManagedVimBinding,
	isDoomManagedVimBindingSetting,
} from '../onboarding/vimBindings';
import {
	applyTrackedUiContextCommand,
	evaluateWhenExpression,
	selectTriggeredConditionForKey,
} from '../whichkey/menu';

suite('Extension Test Suite', () => {
	const extensionId = 'bearylabs.doom';
	const expectedRuntimeCommands = [
		'doom.cleanup',
		'doom.fuzzySearchActiveTextEditor',
		'doom.fuzzySearchWorkspace',
		'doom.install',
		'doom.reloadLastSession',
		'doom.dashboard',
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
		'doom.dashboard',
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
		assert.deepStrictEqual(packageJson.extensionDependencies, ['VSpaceCode.whichkey']);
		assert.deepStrictEqual(packageJson.extensionPack, ['bearylabs.doom-workspace', 'vscodevim.vim', 'wayou.vscode-todo-highlight', 'kahole.magit']);
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

	test('keeps Doom-managed Vim binding settings centralized', () => {
		assert.deepStrictEqual(DOOM_MANAGED_VIM_BINDING_SETTINGS, [
			'vim.normalModeKeyBindingsNonRecursive',
			'vim.visualModeKeyBindingsNonRecursive',
		]);
		assert.strictEqual(isDoomManagedVimBindingSetting('vim.normalModeKeyBindingsNonRecursive'), true);
		assert.strictEqual(isDoomManagedVimBindingSetting('vim.insertModeKeyBindingsNonRecursive'), false);
		assert.strictEqual(
			getDoomManagedVimBindingConflictKey(
				{ before: ['<C-j>'], after: ['i', '<CR>', '<Esc>', '^'] },
			),
			'<C-j>',
		);
		assert.strictEqual(
			hasEquivalentDoomManagedVimBinding(
				[{ before: ['<space>'], commands: ['doom.whichKeyShow'], silent: true }],
				{ before: ['<space>'], commands: ['doom.whichKeyShow'] },
			),
			true,
		);
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
			failures: [],
			total: 4,
		});
	});

	test('captures failed install settings with reasons', async () => {
		const config = {
			inspect<T>(_key: string) {
				return {} as { globalValue?: T };
			},
			update(key: string, _value: unknown, _target: vscode.ConfigurationTarget) {
				if (key === 'doom.fail.error') {
					return Promise.reject(new Error('Permission denied'));
				}

				if (key === 'doom.fail.string') {
					return Promise.reject('String failure');
				}

				return Promise.resolve();
			},
		};

		const result = await applyDefaultsToConfiguration(config, {
			'doom.ok': true,
			'doom.fail.error': true,
			'doom.fail.string': true,
		});

		assert.deepStrictEqual(result, {
			applied: 1,
			skipped: 0,
			unsupported: 0,
			failed: 2,
			failures: [
				{ key: 'doom.fail.error', reason: 'Permission denied' },
				{ key: 'doom.fail.string', reason: 'String failure' },
			],
			total: 3,
		});
	});

	test('merges missing Doom Vim bindings into existing user arrays', async () => {
		const updates: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
		const config = {
			inspect<T>(key: string) {
				if (key === 'vim.normalModeKeyBindingsNonRecursive') {
					return {
						globalValue: [
							{ before: ['<space>'], commands: ['doom.whichKeyShow'] },
						],
					} as { globalValue?: T };
				}

				return {} as { globalValue?: T };
			},
			update(key: string, value: unknown, target: vscode.ConfigurationTarget) {
				updates.push({ key, value, target });
				return Promise.resolve();
			},
		};

		const result = await applyDefaultsToConfiguration(config, {
			'vim.normalModeKeyBindingsNonRecursive': [
				{ before: ['<space>'], commands: ['doom.whichKeyShow'] },
				{ before: ['<C-j>'], commands: ['editor.action.insertLineAfter'] },
			],
			'window.restoreWindows': 'none',
		});

		assert.strictEqual(updates.length, 2);
		assert.strictEqual(updates[0].key, 'vim.normalModeKeyBindingsNonRecursive');
		assert.deepStrictEqual(updates[0].value, [
			{ before: ['<space>'], commands: ['doom.whichKeyShow'] },
			{ before: ['<C-j>'], commands: ['editor.action.insertLineAfter'] },
		]);
		assert.deepStrictEqual(result, {
			applied: 2,
			skipped: 0,
			unsupported: 0,
			failed: 0,
			failures: [],
			total: 2,
		});
	});

	test('does not append Doom Vim bindings when user already owns same before chord', async () => {
		const updates: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }> = [];
		const config = {
			inspect<T>(key: string) {
				if (key === 'vim.normalModeKeyBindingsNonRecursive') {
					return {
						globalValue: [
							{ before: ['<C-j>'], after: ['a', '<CR>', '<Esc>'] },
						],
					} as { globalValue?: T };
				}

				return {} as { globalValue?: T };
			},
			update(key: string, value: unknown, target: vscode.ConfigurationTarget) {
				updates.push({ key, value, target });
				return Promise.resolve();
			},
		};

		const result = await applyDefaultsToConfiguration(config, {
			'vim.normalModeKeyBindingsNonRecursive': [
				{ before: ['<C-j>'], after: ['i', '<CR>', '<Esc>', '^'] },
			],
			'window.restoreWindows': 'none',
		});

		assert.strictEqual(updates.length, 1);
		assert.deepStrictEqual(updates[0], {
			key: 'window.restoreWindows',
			value: 'none',
			target: vscode.ConfigurationTarget.Global,
		});
		assert.deepStrictEqual(result, {
			applied: 1,
			skipped: 1,
			unsupported: 0,
			failed: 0,
			failures: [],
			total: 2,
		});
	});

	test('marks Vim defaults installed when defaults are subset of user array', () => {
		const installState = evaluateInstalledDefaults(
			{
				'vim.normalModeKeyBindingsNonRecursive': [
					{ before: ['<space>'], commands: ['doom.whichKeyShow'] },
					{ before: ['<C-j>'], commands: ['editor.action.insertLineAfter'] },
				],
			},
			() => ({
				globalValue: [
					{ before: ['<space>'], commands: ['doom.whichKeyShow'] },
					{ before: ['<C-j>'], commands: ['editor.action.insertLineAfter'] },
					{ before: ['<C-k>'], commands: ['editor.action.deleteLines'] },
				],
			}),
		);

		assert.deepStrictEqual(installState, {
			matchingDefaults: 1,
			totalDefaults: 1,
			isInstalled: true,
		});
	});

	test('treats Doom Vim defaults as installed when matching bindings have extra fields', () => {
		const installState = evaluateInstalledDefaults(
			{
				'vim.normalModeKeyBindingsNonRecursive': [
					{ before: ['<space>'], commands: ['doom.whichKeyShow'] },
				],
			},
			() => ({
				globalValue: [
					{ before: ['<space>'], commands: ['doom.whichKeyShow'], silent: true },
				],
			}),
		);

		assert.deepStrictEqual(installState, {
			matchingDefaults: 1,
			totalDefaults: 1,
			isInstalled: true,
		});
	});

	test('install flow stays opt-in', async () => {
		let applied = false;

		const cancelled = await runInstallFlow(
			async () => false,
			async () => {
				applied = true;
				return { applied: 1, skipped: 0, unsupported: 0, failed: 0, failures: [], total: 1 };
			},
		);

		assert.strictEqual(cancelled, undefined);
		assert.strictEqual(applied, false);

		const confirmed = await runInstallFlow(
			async () => true,
			async () => {
				applied = true;
				return { applied: 1, skipped: 0, unsupported: 0, failed: 0, failures: [], total: 1 };
			},
		);

		assert.ok(confirmed);
		assert.strictEqual(applied, true);
	});

	test('detects welcome update and steady-state startup modes', () => {
		assert.strictEqual(detectDashboardMode(undefined, '0.2.0'), 'welcome');
		assert.strictEqual(detectDashboardMode('0.1.2', '0.2.0'), 'update');
		assert.strictEqual(detectDashboardMode('0.2.0', '0.2.0'), 'startup');
	});

	test('routes window delete by active terminal mode', () => {
		assert.strictEqual(resolveWindowDeleteAction(false, false), 'closeGroup');
		assert.strictEqual(resolveWindowDeleteAction(false, true), 'moveTerminalEditorToPanelAndCloseGroup');
		assert.strictEqual(resolveWindowDeleteAction(true, true), 'moveTerminalEditorToPanelAndCloseGroup');
		assert.strictEqual(resolveWindowDeleteAction(true, false), 'closePanel');
	});

	test('tracks sidebar context for repeated doom which-key toggles', () => {
		const initial = {
			activePanel: '',
			activeViewlet: '',
			copilotVisible: false,
			explorerViewletVisible: false,
			markersVisible: false,
			sidebarVisible: false,
		};

		const explorerOpen = applyTrackedUiContextCommand(initial, 'workbench.view.explorer');
		assert.deepStrictEqual(explorerOpen, {
			activePanel: '',
			activeViewlet: 'workbench.view.explorer',
			copilotVisible: false,
			explorerViewletVisible: true,
			markersVisible: false,
			sidebarVisible: true,
		});

		const sidebarHidden = applyTrackedUiContextCommand(
			explorerOpen,
			'workbench.action.toggleSidebarVisibility',
		);
		assert.deepStrictEqual(sidebarHidden, {
			activePanel: '',
			activeViewlet: '',
			copilotVisible: false,
			explorerViewletVisible: false,
			markersVisible: false,
			sidebarVisible: false,
		});
	});

	test('evaluates native-style which-key when expressions', () => {
		const contextValues = {
			activeEditorLastInGroup: true,
			activeViewlet: 'workbench.view.debug',
			explorerViewletVisible: true,
			multipleEditorGroups: false,
			whichkeyVisible: true,
		};

		assert.strictEqual(
			evaluateWhenExpression(contextValues, 'whichkeyVisible && explorerViewletVisible'),
			true,
		);
		assert.strictEqual(
			evaluateWhenExpression(
				contextValues,
				"whichkeyVisible && activeViewlet == 'workbench.view.debug'",
			),
			true,
		);
		assert.strictEqual(
			evaluateWhenExpression(
				contextValues,
				'whichkeyVisible && activeEditorLastInGroup && !multipleEditorGroups',
			),
			true,
		);
	});

	test('selects trigger conditions from package-style keybindings', () => {
		const triggerBindings = [
			{
				key: 'p',
				condition: 'explorerViewletVisible',
				when: 'whichkeyVisible && explorerViewletVisible',
			},
			{
				key: 'x',
				condition: 'multipleEditorGroups',
				when: 'whichkeyVisible && multipleEditorGroups',
			},
			{
				key: 'x',
				condition: 'activeEditorLastInGroup',
				when: 'whichkeyVisible && activeEditorLastInGroup && !multipleEditorGroups',
			},
		];

		assert.strictEqual(
			selectTriggeredConditionForKey(
				'p',
				{ explorerViewletVisible: true, whichkeyVisible: true },
				triggerBindings,
			),
			'explorerViewletVisible',
		);
		assert.strictEqual(
			selectTriggeredConditionForKey(
				'x',
				{
					activeEditorLastInGroup: true,
					multipleEditorGroups: false,
					whichkeyVisible: true,
				},
				triggerBindings,
			),
			'activeEditorLastInGroup',
		);
	});

	test('extracts only the current release notes from changelog markdown', () => {
		const changelog = [
			'# Changelog',
			'',
			'## [Unreleased]',
			'',
			'- future',
			'',
			'## [0.2.0] - 2026-04-22',
			'',
			'### Added',
			'',
			'- first',
			'',
			'## [0.1.2] - 2026-04-20',
			'',
			'- old',
		].join('\n');

		assert.strictEqual(
			extractCurrentReleaseNotes(changelog, '0.2.0'),
			[
				'## [0.2.0] - 2026-04-22',
				'',
				'### Added',
				'',
				'- first',
			].join('\n')
		);
	});

	test('renders simple changelog markdown to html', () => {
		const html = renderMarkdownFragment('## [0.2.0]\n\n### Added\n\n- use `doom.install`\n');

		assert.ok(html.includes('<h2>[0.2.0]</h2>'));
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
			(key) => ({
				globalValue: key === 'window.menuBarVisibility' ? 'compact' : 'all',
			}),
		);

		assert.deepStrictEqual(installState, {
			matchingDefaults: 1,
			totalDefaults: 2,
			isInstalled: false,
		});
	});

	test('counts only global user-installed defaults', () => {
		const installState = evaluateInstalledDefaults(
			{
				'vim.leader': '<space>',
				'window.menuBarVisibility': 'compact',
			},
			(key) => key === 'vim.leader'
				? { globalValue: '<space>' }
				: { workspaceValue: 'compact' } as { globalValue?: unknown; workspaceValue?: unknown },
		);

		assert.deepStrictEqual(installState, {
			matchingDefaults: 1,
			totalDefaults: 2,
			isInstalled: false,
		});
	});
});
