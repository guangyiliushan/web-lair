import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the options registry (AI-1.1): defaults, validation on both
 * paths, unknown-key rejection and the defensive default clone. The db module
 * is mocked; the options table object is real so the fake executor can verify
 * the target table.
 */
const { dbMock, state, pgTz } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectRows: [] as unknown[][],
		insertCalls: [] as { values: unknown; conflict: Record<string, unknown> }[]
	},
	pgTz: { isPgAcceptableTimeZone: vi.fn(async () => true) }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
// Batch-5 closure: the site.timezone write consults pg_timezone_names.
vi.mock('$lib/server/pg-timezone', () => ({
	isPgAcceptableTimeZone: pgTz.isPgAcceptableTimeZone
}));

import { options } from '$lib/server/db/config';
import { getOption, optionKeys, setOption } from './options-registry';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return () => self;
			}
		}
	);
	return self;
}

describe('options registry (AI-1.1)', () => {
	beforeEach(() => {
		state.selectRows = [];
		state.insertCalls = [];
		pgTz.isPgAcceptableTimeZone.mockReset();
		pgTz.isPgAcceptableTimeZone.mockResolvedValue(true);
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectRows.shift() ?? [])),
			insert: vi.fn((table: unknown) => ({
				values: (values: unknown) => ({
					onConflictDoUpdate: async (conflict: Record<string, unknown>) => {
						if (table !== options) throw new Error('unexpected insert table');
						state.insertCalls.push({ values, conflict });
					}
				})
			}))
		});
	});

	it('ships exactly the planned keys (storage line adds media.purge; links adds friends.* / site.info)', () => {
		expect([...optionKeys].sort()).toEqual(
			[
				'ai.assignments',
				'ai.budget',
				'ai.styleGuide',
				'comments.moderation',
				'friends.apply',
				'friends.checks',
				'friends.policy',
				'media.purge',
				'notes.gate',
				'site.default_lang',
				'site.info',
				'site.languages',
				'site.timezone'
			].sort()
		);
	});

	it('falls back to defaults when no row exists (§3.3 ledger values)', async () => {
		state.selectRows = [[], [], [], [], []];
		await expect(getOption('site.default_lang')).resolves.toBe('en');
		await expect(getOption('site.timezone')).resolves.toBe('UTC');
		await expect(getOption('site.languages')).resolves.toEqual({
			enabled: ['en', 'zh-cn', 'ja']
		});
		await expect(getOption('comments.moderation')).resolves.toMatchObject({
			enabled: false,
			shadowMode: true,
			linkThreshold: 2,
			firstCommentHold: true,
			thresholds: { allow: 0.9, block: 0.95 }
		});
		await expect(getOption('media.purge')).resolves.toEqual({
			pendingDays: 7,
			detachedDays: 30
		});
	});

	it('returns a valid stored value as-is', async () => {
		state.selectRows = [[{ value: 'zh-cn' }]];
		await expect(getOption('site.default_lang')).resolves.toBe('zh-cn');
	});

	it('falls back to the default (with a warning) on a corrupt stored value', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		state.selectRows = [[{ value: 'fr' }]];
		await expect(getOption('site.default_lang')).resolves.toBe('en');
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('hands out fresh default copies (mutation-safe)', async () => {
		state.selectRows = [[], []];
		const first = await getOption('comments.moderation');
		first.keywords.push('mutated');
		const second = await getOption('comments.moderation');
		expect(second.keywords).toEqual([]);
	});

	it('rejects unknown keys on read and write', async () => {
		await expect(getOption('nope.option' as never)).rejects.toThrow(/Unknown option key/);
		await expect(setOption('nope.option' as never, 'x' as never)).rejects.toThrow(
			/Unknown option key/
		);
		expect(state.insertCalls).toHaveLength(0);
	});

	it('rejects invalid values before touching the database', async () => {
		await expect(setOption('site.default_lang', 'fr' as never)).rejects.toThrow();
		await expect(setOption('comments.moderation', { enabled: true } as never)).rejects.toThrow();
		expect(state.insertCalls).toHaveLength(0);
	});

	it('rejects non-positive or fractional media.purge TTLs', async () => {
		await expect(setOption('media.purge', { pendingDays: -1, detachedDays: 30 })).rejects.toThrow();
		await expect(setOption('media.purge', { pendingDays: 0, detachedDays: 30 })).rejects.toThrow();
		await expect(setOption('media.purge', { pendingDays: 7, detachedDays: 0 })).rejects.toThrow();
		await expect(
			setOption('media.purge', { pendingDays: 7.5, detachedDays: 30 })
		).rejects.toThrow();
		expect(state.insertCalls).toHaveLength(0);
	});

	it('accepts and persists a valid media.purge write (positive control)', async () => {
		state.selectRows = [];
		await setOption('media.purge', { pendingDays: 14, detachedDays: 60 });
		expect(state.insertCalls).toHaveLength(1);
		expect(state.insertCalls[0].values).toEqual({
			name: 'media.purge',
			value: { pendingDays: 14, detachedDays: 60 }
		});
	});

	it('enforces the allow < block ordering on thresholds', async () => {
		await expect(
			setOption('comments.moderation', {
				enabled: true,
				shadowMode: true,
				keywords: [],
				regexes: [],
				linkThreshold: 2,
				firstCommentHold: true,
				trustedUsers: [],
				thresholds: { allow: 0.99, block: 0.5 }
			})
		).rejects.toThrow(/放行阈值需小于拦截阈值/);
		expect(state.insertCalls).toHaveLength(0);
	});

	it('upserts a validated value keyed by name', async () => {
		await setOption('site.default_lang', 'ja');
		expect(state.insertCalls).toHaveLength(1);
		const [call] = state.insertCalls;
		expect(call.values).toEqual({ name: 'site.default_lang', value: 'ja' });
		expect(call.conflict.target).toBe(options.name);
		expect(call.conflict.set).toEqual({ value: 'ja' });
	});

	it('normalizes unknown fields away on write (schema strip)', async () => {
		await setOption('ai.styleGuide', { text: 'tone: dry', bogus: 1 } as never);
		expect(state.insertCalls[0].values).toEqual({
			name: 'ai.styleGuide',
			value: { text: 'tone: dry' }
		});
	});

	it('validates site.timezone as an IANA zone (default UTC)', async () => {
		await expect(setOption('site.timezone', 'Asia/Taipei')).resolves.toBeUndefined();
		expect(state.insertCalls[0].values).toEqual({
			name: 'site.timezone',
			value: 'Asia/Taipei'
		});
		// The write also consults the PostgreSQL zone set (batch-5 closure).
		expect(pgTz.isPgAcceptableTimeZone).toHaveBeenCalledWith('Asia/Taipei', undefined);
		await expect(setOption('site.timezone', 'Not/AZone' as never)).rejects.toThrow(
			/无效的 IANA 时区名/
		);
		await expect(setOption('site.timezone', ' Asia/Taipei ' as never)).rejects.toThrow();
		expect(state.insertCalls).toHaveLength(1);
	});

	it('rejects a zone Intl accepts but PostgreSQL rejects (batch-5 closure)', async () => {
		// 'Japan' passes the ICU probe (real-PG probe: AT TIME ZONE rejects it).
		pgTz.isPgAcceptableTimeZone.mockResolvedValueOnce(false);
		await expect(setOption('site.timezone', 'Japan')).rejects.toThrow(/不被 PostgreSQL 接受/);
		expect(state.insertCalls).toHaveLength(0);
	});

	it('does not consult pg_timezone_names for other keys', async () => {
		await setOption('site.default_lang', 'ja');
		expect(pgTz.isPgAcceptableTimeZone).not.toHaveBeenCalled();
	});

	it('ships the links friends / site.info keys with plan §2.6 defaults', async () => {
		state.selectRows = [[], [], [], []];
		await expect(getOption('friends.apply')).resolves.toEqual({
			enabled: true,
			allowSubPath: false,
			internalizeAvatars: false
		});
		await expect(getOption('friends.checks')).resolves.toEqual({
			enabled: true,
			cadenceHours: 24,
			failStreak: 3,
			backlinkStreak: 2,
			graceDays: 30,
			timeoutMs: 10000,
			concurrency: 2
		});
		const policy = await getOption('friends.policy');
		expect(policy.blockedHostSuffixes).toHaveLength(19);
		expect(policy.blockedTlds).toEqual(['.tk', '.ml', '.cf', '.ga', '.gq']);
		expect(policy.acceptedBacklinkHosts).toEqual([]);
		expect(policy.publicBannedList).toBe(true);
		await expect(getOption('site.info')).resolves.toEqual({
			name: 'Web Lair',
			description: '',
			avatar: ''
		});
	});

	it('rejects zero or too-small friends.checks knobs before touching the database', async () => {
		await expect(
			setOption('friends.checks', {
				enabled: true,
				cadenceHours: 0,
				failStreak: 3,
				backlinkStreak: 2,
				graceDays: 30,
				timeoutMs: 10000,
				concurrency: 2
			})
		).rejects.toThrow();
		await expect(
			setOption('friends.checks', {
				enabled: true,
				cadenceHours: 24,
				failStreak: 3,
				backlinkStreak: 2,
				graceDays: 30,
				timeoutMs: 500,
				concurrency: 2
			})
		).rejects.toThrow();
		expect(state.insertCalls).toHaveLength(0);
	});

	it('accepts a valid friends.checks write (positive control)', async () => {
		await setOption('friends.checks', {
			enabled: false,
			cadenceHours: 48,
			failStreak: 4,
			backlinkStreak: 3,
			graceDays: 14,
			timeoutMs: 15000,
			concurrency: 1
		});
		expect(state.insertCalls).toHaveLength(1);
		expect(state.insertCalls[0].values).toEqual({
			name: 'friends.checks',
			value: {
				enabled: false,
				cadenceHours: 48,
				failStreak: 4,
				backlinkStreak: 3,
				graceDays: 14,
				timeoutMs: 15000,
				concurrency: 1
			}
		});
	});
});
