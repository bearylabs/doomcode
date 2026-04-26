import * as vscode from 'vscode';

const STORAGE_KEY = 'doom.selectionHistory';
const MAX_ENTRIES = 500;
// Each explicit picker selection counts as this many ms of recency boost.
// Matches prescient.el's frequency/recency balance: a file picked 10 times
// stays ahead of a file opened once ~3 hours ago.
const FRECENCY_COUNT_WEIGHT_MS = 10 * 60 * 1000;

interface HistoryEntry {
	lastSelected: number;
	count: number;
}

/**
 * Persists file selection history across sessions via `globalState`.
 * Used to sort file pickers by recency (most recently opened first).
 * Storage is global (not per-workspace), matching prescient.el behaviour.
 */
export class SelectionHistory {
	private entries: Map<string, HistoryEntry>;

	constructor(private readonly state: vscode.Memento) {
		const stored = state.get<Record<string, HistoryEntry>>(STORAGE_KEY, {});
		this.entries = new Map(Object.entries(stored));
	}

	/** Explicit picker selection — bumps count and always updates timestamp. */
	record(fsPath: string): void {
		const existing = this.entries.get(fsPath);
		this.entries.set(fsPath, {
			lastSelected: Date.now(),
			count: (existing?.count ?? 0) + 1,
		});
		this.prune();
		void this.persist();
	}

	/**
	 * Passive open (e.g. onDidOpenTextDocument) — updates timestamp only if
	 * newer than what's stored, and never bumps count. Keeps picker selections
	 * weighted higher in frecency than background opens.
	 */
	recordIfNewer(fsPath: string, timestamp: number): void {
		const existing = this.entries.get(fsPath);
		if (existing && existing.lastSelected >= timestamp) {
			return;
		}
		this.entries.set(fsPath, {
			lastSelected: timestamp,
			count: existing?.count ?? 0,
		});
		this.prune();
		void this.persist();
	}

	/** Frecency score: recency + (count × weight). Higher = better. */
	getScore(fsPath: string): number {
		const entry = this.entries.get(fsPath);
		if (!entry) { return 0; }
		return entry.lastSelected + entry.count * FRECENCY_COUNT_WEIGHT_MS;
	}

	private prune(): void {
		if (this.entries.size <= MAX_ENTRIES) {
			return;
		}
		const sorted = [...this.entries.entries()]
			.sort((a, b) => b[1].lastSelected - a[1].lastSelected);
		this.entries = new Map(sorted.slice(0, MAX_ENTRIES));
	}

	private async persist(): Promise<void> {
		const obj: Record<string, HistoryEntry> = {};
		for (const [key, value] of this.entries) {
			obj[key] = value;
		}
		await this.state.update(STORAGE_KEY, obj);
	}
}
