/**
 * What one language is called in the drawer and on the language ruler. Both
 * surfaces read this function, so a chip and an open drawer cannot disagree
 * about whether a language is missing, pending or published.
 */
export type DrawerState =
	'missing' | 'empty' | 'queued' | 'candidate' | 'failed' | 'draft' | 'published';

function hasText(value: string | null): boolean {
	return (value ?? '').trim() !== '';
}

/**
 * Candidate states outrank the presence row: a pending generation is newer than
 * whatever row it will replace.
 *
 * Only a `draft` candidate counts as pending. `discarded` and `accepted` rows
 * are history - the latter already exists as a row, which the presence map
 * describes - so an older draft candidate stays visible behind them. The
 * caller passes `candidates` newest-first, so the first match is the newest.
 */
export function drawerStateFor(input: {
	lang: string;
	presence: Record<string, { status: string; hasContent: boolean }>;
	candidates: Array<{
		targetLang: string;
		status: string;
		content: string | null;
		error: string | null;
	}>;
}): DrawerState {
	const pending = input.candidates.find(
		(candidate) => candidate.targetLang === input.lang && candidate.status === 'draft'
	);
	if (pending) {
		if (pending.error !== null) return 'failed';
		return hasText(pending.content) ? 'candidate' : 'queued';
	}

	const entry = input.presence[input.lang];
	if (!entry) return 'missing';
	if (entry.status === 'published' || entry.status === 'scheduled') return 'published';
	return entry.hasContent ? 'draft' : 'empty';
}

/**
 * How a queued row should present itself. "Queued" is not one state: a parked
 * row explains why it stopped, a claimed row is generating, and an unclaimed
 * row is waiting for a worker that may never come (no drain in dev, a dead
 * timer in prod). The token is locale-free so the copy stays in the component
 * and this table is testable.
 */
export type QueuedPresentation = 'waiting' | 'running' | 'pending';

export function queuedPresentation(input: {
	stage: string | null;
	waitingReason: string | null;
	runningSinceSec: number | null;
}): QueuedPresentation {
	// A parked row without a reason would paint an empty explanation; fall
	// back to the claim state instead.
	if (input.stage === 'waiting' && input.waitingReason) return 'waiting';
	return input.runningSinceSec != null ? 'running' : 'pending';
}
