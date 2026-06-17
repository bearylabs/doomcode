import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { STALE_COMMAND_PREFIXES } from './staleCleanup';

export function getKeybindingsPath(context: vscode.ExtensionContext): string | undefined {
	// globalStorageUri points to:
	//   <userData>/User/globalStorage/<ext-id>       (default profile)
	//   <userData>/User/profiles/<id>/globalStorage/<ext-id>  (named profile)
	// Go up 2 levels to reach the active profile's User directory.
	const profileDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));
	return path.join(profileDir, 'keybindings.json');
}

/**
 * Reads and parses a VS Code keybindings.json, tolerating single-line comments
 * and trailing commas. Returns the parsed array, or undefined if the file is
 * missing, unreadable, or malformed.
 */
export function readKeybindingsJson(keybindingsPath: string): Array<Record<string, unknown>> | undefined {
	if (!fs.existsSync(keybindingsPath)) {
		return undefined;
	}
	try {
		const raw = fs.readFileSync(keybindingsPath, 'utf-8');
		const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
		const sanitized = stripped.replace(/,\s*([}\]])/g, '$1');
		const parsed = JSON.parse(sanitized);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch (err) {
		console.warn('[Doom] readKeybindingsJson failed:', err);
		return undefined;
	}
}

/**
 * Read the user keybindings.json, filter out entries whose `command` starts
 * with a stale prefix, and write back if anything changed.
 * Returns the number of entries removed.
 */
export async function cleanStaleKeybindings(context: vscode.ExtensionContext): Promise<number> {
	const keybindingsPath = getKeybindingsPath(context);
	if (!keybindingsPath) {
		return 0;
	}

	const bindings = readKeybindingsJson(keybindingsPath);
	if (!bindings) {
		return 0;
	}

	const before = bindings.length;
	const filtered = bindings.filter((entry) => {
		const cmd = entry.command;
		if (typeof cmd !== 'string') { return true; }
		// Keep negations (e.g. "-vspacecode.space") — they disable a default.
		if (cmd.startsWith('-')) { return true; }
		return !STALE_COMMAND_PREFIXES.some((p) => cmd.startsWith(p));
	});

	const removed = before - filtered.length;
	if (removed === 0) { return 0; }

	const output = "// Place your key bindings in this file to override the defaults\n"
		+ JSON.stringify(filtered, null, '\t')
		+ '\n';

	try {
		fs.writeFileSync(keybindingsPath, output, 'utf-8');
	} catch (err) {
		console.warn("Doom Code: failed to write cleaned keybindings.json:", err);
		return 0;
	}

	return removed;
}

/**
 * Returns the magit-related keybindings from Doom's own contributes.keybindings:
 * entries scoped to the magit editor language and negation entries that disable
 * kahole.magit's default key assignments.
 */
export function getDoomUserKeybindings(context: vscode.ExtensionContext): Array<Record<string, unknown>> {
	const doomKeybindings = (context.extension.packageJSON as {
		contributes?: { keybindings?: Array<Record<string, unknown>> };
	}).contributes?.keybindings;

	if (!Array.isArray(doomKeybindings)) {
		return [];
	}

	const magitKeybindings = doomKeybindings.filter((kb) => {
		const when = kb['when'];
		return typeof when === 'string' && when.includes("editorLangId == 'magit'");
	});

	// Negation entries that disable kahole.magit's default key assignments.
	const negationKeybindings = doomKeybindings.filter((kb) => {
		const cmd = kb['command'];
		return typeof cmd === 'string' && cmd.startsWith('-magit.');
	});

	return [...magitKeybindings, ...negationKeybindings];
}

/**
 * Read the user keybindings.json, add any magit-related keybindings declared
 * in Doom's own contributes.keybindings that are not already present, and
 * write back.  User-level keybindings have higher precedence than all
 * extension keybindings, which is necessary for magit.dispatch to display the
 * correct key hints.
 * Returns the number of keybindings added.
 */
export async function installDoomKeybindings(context: vscode.ExtensionContext): Promise<number> {
	const allMagitRelated = getDoomUserKeybindings(context);

	if (allMagitRelated.length === 0) {
		return 0;
	}

	const keybindingsPath = getKeybindingsPath(context);
	if (!keybindingsPath) {
		return 0;
	}

	let existing: Array<Record<string, unknown>> = [];
	let rawContent: string | undefined;
	if (fs.existsSync(keybindingsPath)) {
		try {
			rawContent = fs.readFileSync(keybindingsPath, 'utf-8');
		} catch {
			console.warn("Doom Code: could not read keybindings.json, skipping magit install.");
			return 0;
		}
		const parsed = readKeybindingsJson(keybindingsPath);
		if (parsed === undefined) {
			console.warn("Doom Code: could not parse keybindings.json, skipping magit install.");
			return 0;
		}
		existing = parsed;
	}

	const toAdd = allMagitRelated.filter((kb) =>
		!existing.some((e) => e['key'] === kb['key'] && e['command'] === kb['command'] && e['when'] === kb['when']),
	);

	if (toAdd.length === 0) {
		return 0;
	}

	let output: string;
	const newEntries = toAdd.map((kb) => '\t' + JSON.stringify(kb)).join(',\n');
	const block = '\t// #region Doom Code keybindings\n' + newEntries + '\n\t// #endregion Doom Code keybindings';

	if (rawContent !== undefined && existing.length > 0) {
		// Append to existing file — preserve original content and comments.
		const lastBracket = rawContent.lastIndexOf(']');
		if (lastBracket !== -1) {
			const beforeBracket = rawContent.slice(0, lastBracket).trimEnd();
			const rest = rawContent.slice(lastBracket + 1);
			output = beforeBracket + ',\n' + block + '\n]' + rest;
		} else {
			// Malformed — fall back to full rewrite.
			output = "// Place your key bindings in this file to override the defaults\n"
				+ JSON.stringify([...existing, ...toAdd], null, '\t')
				+ '\n';
		}
	} else {
		// File doesn't exist or is empty — write fresh.
		output = "// Place your key bindings in this file to override the defaults\n[\n"
			+ block
			+ '\n]\n';
	}

	try {
		fs.mkdirSync(path.dirname(keybindingsPath), { recursive: true });
		fs.writeFileSync(keybindingsPath, output, 'utf-8');
	} catch (err) {
		console.warn("Doom Code: failed to write magit keybindings to keybindings.json:", err);
		return 0;
	}

	return toAdd.length;
}
