export interface FuzzyMatch {
	indices: number[];
	score: number;
}

/** Generates a random 10-char alphanumeric nonce for CSP script-src directives. */
export function createNonce(): string {
	return Math.random().toString(36).slice(2, 12);
}

/**
 * Greedy subsequence fuzzy match. Returns undefined if not all query chars are found in order.
 *
 * Scoring: +8 per matched char, +4 per consecutive streak char (rewards contiguous runs).
 * Penalises by subtracting the index of the first match (rewards prefix matches).
 * Indices point into `text` and are used by the highlight renderer.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | undefined {
	if (query.length === 0) {
		return {
			indices: [],
			score: 0,
		};
	}

	let score = 0;
	let queryIndex = 0;
	let streak = 0;
	let firstMatch = -1;
	const indices: number[] = [];

	for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex++) {
		if (text[textIndex] !== query[queryIndex]) {
			streak = 0;
			continue;
		}

		if (firstMatch === -1) {
			firstMatch = textIndex;
		}

		queryIndex++;
		streak++;
		indices.push(textIndex);
		score += 8 + streak * 4;
	}

	if (queryIndex !== query.length) {
		return undefined;
	}

	return {
		indices,
		score: score - Math.max(firstMatch, 0),
	};
}