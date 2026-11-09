import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	approvedCount: 0,
	option: {
		enabled: true,
		shadowMode: false,
		keywords: [] as string[],
		regexes: [] as string[],
		linkThreshold: 2,
		firstCommentHold: true,
		trustedUsers: [] as string[],
		thresholds: { allow: 0.9, block: 0.95 }
	}
}));

vi.mock('$lib/server/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: async () => [{ n: state.approvedCount }]
			})
		}),
		insert: () => ({ values: async () => undefined })
	}
}));

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async () => state.option
}));

const { evaluateCommentModeration, isSafeRegexPattern } = await import('./comment-moderation');

beforeEach(() => {
	state.approvedCount = 0;
	state.option = {
		enabled: true,
		shadowMode: false,
		keywords: [],
		regexes: [],
		linkThreshold: 2,
		firstCommentHold: true,
		trustedUsers: [],
		thresholds: { allow: 0.9, block: 0.95 }
	};
});

describe('comment moderation rules', () => {
	it('returns null when disabled', async () => {
		state.option.enabled = false;
		expect(
			await evaluateCommentModeration({ text: 'hello', readerId: 'u1', autoApprove: false })
		).toBeNull();
	});

	it('holds the first comment when the reader has no approved history', async () => {
		const decision = await evaluateCommentModeration({
			text: 'hello',
			readerId: 'u1',
			autoApprove: false
		});
		expect(decision?.state).toBe('pending');
		expect(decision?.applied).toBe(true);
		expect(decision?.events.some((event) => event.ruleId === 'first-comment')).toBe(true);
	});

	it('blocks a keyword match and holds two links', async () => {
		state.approvedCount = 3;
		state.option.keywords = ['casino'];
		const keyword = await evaluateCommentModeration({
			text: 'visit casino now',
			readerId: 'u1',
			autoApprove: false
		});
		expect(keyword?.state).toBe('rejected');
		const links = await evaluateCommentModeration({
			text: 'see https://a.example and https://b.example',
			readerId: 'u1',
			autoApprove: false
		});
		expect(links?.state).toBe('pending');
	});

	it('trusted users skip the first-comment/link heuristics', async () => {
		state.option.trustedUsers = ['u1'];
		const decision = await evaluateCommentModeration({
			text: 'see https://a.example and https://b.example',
			readerId: 'u1',
			autoApprove: false
		});
		expect(decision?.state).toBe('approved');
	});

	it('shadow mode records the decision without enforcing it', async () => {
		state.option.shadowMode = true;
		state.option.keywords = ['casino'];
		const decision = await evaluateCommentModeration({
			text: 'casino',
			readerId: 'u1',
			autoApprove: false
		});
		expect(decision?.state).toBe('pending');
		expect(decision?.applied).toBe(false);
	});

	it('skips catastrophic regex shapes', () => {
		expect(isSafeRegexPattern('(a+)+$')).toBe(false);
		expect(isSafeRegexPattern('(a|aa)+$')).toBe(false);
		// Known-bypass shapes (M2 review P0-4): nested quantifier behind a
		// bounded repeat, stacked unbounded quantifiers, unbounded {n,}.
		expect(isSafeRegexPattern('(a+){25}$')).toBe(false);
		expect(isSafeRegexPattern('.*.*.*!')).toBe(false);
		expect(isSafeRegexPattern('a*a*a*b')).toBe(false);
		expect(isSafeRegexPattern('a{2,}b')).toBe(false);
		expect(isSafeRegexPattern('\\k<name>')).toBe(false);
		// Legit moderation shapes stay available.
		expect(isSafeRegexPattern('casino')).toBe(true);
		expect(isSafeRegexPattern('https?://\\S+')).toBe(true);
		expect(isSafeRegexPattern('\\b(viagra|cialis)\\b')).toBe(true);
	});
});
