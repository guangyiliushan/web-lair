import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W6.11: `jobs.prune` clears the comment country/region snapshot after the
 * configured retention window. The ledger prunes are exercised incidentally
 * (they all run in the same tick); this test pins the privacy UPDATE: only
 * when `comments.privacy.enabled`, only rows older than retentionDays, and
 * exactly the privacy columns - never text or authorship.
 */
const mocks = vi.hoisted(() => ({
	updates: [] as { table: unknown; values: Record<string, unknown>; where: unknown }[],
	summaries: [] as Record<string, unknown>[],
	privacy: {
		enabled: true,
		collectCountry: true,
		showCountry: true,
		retentionDays: 30,
		blockedCidrs: [] as string[]
	}
}));

vi.mock('#jobs-sdk', () => ({
	activities: 'activities',
	aiAgentConversations: 'chats',
	aiUsage: 'usage',
	comments: {
		createdAt: 'comments.createdAt',
		countryCode: 'comments.countryCode',
		regionCode: 'comments.regionCode',
		location: 'comments.location',
		agent: 'comments.agent'
	},
	jobRuns: 'runs',
	webhookDeliveries: 'deliveries',
	and: (...conditions: unknown[]) => ({ and: conditions }),
	or: (...conditions: unknown[]) => ({ or: conditions }),
	lt: (left: unknown, right: unknown) => ({ lt: [left, right] }),
	inArray: (left: unknown, right: unknown) => ({ in: [left, right] }),
	isNotNull: (value: unknown) => ({ isNotNull: value }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		text: strings.join('?'),
		values
	}),
	getOption: vi.fn(async (key: string) =>
		key === 'comments.privacy' ? mocks.privacy : { retentionDays: 90 }
	),
	runTranslationsPrune: vi.fn(async () => 0)
}));

import pruneJob from './jobs-prune';

function makeCtx() {
	return {
		job: 'jobs.prune',
		trigger: 'manual' as const,
		db: {
			delete: () => ({
				where: () => ({
					returning: async () => []
				})
			}),
			update: (table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: (where: unknown) => ({
						returning: async () => {
							mocks.updates.push({ table, values, where });
							return [{ id: 'c1' }, { id: 'c2' }];
						}
					})
				})
			})
		},
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		summary: (data: Record<string, unknown>) => mocks.summaries.push(data)
	} as never;
}

beforeEach(() => {
	mocks.updates = [];
	mocks.summaries = [];
	mocks.privacy = {
		enabled: true,
		collectCountry: true,
		showCountry: true,
		retentionDays: 30,
		blockedCidrs: []
	};
});

describe('jobs.prune comment privacy retention', () => {
	it('nulls country/region/location/agent on rows past the window', async () => {
		await pruneJob.run(makeCtx());
		const privacyUpdate = mocks.updates.find((entry) => 'countryCode' in entry.values);
		expect(privacyUpdate).toBeDefined();
		expect(privacyUpdate?.values).toEqual({
			countryCode: null,
			regionCode: null,
			location: null,
			agent: null
		});
		const where = privacyUpdate?.where as { and?: unknown[] };
		// Both guards are present: the cutoff and "row still carries data".
		expect(where.and).toHaveLength(2);
		const cutoff = where.and?.[0] as { lt: [unknown, { text: string; values: number[] }] };
		expect(cutoff.lt[0]).toBe('comments.createdAt');
		expect(cutoff.lt[1].text).toContain('make_interval');
		expect(cutoff.lt[1].values).toEqual([30]);
		expect(mocks.summaries.at(-1)?.commentGeo).toBe(2);
	});

	it('skips the sweep entirely when comment privacy is off', async () => {
		mocks.privacy.enabled = false;
		await pruneJob.run(makeCtx());
		expect(mocks.updates.find((entry) => 'countryCode' in entry.values)).toBeUndefined();
		expect(mocks.summaries.at(-1)?.commentGeo).toBe(0);
	});
});
