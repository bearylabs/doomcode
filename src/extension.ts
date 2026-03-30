// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

function getInstallDefaults(context: vscode.ExtensionContext): Record<string, unknown> {
	const packageJson = context.extension.packageJSON as {
		doomInstallDefaults?: Record<string, unknown>;
	};

	return packageJson.doomInstallDefaults ?? {};
}

async function applyDefaultsToUserSettings(
	defaults: Record<string, unknown>,
	showResultMessage = false
): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	const target = vscode.ConfigurationTarget.Global;

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

		const alreadySetByUser = inspected?.globalValue !== undefined;

		if (alreadySetByUser) {
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

	if (showResultMessage) {
		if (entries.length === 0) {
			void vscode.window.showWarningMessage("No Doom install defaults are configured in package.json.");
			return;
		}

		void vscode.window.showInformationMessage(
			`Doom defaults: applied ${applied}, skipped ${skipped} (already set), unsupported ${unsupported}, failed ${failed}.`
		);
	}
}



// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "Doom Code" is now active!');
	const installDefaults = getInstallDefaults(context);
	const defaultsAppliedKey = "doom.defaultsAppliedOnce";

	if (!context.globalState.get<boolean>(defaultsAppliedKey)) {
		void applyDefaultsToUserSettings(installDefaults, false)
			.then(async () => {
				await context.globalState.update(defaultsAppliedKey, true);
			})
			.catch((error) => {
				console.warn("Failed to apply Doom defaults on first activation:", error);
			});
	}

	const disposable = vscode.commands.registerCommand(
		"doom.install",
		async () => {
			const choice = await vscode.window.showWarningMessage(
				"Apply Doom default settings to your User settings?",
				{ modal: true },
				"Apply"
			);
			if (choice !== "Apply") return;

			await applyDefaultsToUserSettings(installDefaults, true);
		}
	);
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }
