import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W4.8/R-7: profile.update and home.update are local audit rows. They must
 * carry no `refType`/`refId` (activities.ref_id is a uuid while auth user ids
 * are text) and must set `deliver: false` so they never fan out to webhook
 * endpoints. The events are outside WEBHOOK_EVENT_ROSTER by design.
 */
const { recordActivity } = vi.hoisted(() => ({ recordActivity: vi.fn(async () => {}) }));

vi.mock('$lib/server/audit', () => ({ recordActivity }));

import { saveHomeHero, saveOwnerProfile } from './owner-profile';

const OWNER = 'owner-1';

const PROFILE = {
	displayName: 'guangyiliushan',
	headerLabel: 'guang',
	avatarUrl: 'https://example.com/a.png',
	links: null
};

function fakeExecutor(updated: Record<string, unknown>) {
	let selectIndex = 0;
	const selects: unknown[][] = [
		[{ ownerUserId: OWNER }],
		[{ id: OWNER, role: 'owner' }],
		[PROFILE],
		[{ title: {}, subtitlePrefix: {}, subtitleHighlight: {}, description: {}, welcome: {} }]
	];
	const tx: Record<string, unknown> = {};
	tx.select = vi.fn(() => {
		const chain: Record<string, unknown> = {};
		const result = selects[selectIndex++] ?? [];
		chain.from = () => chain;
		chain.innerJoin = () => chain;
		chain.leftJoin = () => chain;
		chain.where = () => chain;
		chain.limit = async () => result;
		return chain;
	});
	tx.update = vi.fn(() => ({
		set: () => ({
			where: () => ({
				returning: async () => [updated]
			})
		})
	}));
	tx.insert = vi.fn(() => ({
		values: () => ({
			onConflictDoUpdate: async () => {}
		})
	}));
	return {
		transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(tx)
	} as unknown as Parameters<typeof saveOwnerProfile>[1]['executor'];
}

describe('owner profile audit rows', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('writes profile.update without refs and without webhook fan-out', async () => {
		const executor = fakeExecutor({
			displayName: 'guangyiliushan',
			headerLabel: 'shan',
			avatarUrl: null,
			links: null
		});

		await saveOwnerProfile(
			{ displayName: 'guangyiliushan', headerLabel: 'shan' },
			{
				actorId: OWNER,
				executor
			}
		);

		expect(recordActivity).toHaveBeenCalledTimes(1);
		const [tx, input] = recordActivity.mock.calls[0] as unknown as [
			unknown,
			Record<string, unknown>
		];
		expect(tx).toBeDefined();
		expect(input).toMatchObject({
			event: 'profile.update',
			actorId: OWNER,
			deliver: false
		});
		expect(input).not.toHaveProperty('refType');
		expect(input).not.toHaveProperty('refId');
		expect((input.payload as { fields: string[] }).fields).toEqual([
			'display_name',
			'header_label',
			'avatar_url',
			'links'
		]);
	});

	it('writes home.update without refs and without webhook fan-out', async () => {
		const executor = fakeExecutor({});

		await saveHomeHero({ title: { en: 'Hello {name}' } }, { actorId: OWNER, executor });

		expect(recordActivity).toHaveBeenCalledTimes(1);
		const [, input] = recordActivity.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
		expect(input).toMatchObject({
			event: 'home.update',
			actorId: OWNER,
			deliver: false
		});
		expect(input).not.toHaveProperty('refType');
		expect(input).not.toHaveProperty('refId');
	});
});
