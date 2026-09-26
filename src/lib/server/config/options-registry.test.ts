import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for the options registry (AI-1.1): defaults, validation on both
 * paths, unknown-key rejection and the defensive default clone. The db module
 * is mocked; the options table object is real so the fake executor can verify
 * the target table.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectRows: [] as unknown[][],
		insertCalls: [] as { values: unknown; conflict: Record<string, unknown> }[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));

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

	it('ships exactly the six planned keys', () => {
		expect([...optionKeys].sort()).toEqual(
			[
				'ai.assignments',
				'ai.budget',
				'ai.styleGuide',
				'comments.moderation',
				'site.default_lang',
				'site.languages'
			].sort()
		);
	});

	it('falls back to defaults when no row exists (§3.3 ledger values)', async () => {
		state.selectRows = [[], [], []];
		await expect(getOption('site.default_lang')).resolves.toBe('en');
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
});
