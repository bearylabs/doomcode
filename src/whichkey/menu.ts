import * as vscode from 'vscode';
import {
	executeWhichKeyBindingCommands,
	getConfiguredWhichKeyBindings,
	type WhichKeyBinding,
} from './bindings';

// ---------------------------------------------------------------------------
// Which-key menu models
// ---------------------------------------------------------------------------

interface ContextSnapshot {
	activeEditorLastInGroup: boolean;
	activePanel: string;
	activeViewlet: string;
	bigModeEnabled: boolean;
	copilotVisible: boolean;
	editorHasSelection: boolean;
	explorerViewletVisible: boolean;
	markersVisible: boolean;
	multipleEditorGroups: boolean;
	terminalFocus: boolean;
}

interface TrackedUiContext {
	activePanel: string;
	activeViewlet: string;
	copilotVisible: boolean;
	explorerViewletVisible: boolean;
	markersVisible: boolean;
	sidebarVisible: boolean;
}

interface ShowContext {
	terminalFocus: boolean;
	terminalPanelOpen: boolean;
	explorerVisible: boolean;
}

interface RenderItem {
	isGroup: boolean;
	key: string;
	name: string;
}

interface ViewState {
	footerLabel: string;
	footerPath: string;
	items: RenderItem[];
}

interface WebviewMessage {
	index?: number;
	type: 'activate' | 'back' | 'close' | 'ready';
}

interface WhichKeyTriggerBinding {
	condition?: string;
	key: string;
	when: string;
}

/** Zero-value factory used as the baseline before any command executes. */
function createTrackedUiContext(): TrackedUiContext {
	return {
		activePanel: '',
		activeViewlet: '',
		copilotVisible: false,
		explorerViewletVisible: false,
		markersVisible: false,
		sidebarVisible: false,
	};
}

/**
 * Mirrors UI state changes inferred from executed commands.
 * VS Code has no panel-focus observation API, so we reconstruct state from side effects.
 */
export function applyTrackedUiContextCommand(
	context: TrackedUiContext,
	command: string,
	arg?: unknown
): TrackedUiContext {
	const next = { ...context };

	if (command === 'setContext' && Array.isArray(arg) && arg.length >= 2) {
		const [key, value] = arg;
		if (key === 'doom.bigModeEnabled') {
			return next;
		}

		if (key === 'view.workbench.panel.chat.view.copilot.visible' && typeof value === 'boolean') {
			next.copilotVisible = value;
		}

		if (key === 'view.workbench.panel.markers.view.visible' && typeof value === 'boolean') {
			next.markersVisible = value;
		}

		return next;
	}

	switch (command) {
	case 'workbench.view.explorer':
		next.activeViewlet = 'workbench.view.explorer';
		next.explorerViewletVisible = true;
		next.sidebarVisible = true;
		return next;
	case 'workbench.view.debug':
		next.activeViewlet = 'workbench.view.debug';
		next.explorerViewletVisible = false;
		next.sidebarVisible = true;
		return next;
	case 'workbench.action.toggleSidebarVisibility':
		if (next.sidebarVisible) {
			next.activeViewlet = '';
			next.explorerViewletVisible = false;
			next.sidebarVisible = false;
			return next;
		}

		next.sidebarVisible = true;
		if (next.activeViewlet === 'workbench.view.explorer') {
			next.explorerViewletVisible = true;
		}
		return next;
	case 'workbench.action.terminal.focus':
		next.activePanel = 'terminal';
		return next;
	case 'workbench.action.togglePanel':
		next.activePanel = next.activePanel.length > 0 ? '' : 'terminal';
		return next;
	case 'workbench.action.closePanel':
		next.activePanel = '';
		return next;
	case 'workbench.action.closeAuxiliaryBar':
		next.copilotVisible = false;
		return next;
	default:
		return next;
	}
}

/** Narrows `unknown` to an object for safe property access on untyped packageJSON entries. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

/** Maps literal chars to symbolic names matching the webview keydown handler. */
function normalizeBindingKey(value: string): string {
	if (value === '\t') {
		return 'TAB';
	}

	if (value === ' ') {
		return 'SPC';
	}

	return value;
}

/** Strips the optional `when:` prefix present in some binding condition formats. */
function normalizeCondition(rawCondition: string): string {
	const condition = rawCondition.trim();
	return condition.startsWith('when:')
		? condition.slice('when:'.length).trim()
		: condition;
}

/**
 * Builds the evaluation environment for when-expressions.
 * `whichkeyVisible` is hardcoded true because this only runs while the menu is open.
 */
function getContextValues(state: DoomWhichKeyMenu): Record<string, boolean | string> {
	const snapshot = state.snapshot;
	return {
		activeEditorLastInGroup: snapshot.activeEditorLastInGroup,
		activePanel: snapshot.activePanel,
		activeViewlet: snapshot.activeViewlet,
		'doom.bigModeEnabled': snapshot.bigModeEnabled,
		editorHasSelection: snapshot.editorHasSelection,
		explorerViewletVisible: snapshot.explorerViewletVisible,
		multipleEditorGroups: snapshot.multipleEditorGroups,
		terminalFocus: snapshot.terminalFocus,
		'view.workbench.panel.chat.view.copilot.visible': snapshot.copilotVisible,
		'view.workbench.panel.markers.view.visible': snapshot.markersVisible,
		whichkeyVisible: true,
	};
}

/**
 * Returns `undefined` (not `[]`) on unrecoverable syntax errors.
 * Callers treat undefined as "hide the binding" rather than "show with empty condition".
 */
function tokenizeWhenExpression(expression: string): string[] | undefined {
	const tokens: string[] = [];
	let index = 0;

	while (index < expression.length) {
		const char = expression[index];
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}

		const twoChars = expression.slice(index, index + 2);
		if (twoChars === '&&' || twoChars === '||' || twoChars === '==' || twoChars === '!=') {
			tokens.push(twoChars);
			index += 2;
			continue;
		}

		if (char === '!' || char === '(' || char === ')') {
			tokens.push(char);
			index += 1;
			continue;
		}

		if (char === '\'') {
			let endIndex = index + 1;
			while (endIndex < expression.length && expression[endIndex] !== '\'') {
				endIndex += 1;
			}

			if (endIndex >= expression.length) {
				return undefined;
			}

			tokens.push(expression.slice(index, endIndex + 1));
			index = endIndex + 1;
			continue;
		}

		const identifierMatch = expression.slice(index).match(/^[A-Za-z0-9._]+/);
		if (!identifierMatch) {
			return undefined;
		}

		tokens.push(identifierMatch[0]);
		index += identifierMatch[0].length;
	}

	return tokens;
}

class WhenExpressionParser {
	private index = 0;

	constructor(
		private readonly contextValues: Record<string, boolean | string>,
		private readonly tokens: string[],
	) {}

	/** Remaining tokens after a successful sub-parse signals a malformed expression; return false rather than silently accept. */
	parse(): boolean {
		const value = this.parseOr();
		return value !== undefined && this.index === this.tokens.length ? value : false;
	}

	/** Returns `undefined` to propagate parse errors up the call stack without throwing. */
	private parseOr(): boolean | undefined {
		let value = this.parseAnd();
		while (this.peek() === '||') {
			this.index += 1;
			const right = this.parseAnd();
			if (value === undefined || right === undefined) {
				return undefined;
			}

			value = value || right;
		}

		return value;
	}

	/** Returns `undefined` to propagate parse errors up the call stack without throwing. */
	private parseAnd(): boolean | undefined {
		let value = this.parseUnary();
		while (this.peek() === '&&') {
			this.index += 1;
			const right = this.parseUnary();
			if (value === undefined || right === undefined) {
				return undefined;
			}

			value = value && right;
		}

		return value;
	}

	/** Handles `!` negation and `(...)` grouping before delegating to comparison. */
	private parseUnary(): boolean | undefined {
		if (this.peek() === '!') {
			this.index += 1;
			const value = this.parseUnary();
			return value === undefined ? undefined : !value;
		}

		if (this.peek() === '(') {
			this.index += 1;
			const value = this.parseOr();
			if (this.peek() !== ')') {
				return undefined;
			}

			this.index += 1;
			return value;
		}

		return this.parseComparison();
	}

	/** Bare identifier without `==`/`!=` operator is a truthy check against context values. */
	private parseComparison(): boolean | undefined {
		const leftToken = this.consumeIdentifier();
		if (!leftToken) {
			return undefined;
		}

		const operator = this.peek();
		if (operator === '==' || operator === '!=') {
			this.index += 1;
			const rightToken = this.consumeValue();
			if (rightToken === undefined) {
				return undefined;
			}

			const leftValue = this.contextValues[leftToken];
			const rightValue = rightToken.startsWith('\'')
				? rightToken.slice(1, -1)
				: this.contextValues[rightToken] ?? rightToken;
			return operator === '=='
				? leftValue === rightValue
				: leftValue !== rightValue;
		}

		return Boolean(this.contextValues[leftToken]);
	}

	/** Rejects operators and string literals as identifier starts. */
	private consumeIdentifier(): string | undefined {
		const token = this.peek();
		if (!token || token.startsWith('\'') || ['&&', '||', '==', '!=', '!', '(', ')'].includes(token)) {
			return undefined;
		}

		this.index += 1;
		return token;
	}

	/** Accepts both identifiers and quoted string literals as comparison RHS. */
	private consumeValue(): string | undefined {
		const token = this.peek();
		if (!token || ['&&', '||', '==', '!=', '!', '(', ')'].includes(token)) {
			return undefined;
		}

		this.index += 1;
		return token;
	}

	/** Non-consuming lookahead at the current token. */
	private peek(): string | undefined {
		return this.tokens[this.index];
	}
}

/** Empty expression is always true (binding visible); undefined tokens from tokenizer means hide binding. */
export function evaluateWhenExpression(
	contextValues: Record<string, boolean | string>,
	expression: string,
): boolean {
	const trimmed = expression.trim();
	if (trimmed.length === 0) {
		return true;
	}

	const tokens = tokenizeWhenExpression(trimmed);
	if (!tokens) {
		return false;
	}

	return new WhenExpressionParser(contextValues, tokens).parse();
}

/**
 * Reads package.json at runtime to discover keys routed through `whichkey.triggerKey`.
 * Args can be a plain string (key only) or an object with an optional condition.
 */
function getWhichKeyTriggerBindings(): WhichKeyTriggerBinding[] {
	const extension = vscode.extensions.getExtension('bearylabs.doom');
	const packageJson = extension?.packageJSON as {
		contributes?: {
			keybindings?: unknown[];
		};
	} | undefined;

	return (packageJson?.contributes?.keybindings ?? []).flatMap((entry) => {
		if (!isRecord(entry) || entry.command !== 'doom.triggerKey' || typeof entry.when !== 'string') {
			return [];
		}

		if (typeof entry.args === 'string') {
			return [{
				key: normalizeBindingKey(entry.args),
				when: entry.when,
			}];
		}

		if (!isRecord(entry.args) || typeof entry.args.key !== 'string') {
			return [];
		}

		return [{
			condition: typeof entry.args.when === 'string' ? entry.args.when : undefined,
			key: normalizeBindingKey(entry.args.key),
			when: entry.when,
		}];
	});
}

/**
 * Returns the condition string for the first matching trigger binding.
 * Keybinding-triggered condition wins over evaluated when-expressions to honour the exact chord that fired.
 */
export function selectTriggeredConditionForKey(
	key: string,
	contextValues: Record<string, boolean | string>,
	triggerBindings: WhichKeyTriggerBinding[],
): string | undefined {
	for (const binding of triggerBindings) {
		if (binding.key !== key) {
			continue;
		}

		if (evaluateWhenExpression(contextValues, binding.when)) {
			return binding.condition;
		}
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Context and render helpers
// ---------------------------------------------------------------------------

/**
 * Blends live VS Code state with tracked state.
 * activePanel and copilotVisible have no direct query API so they come from tracked context.
 */
function buildContextSnapshot(state: DoomWhichKeyMenu): ContextSnapshot {
	const activeEditor = vscode.window.activeTextEditor;
	const activeSelection = activeEditor?.selection;
	const activeGroup = vscode.window.tabGroups.activeTabGroup;
	const activeTab = activeGroup.activeTab;

	return {
		activeEditorLastInGroup: activeTab !== undefined
			&& activeGroup.tabs.length > 0
			&& activeGroup.tabs[activeGroup.tabs.length - 1] === activeTab,
		activePanel: state.trackedUiContext.activePanel,
		activeViewlet: state.trackedUiContext.activeViewlet,
		bigModeEnabled: state.isBigModeEnabled,
		copilotVisible: state.trackedUiContext.copilotVisible,
		editorHasSelection: activeSelection !== undefined && !activeSelection.isEmpty,
		explorerViewletVisible: state.trackedUiContext.explorerViewletVisible,
		markersVisible: state.trackedUiContext.markersVisible,
		multipleEditorGroups: vscode.window.tabGroups.all.length > 1,
		terminalFocus: state.showContext.terminalFocus,
	};
}

/**
 * An empty key in a binding option marks it as the fallback.
 * Triggered condition from the fired keybinding wins over evaluated when-expressions.
 */
function resolveConditionalBinding(state: DoomWhichKeyMenu, binding: WhichKeyBinding): WhichKeyBinding | undefined {
	const options = binding.bindings ?? [];
	let fallback: WhichKeyBinding | undefined;
	const contextValues = getContextValues(state);
	const triggeredCondition = selectTriggeredConditionForKey(
		binding.key,
		contextValues,
		getWhichKeyTriggerBindings(),
	);

	if (triggeredCondition) {
		const triggeredOption = options.find(
			(option) => normalizeCondition(option.key) === triggeredCondition,
		);
		if (triggeredOption) {
			return triggeredOption;
		}
	}

	for (const option of options) {
		const key = option.key.trim();
		if (key.length === 0) {
			fallback = option;
			continue;
		}

		if (evaluateWhenExpression(contextValues, normalizeCondition(key))) {
			return option;
		}
	}

	return fallback;
}

/**
 * Conditional bindings inherit the parent key so navigation stays consistent.
 * A resolved name of 'default' means use the parent binding's display name.
 */
function toRenderItem(state: DoomWhichKeyMenu, binding: WhichKeyBinding): RenderItem | undefined {
	switch (binding.type) {
	case 'bindings':
		return {
			isGroup: true,
			key: binding.key,
			name: binding.name,
		};
	case 'command':
	case 'commands':
		return {
			isGroup: false,
			key: binding.key,
			name: binding.name,
		};
	case 'conditional': {
		const resolved = resolveConditionalBinding(state, binding);
		if (!resolved) {
			return undefined;
		}

		const resolvedName = resolved.name === 'default' ? binding.name : resolved.name;
		return toRenderItem(state, {
			...resolved,
			key: binding.key,
			name: resolvedName,
		});
	}
	default:
		return undefined;
	}
}

/** Per-load random nonce for the Content-Security-Policy script-src directive. */
function getNonce(): string {
	return Math.random().toString(36).slice(2, 12);
}

// ---------------------------------------------------------------------------
// Which-key panel controller
// ---------------------------------------------------------------------------

export class DoomWhichKeyMenu {
	static readonly visibleContextKey = 'whichkeyVisible';

	private bigModeEnabled = false;
	private currentBindings: WhichKeyBinding[] = [];
	private currentItems: RenderItem[] = [];
	private currentShowContext: ShowContext = {
		terminalFocus: false,
		terminalPanelOpen: false,
		explorerVisible: false,
	};
	private hostPendingKeys: string[] = [];
	private isShowing = false;
	private ready = false;
	private stack: WhichKeyBinding[] = [];
	private trackedContext: TrackedUiContext = createTrackedUiContext();
	private view: vscode.WebviewView | undefined;
	private viewDisposables: vscode.Disposable[] = [];

	get isBigModeEnabled(): boolean {
		return this.bigModeEnabled;
	}

	get snapshot(): ContextSnapshot {
		return buildContextSnapshot(this);
	}

	get showContext(): ShowContext {
		return this.currentShowContext;
	}

	get isCurrentlyShowing(): boolean {
		return this.isShowing;
	}

	get trackedUiContext(): TrackedUiContext {
		return this.trackedContext;
	}

	/** Keys pressed before the webview is ready are buffered and replayed after the first render. */
	queueKey(key: string): void {
		this.hostPendingKeys.push(key);
	}

	/** Called before the panel opens so bindings are fresh and the navigation stack is at root. */
	prepareShow(showContext?: Partial<ShowContext>): void {
		this.isShowing = true;
		this.hostPendingKeys = [];
		this.currentShowContext = {
			terminalFocus: showContext?.terminalFocus === true,
			terminalPanelOpen: showContext?.terminalPanelOpen === true,
			explorerVisible: showContext?.explorerVisible === true,
		};
		this.syncTrackedContextFromShowContext(showContext);
		this.currentBindings = getConfiguredWhichKeyBindings();
		this.stack = [];
	}

	private syncTrackedContextFromShowContext(showContext?: Partial<ShowContext>): void {
		if (showContext?.terminalPanelOpen === true) {
			this.trackedContext = { ...this.trackedContext, activePanel: 'terminal' };
		} else if (showContext?.terminalPanelOpen === false && this.trackedContext.activePanel === 'terminal') {
			this.trackedContext = { ...this.trackedContext, activePanel: '' };
		}

		if (showContext?.explorerVisible === true) {
			this.trackedContext = { ...this.trackedContext, explorerViewletVisible: true };
		} else if (showContext?.explorerVisible === false) {
			this.trackedContext = { ...this.trackedContext, explorerViewletVisible: false };
		}
	}

	/**
	 * SharedPanelController contract — called when this controller becomes active.
	 * When re-attaching to the same retained webview, skip HTML reinitialization so
	 * the webview's JS context stays intact and keys typed immediately after SPC aren't lost.
	 */
	attachToView(webviewView: vscode.WebviewView): void {
		if (this.view === webviewView) {
			this.viewDisposables.forEach((disposable) => disposable.dispose());
			this.viewDisposables = [];
			this.registerViewListeners(webviewView);
			this.render();
			return;
		}

		this.resolveWebviewView(webviewView);
	}

	/** SharedPanelController contract — disposes view-scoped listeners so the next attach starts clean. */
	detachFromView(): void {
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = undefined;
		this.ready = false;
		this.currentItems = [];
	}

	/** Returns root bindings when the navigation stack is empty (top-level menu). */
	private get currentLevelBindings(): WhichKeyBinding[] {
		const current = this.stack[this.stack.length - 1];
		return current?.bindings ?? this.currentBindings;
	}

	/** Used when the panel collapses externally; avoids a double-close if the view is already hidden. */
	async hide(): Promise<void> {
		if (!this.view?.visible) {
			this.isShowing = false;
			this.hostPendingKeys = [];
			await this.updateVisibilityContext(false);
			return;
		}

		await this.close();
	}

	/**
	 * Disposes previous listeners first — called on re-attachment (panel mode switch), not just first registration.
	 * Also wires the `onDidChangeActiveTextEditor` fallback for focus-loss detection alongside the webview blur listener.
	 */
	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.viewDisposables.forEach((disposable) => disposable.dispose());
		this.viewDisposables = [];
		this.view = webviewView;
		webviewView.title = 'Doom Which Key';
		webviewView.description = 'Two-column menu';
		webviewView.webview.options = {
			enableScripts: true,
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.registerViewListeners(webviewView);
	}

	/** Registers view-scoped event listeners, used both on first init and retained-view re-attach. */
	private registerViewListeners(webviewView: vscode.WebviewView): void {
		this.viewDisposables.push(
			webviewView.onDidDispose(() => {
				if (this.view === webviewView) {
					this.view = undefined;
					this.ready = false;
					this.currentItems = [];
					void this.updateVisibilityContext(false);
				}
			}),
			webviewView.onDidChangeVisibility(() => {
				void this.updateVisibilityContext(webviewView.visible);
				if (webviewView.visible) {
					this.render();
				}
			}),
			webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
				void this.handleMessage(message);
			}),
			vscode.window.onDidChangeActiveTextEditor(() => {
				if (this.isShowing) {
					void this.close();
				}
			})
		);
	}

	/** Closes the menu before executing so commands see the original UI state, not the which-key overlay. */
	async executeBinding(binding: WhichKeyBinding): Promise<void> {
		await this.close();

		await executeWhichKeyBindingCommands(binding, (command, arg) => {
			this.trackContextCommand(command, arg);
		});
	}

	/**
	 * A conditional binding can resolve to another bindings group, so we push onto the navigation stack
	 * instead of executing — this keeps back-navigation consistent with regular group traversal.
	 */
	private async handleMessage(message: WebviewMessage): Promise<void> {
		if (message.type === 'ready') {
			this.ready = true;
			this.render();
			return;
		}

		if (message.type === 'close') {
			await this.close();
			return;
		}

		if (message.type === 'back') {
			if (this.stack.length === 0) {
				await this.close();
				return;
			}

			this.stack.pop();
			this.render();
			return;
		}

		if (message.type !== 'activate' || message.index === undefined) {
			return;
		}

		const renderItem = this.currentItems[message.index];
		if (!renderItem) {
			return;
		}

		const binding = this.currentLevelBindings.find((item) => item.key === renderItem.key);
		if (!binding) {
			return;
		}

		if (binding.type === 'bindings') {
			this.stack.push(binding);
			this.render();
			return;
		}

		if (binding.type === 'conditional') {
			const resolved = resolveConditionalBinding(this, binding);
			if (!resolved) {
				return;
			}

			if (resolved.type === 'bindings') {
				this.stack.push({
					...binding,
					bindings: resolved.bindings,
				});
				this.render();
				return;
			}

			await this.executeBinding({
				...resolved,
				key: binding.key,
				name: resolved.name === 'default' ? binding.name : resolved.name,
			});
			return;
		}

		await this.executeBinding(binding);
	}

	/**
	 * Drains one pending key per render pass; subsequent keys are handled via handleMessage → render recursion.
	 * Pending keys let the host queue a chord before the webview is ready.
	 */
	private render(): void {
		if (!this.view || !this.ready || !this.view.visible) {
			return;
		}

		const levelBindings = this.currentLevelBindings;
		this.currentItems = levelBindings
			.map((binding) => toRenderItem(this, binding))
			.filter((item): item is RenderItem => item !== undefined);

		const current = this.stack[this.stack.length - 1];
		const footerPath = current
			? `SPC ${this.stack.map((binding) => binding.key).join(' ')}-`
			: 'SPC-';
		const footerLabel = current?.name.replace(/^\+/, '') ?? '<leader>';

		const state: ViewState = {
			footerLabel,
			footerPath,
			items: this.currentItems,
		};

		void this.view.webview.postMessage({
			type: 'render',
			state,
		});

		if (this.hostPendingKeys.length > 0 && this.currentItems.length > 0) {
			const key = this.hostPendingKeys.shift()!;
			const index = this.currentItems.findIndex((item) => item.key === key);
			if (index >= 0) {
				void this.handleMessage({ type: 'activate', index });
			}
		}
	}

	/** Intercepts `doom.bigModeEnabled` as a local flag before delegating to the shared context tracker. */
	trackContextCommand(command: string, arg?: unknown): void {
		if (command !== 'setContext' || !Array.isArray(arg) || arg.length < 2) {
			this.trackedContext = applyTrackedUiContextCommand(this.trackedContext, command, arg);
			return;
		}

		const [key, value] = arg;
		if (key === 'doom.bigModeEnabled' && typeof value === 'boolean') {
			this.bigModeEnabled = value;
		}

		this.trackedContext = applyTrackedUiContextCommand(this.trackedContext, command, arg);
	}

	/**
	 * Posts 'hide' to the webview before closing to reset the blur guard.
	 * Without this, the webview retains its `blurEnabled = true` state and spuriously closes on the next open.
	 * If the terminal was the active panel before which-key opened, restore it instead of closing the panel.
	 */
	private async close(): Promise<void> {
		this.isShowing = false;
		this.hostPendingKeys = [];
		void this.view?.webview.postMessage({ type: 'hide' });
		await this.updateVisibilityContext(false);
		if (this.trackedContext.activePanel === 'terminal') {
			await vscode.commands.executeCommand('workbench.action.terminal.focus');
			if (!this.currentShowContext.terminalFocus) {
				await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			}
		} else {
			await vscode.commands.executeCommand('workbench.action.closePanel');
		}
	}

	/** Drives the `whichkeyVisible` when-context that gates SPC and other keys routing to the menu. */
	private async updateVisibilityContext(isVisible: boolean): Promise<void> {
		await vscode.commands.executeCommand('setContext', DoomWhichKeyMenu.visibleContextKey, isVisible);
	}

	/**
	 * Generates fresh HTML with a per-load nonce on every attachment.
	 * The blur listener is delayed 200ms post-render so VS Code can settle focus before the guard activates.
	 */
	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Doom Which Key</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: var(--vscode-panel-background);
			--muted: var(--vscode-descriptionForeground);
			--text: var(--vscode-editor-foreground);
			--key: var(--vscode-errorForeground);
			--group: var(--vscode-focusBorder);
			--font-family: var(--vscode-editor-font-family, monospace);
			--font-size: var(--vscode-editor-font-size, 13px);
			--line-height: var(--vscode-editor-line-height, 20px);
		}

		* {
			box-sizing: border-box;
		}

		body {
			margin: 0;
			padding: 6px 8px 2px;
			min-height: 100vh;
			font-family: var(--font-family);
			font-size: var(--font-size);
			line-height: var(--line-height);
			background: var(--bg);
			color: var(--text);
			overflow: hidden;
		}

		.shell {
			display: flex;
			flex-direction: column;
			gap: 4px;
			width: 100%;
			height: calc(100vh - 8px);
		}

		.shell:focus {
			outline: none;
		}

		.grid {
			--row-count: 1;
			display: grid;
			grid-auto-columns: 248px;
			grid-auto-flow: column;
			grid-template-rows: repeat(var(--row-count), max-content);
			column-gap: 12px;
			row-gap: 1px;
			flex: 1 1 auto;
			overflow: auto;
			align-content: start;
		}

		.item {
			display: flex;
			align-items: center;
			gap: 6px;
			width: 100%;
			padding: 0;
			border: none;
			border-radius: 0;
			background: transparent;
			color: inherit;
			text-align: left;
			cursor: pointer;
			font: inherit;
			margin: 0;
		}

		.item:hover,
		.item:focus-visible {
			outline: none;
			text-decoration: underline;
			text-underline-offset: 2px;
		}

		.key {
			flex: 0 0 auto;
			min-width: 28px;
			color: var(--key);
		}

		.sep {
			color: var(--muted);
		}

		.item.group .label {
			color: var(--group);
		}

		.label {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.empty {
			padding: 6px 0;
			color: var(--muted);
		}

		.footer {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: center;
			column-gap: 12px;
			margin-top: 6px;
			color: var(--muted);
		}

		.path {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.path-label {
			color: var(--text);
		}

		.hint {
			justify-self: end;
			text-align: right;
			white-space: nowrap;
		}

		@media (max-width: 760px) {
			body {
				padding: 6px 6px 2px;
			}

			.grid {
				grid-auto-columns: 208px;
				column-gap: 10px;
			}

			.footer {
				grid-template-columns: minmax(0, 1fr);
				row-gap: 2px;
			}

			.hint {
				justify-self: start;
				text-align: left;
			}
		}
	</style>
</head>
<body>
	<div class="shell" id="shell" tabindex="-1">
		<div class="grid" id="grid"></div>
		<div class="empty" id="empty" hidden>No bindings here.</div>
		<div class="footer">
			<div class="path" id="path">SPC- &lt;leader&gt;</div>
			<div class="hint">Type key. Backspace go back. Esc close.</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const shell = document.getElementById('shell');
		const grid = document.getElementById('grid');
		const empty = document.getElementById('empty');
		const path = document.getElementById('path');
		let items = [];
		let pendingKeys = [];
		let blurEnabled = false;
		let blurTimer = null;

		function updateGridRowCount() {
			if (items.length === 0) {
				grid.style.setProperty('--row-count', '1');
				return;
			}

			const firstItem = grid.querySelector('.item');
			if (!(firstItem instanceof HTMLElement)) {
				grid.style.setProperty('--row-count', String(items.length));
				return;
			}

			const itemHeight = firstItem.offsetHeight || 1;
			const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap || '0') || 0;
			const availableHeight = grid.clientHeight || itemHeight;
			const rows = Math.max(1, Math.floor((availableHeight + rowGap) / (itemHeight + rowGap)));
			grid.style.setProperty('--row-count', String(Math.min(rows, items.length)));
		}

		function render(state) {
			items = state.items;
			path.innerHTML = \`<span>\${state.footerPath}</span> <span class="path-label">\${state.footerLabel}</span>\`;
			grid.innerHTML = '';

			if (items.length === 0) {
				empty.hidden = false;
				return;
			}

			empty.hidden = true;

			items.forEach((item, index) => {
				const button = document.createElement('button');
				button.className = item.isGroup ? 'item group' : 'item';
				button.type = 'button';
				button.addEventListener('click', () => {
					vscode.postMessage({ type: 'activate', index });
				});
				button.innerHTML = \`
					<span class="key">\${item.key}</span>
					<span class="sep">:</span>
					<span class="label">\${item.name}</span>
				\`;
				grid.appendChild(button);
			});

			updateGridRowCount();

			if (shell instanceof HTMLElement && document.activeElement === document.body) {
				shell.focus();
			}

			if (pendingKeys.length > 0 && items.length > 0) {
				const key = pendingKeys.shift();
				const index = items.findIndex((item) => item.key === key);
				if (index >= 0) {
					vscode.postMessage({ type: 'activate', index });
				}
			}
		}

		function toBindingKey(event) {
			if (event.key === ' ') {
				return 'SPC';
			}

			if (event.key === 'Tab') {
				return 'TAB';
			}

			if (event.key.length === 1) {
				return event.key;
			}

			return null;
		}

		window.addEventListener('message', (event) => {
			if (event.data.type === 'render') {
				clearTimeout(blurTimer);
				blurTimer = setTimeout(() => { blurEnabled = true; }, 200);
				render(event.data.state);
			} else if (event.data.type === 'hide') {
				clearTimeout(blurTimer);
				blurEnabled = false;
			}
		});

		window.addEventListener('keydown', (event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				pendingKeys = [];
				vscode.postMessage({ type: 'close' });
				return;
			}

			if (event.key === 'Backspace' || event.key === 'ArrowLeft') {
				event.preventDefault();
				pendingKeys = [];
				vscode.postMessage({ type: 'back' });
				return;
			}

			const bindingKey = toBindingKey(event);
			if (!bindingKey) {
				return;
			}

			if (items.length === 0) {
				event.preventDefault();
				pendingKeys.push(bindingKey);
				return;
			}

			const index = items.findIndex((item) => item.key === bindingKey);
			if (index >= 0) {
				event.preventDefault();
				vscode.postMessage({ type: 'activate', index });
			}
		});

		window.addEventListener('resize', updateGridRowCount);

		window.addEventListener('blur', () => {
			if (blurEnabled) {
				vscode.postMessage({ type: 'close' });
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
