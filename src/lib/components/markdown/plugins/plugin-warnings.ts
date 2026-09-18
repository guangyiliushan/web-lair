/**
 * Warning helpers shared by the markdown plugin layer.
 *
 * Warnings are logged once per cause and capped in total: SSR renders the
 * same tree repeatedly, and the dedupe keys can contain author-provided text
 * (container names, parameter values), so an unbounded set would let a
 * hostile document grow memory and log volume.
 */
const WARN_LIMIT = 100;
const warnedKeys = new Set<string>();

export function warnOnce(key: string, message: string): void {
	if (warnedKeys.has(key) || warnedKeys.size >= WARN_LIMIT) return;
	warnedKeys.add(key);
	console.warn(`[markdown] ${message}`);
}
