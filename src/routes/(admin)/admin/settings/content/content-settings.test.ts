import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Content actions re-check their tier (comments/friends/
 * presence/notes = admin, privacy = owner), write through setOption, and
 * record exactly one audit row with `deliver: false` (register R-7: settings
 * events never fan out to webhooks).
 */
const mocks = vi.hoisted(() => ({
	setOption: vi.fn(),
	recordActivity: vi.fn(),
	geoipConfigured: { value: true }
}));

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$lib/server/audit', () => ({ recordActivity: mocks.recordActivity }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => ({ enabled: false, ttlDays: 30 })),
	setOption: mocks.setOption
}));
vi.mock('$lib/server/security/geoip', () => ({
	isGeoipConfigured: () => mocks.geoipConfigured.value
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));

import { actions } from './+page.server';

function formEvent(values: Record<string, string | null>, role: 'owner' | 'admin' = 'admin') {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== null) body.append(key, value);
	}
	return {
		locals: { admin: { role }, user: { id: `${role}-1` } },
		request: new Request('http://localhost/admin/settings/content', {
			method: 'POST',
			body
		})
	} as never;
}

function action(name: keyof typeof actions) {
	return actions[name] as (event: never) => Promise<Record<string, unknown>>;
}

beforeEach(async () => {
	mocks.setOption.mockReset();
	mocks.recordActivity.mockClear();
	mocks.geoipConfigured.value = true;
	// Exercise the REAL registry validation (CIDR + TTL bounds) while keeping
	// the db write mocked: the action tests care about wiring, tiers and audit.
	const actual = await vi.importActual<{
		validateOption: (key: never, value: unknown) => unknown;
	}>('$lib/server/config/options-registry');
	mocks.setOption.mockImplementation(async (key: string, value: unknown) => {
		actual.validateOption(key as never, value);
	});
});

describe('content settings actions', () => {
	it('writes comments.enabled and audits without fan-out', async () => {
		const result = await action('saveComments')(formEvent({ enabled: 'on' }));
		expect(result).toEqual({ message: expect.any(String) });
		expect(mocks.setOption).toHaveBeenCalledWith('comments.enabled', true);
		expect(mocks.recordActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				event: 'comments.settings_update',
				deliver: false,
				payload: expect.objectContaining({ enabled: true })
			})
		);
	});

	it('denies comment privacy to an admin and allows the owner', async () => {
		await expect(
			action('savePrivacy')(formEvent({ retentionDays: '90' }, 'admin'))
		).rejects.toMatchObject({ status: 403 });
		expect(mocks.setOption).not.toHaveBeenCalled();
		const result = await action('savePrivacy')(
			formEvent(
				{
					enabled: 'on',
					collectCountry: 'on',
					showCountry: 'on',
					retentionDays: '30',
					blockedCidrs: '203.0.113.0/24\n2001:db8::/32'
				},
				'owner'
			)
		);
		expect(result).toEqual({ message: expect.any(String) });
		expect(mocks.setOption).toHaveBeenCalledWith('comments.privacy', {
			enabled: true,
			collectCountry: true,
			showCountry: true,
			retentionDays: 30,
			blockedCidrs: ['203.0.113.0/24', '2001:db8::/32']
		});
		expect(mocks.recordActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ event: 'privacy.update', deliver: false })
		);
	});

	it('coerces sub-switches off when the privacy master switch is off', async () => {
		await action('savePrivacy')(
			formEvent({ collectCountry: 'on', showCountry: 'on', retentionDays: '90' }, 'owner')
		);
		expect(mocks.setOption).toHaveBeenCalledWith('comments.privacy', {
			enabled: false,
			collectCountry: false,
			showCountry: false,
			retentionDays: 90,
			blockedCidrs: []
		});
	});

	it('rejects collectCountry without a configured provider', async () => {
		mocks.geoipConfigured.value = false;
		const result = await action('savePrivacy')(
			formEvent({ enabled: 'on', collectCountry: 'on', retentionDays: '90' }, 'owner')
		);
		expect(result).toMatchObject({ status: 400 });
		expect(mocks.setOption).not.toHaveBeenCalled();
	});

	it('rejects a malformed CIDR through the registry schema', async () => {
		const result = await action('savePrivacy')(
			formEvent({ enabled: 'on', retentionDays: '90', blockedCidrs: 'not-a-range' }, 'owner')
		);
		expect(result).toMatchObject({ status: 400 });
	});

	it('writes the friends policy and checks blocks', async () => {
		await action('saveFriendsApply')(formEvent({ enabled: 'on' }));
		expect(mocks.setOption).toHaveBeenCalledWith('friends.apply', {
			enabled: true,
			allowSubPath: false
		});

		await action('saveFriendsChecks')(
			formEvent({
				enabled: 'on',
				cadenceHours: '12',
				failStreak: '3',
				backlinkStreak: '2',
				graceDays: '30',
				timeoutMs: '10000',
				concurrency: '2'
			})
		);
		expect(mocks.setOption).toHaveBeenCalledWith('friends.checks', {
			enabled: true,
			cadenceHours: 12,
			failStreak: 3,
			backlinkStreak: 2,
			graceDays: 30,
			timeoutMs: 10000,
			concurrency: 2
		});

		await action('saveFriendsPolicy')(
			formEvent({
				blockedHostSuffixes: 'github.io\nvercel.app',
				blockedTlds: '.tk',
				acceptedBacklinkHosts: 'friend.example',
				publicBannedList: 'on'
			})
		);
		expect(mocks.setOption).toHaveBeenCalledWith('friends.policy', {
			blockedHostSuffixes: ['github.io', 'vercel.app'],
			blockedTlds: ['.tk'],
			acceptedBacklinkHosts: ['friend.example'],
			publicBannedList: true
		});

		const calls = mocks.recordActivity.mock.calls as unknown as [
			unknown,
			{ event: string; deliver: boolean }
		][];
		expect(calls.map(([, input]) => input.event)).toEqual([
			'friends.update',
			'friends.update',
			'friends.update'
		]);
		for (const [, input] of calls) expect(input.deliver).toBe(false);
	});

	it('writes the three presence switches together', async () => {
		await action('savePresence')(formEvent({ enabled: 'on', readerView: 'on' }));
		expect(mocks.setOption).toHaveBeenCalledWith('presence.enabled', true);
		expect(mocks.setOption).toHaveBeenCalledWith('presence.readerView', true);
		expect(mocks.setOption).toHaveBeenCalledWith('presence.readerDots', false);
		expect(mocks.recordActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ event: 'presence.update', deliver: false })
		);
	});

	it('writes the notes gate TTL and rejects out-of-range values', async () => {
		await action('saveNotesGate')(formEvent({ ttlDays: '7' }));
		expect(mocks.setOption).toHaveBeenCalledWith('notes.gate', { ttlDays: 7 });
		const result = await action('saveNotesGate')(formEvent({ ttlDays: '0' }));
		expect(result).toMatchObject({ status: 400 });
		expect(mocks.recordActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ event: 'notes_gate.update', deliver: false })
		);
	});
});
