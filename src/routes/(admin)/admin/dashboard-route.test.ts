import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin dashboard load (realtime R4, register E1):
 * the guard runs first, the five quick-action counters read real rows, and
 * the realtime cards carry the presence SSR initial values - read only while
 * presence is enabled, `null` (the "—" fallback) when it is off or when the
 * cache read degrades. The db keeps the pages-list recording-chain shape:
 * five selects answer from the queue, in call order.
 */
const { dbMock, state, service, presenceService } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		presenceEnabled: true
	},
	service: { requireAdminRole: vi.fn() },
	presenceService: { readSitePresence: vi.fn() }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));
vi.mock('$lib/server/services/presence', () => ({
	readSitePresence: presenceService.readSitePresence
}));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) => {
		if (key === 'presence.enabled') return state.presenceEnabled;
		throw new Error(`unexpected option key: ${key}`);
	})
}));

import { load } from './+page.server';

function selectChain(): Record<string, unknown> {
	const chain: Record<string, unknown> = {};
	const ret = () => chain;
	Object.assign(chain, {
		from: ret,
		where: ret,
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return chain;
}

beforeEach(() => {
	state.selectQueue = [
		[{ count: 7 }],
		[{ count: 3 }],
		[{ count: 2 }],
		[{ count: 5 }],
		[{ count: 1 }]
	];
	state.presenceEnabled = true;
	service.requireAdminRole.mockClear();
	presenceService.readSitePresence.mockReset();
	presenceService.readSitePresence.mockResolvedValue(null);
	Object.assign(dbMock, { select: vi.fn(() => selectChain()) });
});

describe('admin dashboard load (realtime R4)', () => {
	it('reads real counters and the presence initial values', async () => {
		presenceService.readSitePresence.mockResolvedValue({ site: 5, day: 17, peak: 9 });

		const data = (await load({} as never)) as {
			counts: Record<string, number>;
			presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null };
		};

		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.counts).toEqual({ posts: 7, notes: 3, quotes: 2, thoughts: 5, moments: 1 });
		expect(data.presence).toEqual({ enabled: true, site: 5, day: 17, peak: 9 });
	});

	it('degrades to nulls when the cache read is unavailable (cards get "—")', async () => {
		const data = (await load({} as never)) as {
			presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null };
		};
		expect(data.presence).toEqual({ enabled: true, site: null, day: null, peak: null });
	});

	it('skips the presence read entirely when presence is disabled', async () => {
		state.presenceEnabled = false;

		const data = (await load({} as never)) as {
			presence: { enabled: boolean; site: number | null; day: number | null; peak: number | null };
		};

		expect(presenceService.readSitePresence).not.toHaveBeenCalled();
		expect(data.presence).toEqual({ enabled: false, site: null, day: null, peak: null });
	});
});
