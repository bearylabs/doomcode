import * as vscode from 'vscode';

export interface SettingInspectLike<T = unknown> {
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;
	globalLanguageValue?: T;
	workspaceLanguageValue?: T;
	workspaceFolderLanguageValue?: T;
}

export interface ConfigurationLike {
	inspect<T>(section: string): SettingInspectLike<T> | undefined;
	update(section: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void>;
}

export interface ApplyDefaultsResult {
	applied: number;
	skipped: number;
	unsupported: number;
	failed: number;
	total: number;
}

export function hasUserOwnedSettingValue(inspected: SettingInspectLike<unknown> | undefined): boolean {
	if (!inspected) {
		return false;
	}

	return inspected.globalValue !== undefined
		|| inspected.workspaceValue !== undefined
		|| inspected.workspaceFolderValue !== undefined
		|| inspected.globalLanguageValue !== undefined
		|| inspected.workspaceLanguageValue !== undefined
		|| inspected.workspaceFolderLanguageValue !== undefined;
}

export async function applyDefaultsToConfiguration(
	config: ConfigurationLike,
	defaults: Record<string, unknown>,
	target = vscode.ConfigurationTarget.Global,
): Promise<ApplyDefaultsResult> {
	let applied = 0;
	let skipped = 0;
	let unsupported = 0;
	let failed = 0;
	const entries = Object.entries(defaults);

	for (const [key, value] of entries) {
		const inspected = config.inspect(key);

		if (!inspected) {
			unsupported++;
			continue;
		}

		if (hasUserOwnedSettingValue(inspected)) {
			skipped++;
			continue;
		}

		try {
			await config.update(key, value, target);
			applied++;
		} catch (error) {
			console.warn(`Failed to apply setting '${key}':`, error);
			failed++;
		}
	}

	return {
		applied,
		skipped,
		unsupported,
		failed,
		total: entries.length,
	};
}

export async function runInstallFlow(
	confirmInstall: () => Promise<boolean>,
	applyDefaults: () => Promise<ApplyDefaultsResult>,
): Promise<ApplyDefaultsResult | undefined> {
	if (!await confirmInstall()) {
		return undefined;
	}

	return applyDefaults();
}