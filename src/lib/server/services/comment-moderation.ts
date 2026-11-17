import { and, count, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { commentModerationEvents, comments } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';

export interface ModerationEventDraft {
	ruleId: string;
	outcome: 'allow' | 'hold' | 'block';
	detail: Record<string, unknown>;
}

export interface ModerationDecision {
	/** State the comment should receive when the decision is applied. */
	state: 'approved' | 'pending' | 'rejected';
	/** False in shadow mode (recorded, not enforced). */
	applied: boolean;
	events: ModerationEventDraft[];
}

const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;

/**
 * A conservative gate for admin-supplied regexes. JavaScript's backtracking
 * engine has no timeout; OWASP ReDoS documents nested quantifiers and
 * backreferences as the dangerous shapes. Unsafe patterns are skipped (and
 * logged) rather than executed - the alternative is an unbounded request.
 * This one function IS both the save-time gate and the runtime check; they
 * must never drift apart. A future switch to a linear-time engine (RE2) can
 * lift this restriction.
 */
export function isSafeRegexPattern(pattern: string): boolean {
	if (pattern.length === 0 || pattern.length > 200) return false;
	if (/\\[1-9]/.test(pattern)) return false;
	// Named backreference (\k<name>): the same exponential class as numeric.
	if (/\\k</.test(pattern)) return false;
	// Unbounded counted repetition ({n,}) is an unbounded quantifier.
	if (/\{\d+,/.test(pattern)) return false;
	// Any quantifier applied to a group whose body already holds an
	// alternation or a quantifier: (a+)+, (a*)*, (a|aa)+, (a+){25}$ are the
	// classic catastrophic shapes. Fails closed on harmless shapes like
	// (foo|bar)? - safe direction for a moderation tool.
	if (/\([^)]*(\||[+*?])[^)]*\)\s*[+*?{]/.test(pattern)) return false;
	// Several unbounded quantifiers in sequence (.*.*.*, a*a*a*...b) blow up
	// combinatorially on long non-matching input. Legit moderation patterns
	// rarely need more than two.
	if ((pattern.match(/[+*]/g) ?? []).length > 2) return false;
	return true;
}

function countLinks(text: string): number {
	return [...text.matchAll(URL_PATTERN)].length;
}

/**
 * L0 hard rules + L1 trust heuristics. The main path is
 * deliberately non-AI: keywords, link count, first-comment hold and the
 * trusted-user list. Returns null when moderation is disabled, so the caller
 * keeps the historical "admin auto-approves, everyone else pending" baseline.
 */
export async function evaluateCommentModeration(input: {
	text: string;
	readerId: string;
	autoApprove: boolean;
}): Promise<ModerationDecision | null> {
	if (input.autoApprove) return null;
	const config = await getOption('comments.moderation');
	if (!config.enabled) return null;

	const events: ModerationEventDraft[] = [];
	const result: { outcome: 'allow' | 'hold' | 'block' } = { outcome: 'allow' };

	const add = (event: ModerationEventDraft) => {
		events.push(event);
		if (event.outcome === 'block') result.outcome = 'block';
		else if (event.outcome === 'hold' && result.outcome === 'allow') result.outcome = 'hold';
	};

	const text = input.text.toLowerCase();
	for (const keyword of config.keywords) {
		const needle = keyword.trim().toLowerCase();
		if (needle && text.includes(needle)) {
			add({
				ruleId: `keyword:${needle.slice(0, 80)}`,
				outcome: 'block',
				detail: { keyword: needle.slice(0, 80) }
			});
		}
	}
	for (const pattern of config.regexes) {
		if (!isSafeRegexPattern(pattern)) {
			console.warn('[comments] skipped unsafe moderation regex', pattern.slice(0, 80));
			continue;
		}
		try {
			if (new RegExp(pattern, 'i').test(input.text)) {
				add({ ruleId: 'regex', outcome: 'block', detail: { pattern: pattern.slice(0, 80) } });
			}
		} catch {
			console.warn('[comments] invalid moderation regex skipped', pattern.slice(0, 80));
		}
	}

	const trusted = config.trustedUsers.includes(input.readerId);
	if (trusted) {
		add({ ruleId: 'trusted-user', outcome: 'allow', detail: {} });
	} else {
		const [history] = await db
			.select({ n: count() })
			.from(comments)
			.where(
				and(
					eq(comments.readerId, input.readerId),
					eq(comments.state, 'approved'),
					eq(comments.isDeleted, false)
				)
			);
		if (config.firstCommentHold && Number(history?.n ?? 0) === 0) {
			add({ ruleId: 'first-comment', outcome: 'hold', detail: {} });
		}
		if (config.linkThreshold > 0) {
			const links = countLinks(input.text);
			if (links >= config.linkThreshold) {
				add({ ruleId: 'link-count', outcome: 'hold', detail: { links } });
			}
		}
	}

	const applied = !config.shadowMode;
	const state = !applied
		? 'pending'
		: result.outcome === 'block'
			? 'rejected'
			: result.outcome === 'hold'
				? 'pending'
				: 'approved';
	return { state, applied, events };
}

/** Write the rule trail. A failed trail write must not lose the comment. */
export async function recordModerationEvents(
	commentId: string,
	decision: ModerationDecision | null
): Promise<void> {
	if (!decision || decision.events.length === 0) return;
	try {
		await db.insert(commentModerationEvents).values(
			decision.events.map((event) => ({
				commentId,
				source: 'rule' as const,
				ruleId: event.ruleId,
				outcome: event.outcome,
				applied: decision.applied,
				detail: event.detail
			}))
		);
	} catch (caught) {
		console.warn(
			'[comments] failed to record moderation events',
			caught instanceof Error ? caught.message : caught
		);
	}
}
