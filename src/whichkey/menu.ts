import * as vscode from 'vscode';
import { createNonce, isRecord } from '../panel/helpers';
import { focusEditorGroup } from '../window/mru';
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
	explorerFocused: boolean;
	webviewFocused: boolean;
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
	type: 'activate' | 'close' | 'ready';
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
	case 'doom.openPanelTerminal':
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

const BLUR_ENABLE_DELAY_MS = 200;

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

type PackageJsonWithKeybindings = {
	contributes?: {
		keybindings?: unknown[];
	};
};

let cachedTriggerBindings: WhichKeyTriggerBinding[] | undefined;

/**
 * Reads package.json at runtime to discover keys routed through `whichkey.triggerKey`.
 * Args can be a plain string (key only) or an object with an optional condition.
 * Result is memoized — package.json is static for the session.
 */
function getWhichKeyTriggerBindings(packageJson: PackageJsonWithKeybindings): WhichKeyTriggerBinding[] {
	if (cachedTriggerBindings) {
		return cachedTriggerBindings;
	}

	cachedTriggerBindings = (packageJson.contributes?.keybindings ?? []).flatMap((entry) => {
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

	return cachedTriggerBindings;
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
 * multipleEditorGroups comes from a pre-menu snapshot, not a live read: the menu opens as its
 * own editor group, so a live `tabGroups.all.length` would over-count and flip the flag on with a
 * single real group. See {@link DoomWhichKeyMenu.hadMultipleEditorGroupsBeforeMenu}.
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
		multipleEditorGroups: state.hadMultipleEditorGroupsBeforeMenu,
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
		getWhichKeyTriggerBindings(state.extensionPackageJson),
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


// ---------------------------------------------------------------------------
// Editor-group layout for the menu
// ---------------------------------------------------------------------------

/** VS Code grid orientation for `vscode.setEditorLayout`: children stacked along the vertical axis (top/bottom). */
const GROUP_ORIENTATION_VERTICAL = 1;
/** Fraction of window height given to the menu's bottom group; the remainder keeps the previous layout. */
const MENU_GROUP_HEIGHT_FRACTION = 0.18;
/** Slack between the requested and realised menu-row fraction before a pixel-exact retry is worth it. */
const MENU_HEIGHT_TOLERANCE = 0.02;

/** Mirrors the (non-exported) argument shape of `vscode.getEditorLayout` / `vscode.setEditorLayout`. */
export interface EditorGroupLayout {
	orientation?: number;
	groups?: EditorGroupLayoutNode[];
}

export interface EditorGroupLayoutNode {
	groups?: EditorGroupLayoutNode[];
	size?: number;
}

/**
 * Builds a layout that reproduces `previous` as a full-width top block and appends one fresh
 * full-width group as the bottom-most row for the menu. The outer split is always vertical
 * (top/bottom) so the menu spans the entire window width beneath the previous layout.
 *
 * `setEditorLayout` flips orientation on every nesting level and drops redundant single-child
 * wrappers (see VS Code's `serializeGridNodeDescriptor`/`sanitizeGridNodeDescriptor`), so the
 * previous groups are placed differently depending on their orientation:
 *
 *  - Side-by-side (or a single group): nest the previous groups under one top block. As a child of
 *    the vertical outer split, that block lays its own children out horizontally, reproducing the
 *    columns; any sub-splits alternate from there.
 *  - Already stacked (vertical): the previous split is colinear with the outer split. Nesting it
 *    would need a redundant single-child wrapper that VS Code collapses, flattening the stack into
 *    a side-by-side split (the original bug). Instead, merge the previous rows straight into the
 *    outer split and append the menu as one more row, rescaling the rows to share the top portion.
 *
 * Sizes are fractions of the editor area when `totalHeight` is unknown and pixels when it is
 * given. Pixels matter: VS Code marks a group non-proportional once it sits exactly at its
 * minimum width/height (see `EditorGroupView.proportionalLayout`), and a non-proportional node
 * keeps its `size` verbatim as pixels — a fractional `0.82` then survives as 0.82px and the menu
 * row swallows the whole editor area. Pixel sizes are correct on both layout paths.
 */
export function buildMenuLayout(previous: EditorGroupLayout, totalHeight?: number): EditorGroupLayout {
	const scale = totalHeight !== undefined && totalHeight > 0 ? totalHeight : 1;
	const menuSize = MENU_GROUP_HEIGHT_FRACTION * scale;
	const topSize = scale - menuSize;
	const previousGroups = previous.groups ?? [{}];
	const menuGroup: EditorGroupLayoutNode = { size: menuSize };

	if (previous.orientation === GROUP_ORIENTATION_VERTICAL) {
		return {
			orientation: GROUP_ORIENTATION_VERTICAL,
			groups: [...scaleGroupSizes(previousGroups, topSize), menuGroup],
		};
	}

	return {
		orientation: GROUP_ORIENTATION_VERTICAL,
		groups: [
			{ groups: previousGroups, size: topSize },
			menuGroup,
		],
	};
}

/**
 * Returns copies of `groups` whose sizes are rescaled to sum to `fraction`, preserving their
 * relative proportions and any nested `groups`. Groups without a positive size share the space
 * equally, so a sizeless fallback still yields a sane split.
 */
function scaleGroupSizes(groups: EditorGroupLayoutNode[], fraction: number): EditorGroupLayoutNode[] {
	const weights = groups.map((group) => (typeof group.size === 'number' && group.size > 0 ? group.size : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	return groups.map((group, index) => ({ ...group, size: (weights[index] / total) * fraction }));
}

/**
 * Reads the realised menu-row height out of a layout returned by `vscode.getEditorLayout` after
 * the reshape. The applied layout is a vertical split, so the root children's sizes are row
 * heights in pixels — the only point at which the editor area's height is observable.
 * Returns `undefined` when the layout carries no usable sizes.
 */
export function measureMenuRow(applied: EditorGroupLayout): { fraction: number; totalHeight: number } | undefined {
	const rows = applied.groups ?? [];
	const menuRow = rows[rows.length - 1];
	if (rows.length < 2 || typeof menuRow?.size !== 'number') {
		return undefined;
	}

	const totalHeight = rows.reduce((sum, row) => sum + (typeof row.size === 'number' ? row.size : 0), 0);
	if (totalHeight <= 0) {
		return undefined;
	}

	return { fraction: menuRow.size / totalHeight, totalHeight };
}

// ---------------------------------------------------------------------------
// Which-key menu controller
// ---------------------------------------------------------------------------

export class DoomWhichKeyMenu {
	static readonly visibleContextKey = 'whichkeyVisible';
	private static readonly viewType = 'doom.whichKeyMenu';

	private bigModeEnabled = false;
	private readonly packageJson: PackageJsonWithKeybindings;
	private currentBindings: WhichKeyBinding[] = [];

	private currentItems: RenderItem[] = [];
	private currentShowContext: ShowContext = {
		terminalFocus: false,
		terminalPanelOpen: false,
		explorerVisible: false,
		explorerFocused: false,
		webviewFocused: false,
	};
	private hostPendingKeys: string[] = [];
	private isShowing = false;
	private nextKeyResolvers: Array<() => void> = [];
	private preWhichKeyEditorGroup: vscode.ViewColumn | undefined;
	/** Real editor-group count (>1) captured before the menu adds its own group; feeds multipleEditorGroups. */
	private preWhichKeyMultipleEditorGroups = false;
	private ready = false;
	private stack: WhichKeyBinding[] = [];
	private trackedContext: TrackedUiContext = createTrackedUiContext();
	private panel: vscode.WebviewPanel | undefined;
	private panelDisposables: vscode.Disposable[] = [];
	/** Snapshot of the editor grid taken before reshaping, restored verbatim when the menu closes. */
	private previousLayout: EditorGroupLayout | undefined;
	/** Serialises overlapping close triggers (Escape + blur + dispose) into one teardown. */
	private closing = false;

	constructor(packageJson: PackageJsonWithKeybindings) {
		this.packageJson = packageJson;
	}

	get extensionPackageJson(): PackageJsonWithKeybindings {
		return this.packageJson;
	}

	get isBigModeEnabled(): boolean {
		return this.bigModeEnabled;
	}

	get snapshot(): ContextSnapshot {
		return buildContextSnapshot(this);
	}

	get preWhichKeyEditorGroupColumn(): vscode.ViewColumn | undefined {
		return this.preWhichKeyEditorGroup;
	}

	/**
	 * Whether more than one real editor group existed when the menu opened, snapshotted in
	 * {@link prepareShow} before the menu's own group is created. Reading `tabGroups.all.length`
	 * live once the menu is open counts the menu group too, wrongly flipping H/J/K/L to the
	 * move-group branch with a single real group.
	 */
	get hadMultipleEditorGroupsBeforeMenu(): boolean {
		return this.preWhichKeyMultipleEditorGroups;
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

	/**
	 * The single entry point for every key of a chord — the webview does not read the keyboard.
	 * Before the panel exists the idle-delay loop drains the queue (woken via nextKeyResolvers);
	 * once the panel is up nothing else is listening, so the drain has to be kicked from here.
	 */
	queueKey(key: string): void {
		this.hostPendingKeys.push(key);
		const resolvers = this.nextKeyResolvers.splice(0);
		resolvers.forEach((r) => r());

		if (this.panel && this.ready) {
			this.drainPendingKey();
		}
	}

	/** Resolves on the next call to queueKey — used by the idle-delay loop to wake on key arrival. */
	waitForNextKey(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.nextKeyResolvers.push(resolve);
		});
	}

	/** True when buffered keys remain after a resolveQueuedKeys walk (unrecognised key encountered). */
	get hasPendingKeys(): boolean {
		return this.hostPendingKeys.length > 0;
	}

	/** Sets the navigation stack directly — used by resolveQueuedKeys to pre-navigate before the panel opens. */
	setNavigationStack(stack: WhichKeyBinding[]): void {
		this.stack = stack;
	}

	/**
	 * Walks the binding tree against buffered keys without opening the panel.
	 * Starts from the current navigation depth (respects any stack already set by setNavigationStack).
	 * Returns 'execute' when all queued keys resolve to a leaf command (silent execution, panel never shown).
	 * Returns 'show' when keys run out mid-tree or hit an unknown key; the partially-walked stack
	 * is included so the panel can open pre-navigated to the right group.
	 * Unrecognised keys are left in hostPendingKeys for the rendered panel to handle.
	 */
	resolveQueuedKeys(): { type: 'show'; stack: WhichKeyBinding[] } | { type: 'execute'; binding: WhichKeyBinding } {
		let levelBindings = this.currentLevelBindings;
		const stack: WhichKeyBinding[] = [...this.stack];

		while (this.hostPendingKeys.length > 0) {
			const key = this.hostPendingKeys[0];
			const binding = levelBindings.find((b) => b.key === key);

			if (!binding) {
				// Unrecognised key — leave it queued so the rendered panel can handle it
				return { type: 'show', stack };
			}

			this.hostPendingKeys.shift();

			if (binding.type === 'bindings') {
				stack.push(binding);
				levelBindings = binding.bindings ?? [];
				continue;
			}

			if (binding.type === 'conditional') {
				const resolved = resolveConditionalBinding(this, binding);
				if (!resolved) {
					return { type: 'show', stack };
				}

				if (resolved.type === 'bindings') {
					const grouped: WhichKeyBinding = { ...binding, bindings: resolved.bindings };
					stack.push(grouped);
					levelBindings = resolved.bindings ?? [];
					continue;
				}

				return {
					type: 'execute',
					binding: {
						...resolved,
						key: binding.key,
						name: resolved.name === 'default' ? binding.name : resolved.name,
					},
				};
			}

			if (binding.type === 'command' || binding.type === 'commands') {
				return { type: 'execute', binding };
			}
		}

		// All buffered keys consumed but resolved to a group — open panel pre-navigated
		return { type: 'show', stack };
	}

	/** Called before the panel opens so bindings are fresh and the navigation stack is at root. */
	prepareShow(showContext?: Partial<ShowContext>): void {
		this.isShowing = true;
		this.hostPendingKeys = [];
		this.preWhichKeyEditorGroup = vscode.window.tabGroups.activeTabGroup.viewColumn;
		// Snapshot before the menu adds its own editor group so multipleEditorGroups reflects the
		// real group count for the whole session (used by the H/J/K/L conditional bindings).
		this.preWhichKeyMultipleEditorGroups = vscode.window.tabGroups.all.length > 1;
		this.currentShowContext = {
			terminalFocus: showContext?.terminalFocus === true,
			terminalPanelOpen: showContext?.terminalPanelOpen === true,
			explorerVisible: showContext?.explorerVisible === true,
			explorerFocused: showContext?.explorerFocused === true,
			webviewFocused: showContext?.webviewFocused === true,
		};
		this.syncTrackedContextFromShowContext(showContext);
		this.currentBindings = getConfiguredWhichKeyBindings();
		this.stack = [];
	}

	private syncTrackedContextFromShowContext(showContext?: Partial<ShowContext>): void {
		if (showContext?.terminalPanelOpen === true) {
			this.trackedContext = { ...this.trackedContext, activePanel: 'terminal' };
		} else if (showContext?.terminalPanelOpen === false && this.trackedContext.activePanel === 'terminal') {
			// Don't reset when focus moved to an editor-group terminal — the panel terminal
			// may still be visible even though activePanel != 'terminal' in VS Code's context.
			const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
			if (!(activeTab?.input instanceof vscode.TabInputTerminal)) {
				this.trackedContext = { ...this.trackedContext, activePanel: '' };
			}
		}

		if (showContext?.explorerVisible === true) {
			this.trackedContext = { ...this.trackedContext, explorerViewletVisible: true };
		} else if (showContext?.explorerVisible === false) {
			this.trackedContext = { ...this.trackedContext, explorerViewletVisible: false };
		}
	}

	/**
	 * Opens the menu in a brand-new, full-width editor group pinned to the bottom of the grid.
	 * The pre-existing editor layout is captured first so it can be restored verbatim on close,
	 * then reshaped (vertical outer split) so the menu group spans the full window width below it.
	 * A fresh webview is created each time, so the blur guard and JS state always start clean.
	 */
	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(this.panel.viewColumn, true);
			this.render();
			return;
		}

		const targetColumn = await this.reshapeLayoutForMenu();

		this.ready = false;
		this.currentItems = [];

		const panel = vscode.window.createWebviewPanel(
			DoomWhichKeyMenu.viewType,
			'Doom Which Key',
			{ viewColumn: targetColumn, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);
		this.panel = panel;
		panel.webview.html = this.getHtml(panel.webview);
		this.registerPanelListeners(panel);
		await this.updateVisibilityContext(true);
	}

	/**
	 * Captures the current editor layout, then reshapes the grid into a vertical outer split whose
	 * top child wraps the previous layout and whose bottom child is a fresh full-width group.
	 * Returns the ViewColumn of that new bottom group.
	 */
	private async reshapeLayoutForMenu(): Promise<number> {
		const previous = await vscode.commands.executeCommand<EditorGroupLayout>('vscode.getEditorLayout');
		this.previousLayout = previous;
		// Existing groups keep columns 1..N when a trailing group is appended, so the new
		// bottom group is column N+1.
		const targetColumn = vscode.window.tabGroups.all.length + 1;
		await vscode.commands.executeCommand('vscode.setEditorLayout', buildMenuLayout(previous));
		await this.correctMenuRowHeight(previous);
		return targetColumn;
	}

	/**
	 * Re-applies the layout with pixel sizes when the fractional first pass did not land on
	 * MENU_GROUP_HEIGHT_FRACTION. Only a pre-existing group pinned to its minimum width/height
	 * triggers this (see {@link buildMenuLayout}), so the common case costs one extra
	 * `getEditorLayout` and nothing more. Runs before the webview exists, so a corrected layout
	 * never flashes menu content at the wrong height.
	 */
	private async correctMenuRowHeight(previous: EditorGroupLayout): Promise<void> {
		const applied = await vscode.commands.executeCommand<EditorGroupLayout>('vscode.getEditorLayout');
		const measured = measureMenuRow(applied);
		if (!measured || Math.abs(measured.fraction - MENU_GROUP_HEIGHT_FRACTION) <= MENU_HEIGHT_TOLERANCE) {
			return;
		}

		await vscode.commands.executeCommand('vscode.setEditorLayout', buildMenuLayout(previous, measured.totalHeight));
	}

	/** Wires panel-scoped listeners: message dispatch and dispose-driven close. */
	private registerPanelListeners(panel: vscode.WebviewPanel): void {
		this.panelDisposables.push(
			panel.onDidDispose(() => {
				// User closed the tab directly. Our own teardown nulls this.panel before disposing,
				// so a programmatic dispose is a no-op here.
				if (this.panel === panel) {
					void this.close();
				}
			}),
			panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
				void this.handleMessage(message);
			}),
		);
	}

	/** Disposes the panel (if still open), tears down its listeners, and restores the pre-menu editor layout. */
	private async teardownPanel(): Promise<void> {
		this.panelDisposables.forEach((disposable) => disposable.dispose());
		this.panelDisposables = [];
		const panel = this.panel;
		this.panel = undefined;
		this.ready = false;
		this.currentItems = [];
		panel?.dispose();
		if (this.previousLayout) {
			await vscode.commands.executeCommand('vscode.setEditorLayout', this.previousLayout);
			this.previousLayout = undefined;
		}
	}

	/** Restores focus to the editor/terminal/explorer that was active before the menu opened. */
	private async restoreFocusAfterClose(): Promise<void> {
		if (this.trackedContext.activePanel === 'terminal') {
			await vscode.commands.executeCommand('workbench.action.terminal.focus');
			if (!this.currentShowContext.terminalFocus) {
				if (this.preWhichKeyEditorGroup !== undefined) {
					await focusEditorGroup(this.preWhichKeyEditorGroup);
				} else {
					await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
				}
			}
			return;
		}

		if (this.currentShowContext.explorerFocused && this.trackedContext.sidebarVisible) {
			await vscode.commands.executeCommand('workbench.action.focusSideBar');
		} else if (this.preWhichKeyEditorGroup !== undefined) {
			await focusEditorGroup(this.preWhichKeyEditorGroup);
		}
	}

	/** Returns root bindings when the navigation stack is empty (top-level menu). */
	private get currentLevelBindings(): WhichKeyBinding[] {
		const current = this.stack[this.stack.length - 1];
		return current?.bindings ?? this.currentBindings;
	}

	/** Used when the menu collapses externally; avoids a double-close if the panel is already gone. */
	async hide(): Promise<void> {
		if (!this.panel) {
			this.isShowing = false;
			this.hostPendingKeys = [];
			await this.updateVisibilityContext(false);
			return;
		}

		await this.close();
	}

	/** Closes the menu before executing so commands see the original UI state, not the which-key overlay. */
	async executeBinding(binding: WhichKeyBinding): Promise<void> {
		await this.close();

		try {
			await executeWhichKeyBindingCommands(binding, (command, arg) => {
				this.trackContextCommand(command, arg);
			});
		} finally {
			this.preWhichKeyEditorGroup = undefined;
		}
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
	 * Pushes the current level to the webview, then drains one key buffered before it was ready.
	 * Keys arriving after this point come in through {@link queueKey} instead.
	 */
	private render(): void {
		if (!this.panel || !this.ready || !this.panel.visible) {
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

		void this.panel.webview.postMessage({
			type: 'render',
			state,
		});

		this.drainPendingKey();
	}

	/**
	 * Applies one buffered key against the level currently on screen. Any keys behind it drain
	 * through the handleMessage → render recursion, so this only ever consumes one per call.
	 * A key with no binding at this level is discarded, matching the pre-render walk.
	 */
	private drainPendingKey(): void {
		if (this.hostPendingKeys.length === 0 || this.currentItems.length === 0) {
			return;
		}

		const key = this.hostPendingKeys.shift()!;
		const index = this.currentItems.findIndex((item) => item.key === key);
		if (index >= 0) {
			void this.handleMessage({ type: 'activate', index });
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
	 * Closes the menu: disposes the panel, restores the previous editor layout, and returns focus.
	 * The `closing` guard makes concurrent triggers (Escape + blur + active-editor-change + dispose)
	 * idempotent. Fast path: when the chord resolved before the panel was ever created there is
	 * nothing to tear down, so skip layout-restore/focus which would race the next command.
	 */
	private async close(): Promise<void> {
		if (this.closing) {
			return;
		}

		this.closing = true;
		try {
			this.isShowing = false;
			this.hostPendingKeys = [];
			await this.updateVisibilityContext(false);

			if (!this.panel) {
				this.previousLayout = undefined;
				return;
			}

			await this.teardownPanel();
			await this.restoreFocusAfterClose();
		} finally {
			this.closing = false;
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
		const nonce = createNonce();
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

		}
	</style>
</head>
<body>
	<div class="shell" id="shell" tabindex="-1">
		<div class="grid" id="grid"></div>
		<div class="empty" id="empty" hidden>No bindings here.</div>
		<div class="footer">
			<div class="path" id="path">SPC- &lt;leader&gt;</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const shell = document.getElementById('shell');
		const grid = document.getElementById('grid');
		const empty = document.getElementById('empty');
		const path = document.getElementById('path');
		let items = [];
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
		}

		window.addEventListener('message', (event) => {
			if (event.data.type === 'render') {
				clearTimeout(blurTimer);
				blurTimer = setTimeout(() => { blurEnabled = true; }, ${BLUR_ENABLE_DELAY_MS});
				render(event.data.state);
			} else if (event.data.type === 'hide') {
				clearTimeout(blurTimer);
				blurEnabled = false;
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
