import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Public friends route: load wiring for the three zones + site.info, and the
 * application action's honeypot/refusal/status mapping. The service and registry
 * are mocked; their own rules are covered by `src/lib/server/links/apply.test.ts`.
 */
const { optionState, applyMock, listMock, scheduleState } = vi.hoisted(() => {
	const optionState: Record<string, unknown> = {};
	const applyMock = vi.fn();
	const listMock = vi.fn();
	const scheduleState: { rows: { job: string; enabled: boolean }[] } = { rows: [] };
	return { optionState, applyMock, listMock, scheduleState };
});

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: async (key: string) => optionState[key]
}));
vi.mock('$lib/server/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: async () => scheduleState.rows
			})
		})
	}
}));
vi.mock('$lib/server/db/system/job-schedule.schema', () => ({
	jobSchedules: { job: 'job', isEnabled: 'is_enabled' }
}));
vi.mock('$lib/server/links/apply', () => ({ applyForLink: applyMock }));
vi.mock('$lib/server/links/public', () => ({
	listPublicFriends: listMock,
	safeHttpsUrl: (value: string | null) =>
		value && new URL(value).protocol === 'https:' ? value : null
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy(
		{},
		{
			get: (_target, key) => () => `msg:${String(key)}`
		}
	)
}));

import { actions, load } from './+page.server';

interface LoadResult {
	applyEnabled: boolean;
	siteInfo: { name: string; description: string; avatar: string | null };
	policyFacts: {
		graceDays: number;
		failStreak: number;
		backlinkStreak: number;
		checksEnabled: boolean;
		checksScheduled: boolean;
		pruneScheduled: boolean;
		allowSubPath: boolean;
		blockedHostSuffixes: string[];
		blockedTlds: string[];
		publicBannedList: boolean;
		emailRetentionDays: number;
	};
}

function loadData(): Promise<LoadResult> {
	return load({} as Parameters<typeof load>[0]) as Promise<LoadResult>;
}

function event(fields: Record<string, string>, ip = '203.0.113.7') {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/zh-cn/friends', { method: 'POST', body }),
		getClientAddress: () => ip,
		url: new URL('http://localhost/zh-cn/friends')
	} as unknown as Parameters<typeof actions.default>[0];
}

const validFields = {
	name: 'Example',
	url: 'https://example.com',
	backlinkUrl: 'https://example.com/links',
	email: 'owner@example.com',
	consent: 'on'
};

beforeEach(() => {
	optionState['friends.apply'] = {
		enabled: true,
		allowSubPath: false
	};
	optionState['friends.policy'] = {
		blockedHostSuffixes: [],
		blockedTlds: [],
		acceptedBacklinkHosts: [],
		publicBannedList: true
	};
	optionState['site.info'] = {
		name: 'Web Lair',
		description: 'Notes and experiments',
		avatar: 'https://cdn.example/avatar.png'
	};
	delete optionState['site.icon'];
	optionState['friends.checks'] = {
		enabled: true,
		cadenceHours: 24,
		failStreak: 3,
		backlinkStreak: 2,
		graceDays: 30,
		timeoutMs: 10000,
		concurrency: 2
	};
	scheduleState.rows = [
		{ job: 'links.check', enabled: true },
		{ job: 'links.prune', enabled: true }
	];
	listMock.mockReset();
	listMock.mockResolvedValue({ approved: [], outdated: [], banned: [] });
	applyMock.mockReset();
	applyMock.mockResolvedValue({ kind: 'pending', id: 'id-1' });
});

describe('friends load', () => {
	it('reads the public list with the published-ban switch and filters the avatar', async () => {
		const data = await loadData();
		expect(listMock).toHaveBeenCalledWith({ publicBannedList: true });
		expect(data.applyEnabled).toBe(true);
		expect(data.siteInfo).toEqual({
			name: 'Web Lair',
			description: 'Notes and experiments',
			avatar: 'https://cdn.example/avatar.png'
		});
	});

	it('exposes the policy facts the public copy renders', async () => {
		optionState['friends.policy'] = {
			blockedHostSuffixes: ['github.io'],
			blockedTlds: ['.tk'],
			acceptedBacklinkHosts: [],
			publicBannedList: true
		};
		const data = await loadData();
		expect(data.policyFacts).toEqual({
			graceDays: 30,
			failStreak: 3,
			backlinkStreak: 2,
			checksEnabled: true,
			checksScheduled: true,
			pruneScheduled: true,
			allowSubPath: false,
			blockedHostSuffixes: ['github.io'],
			blockedTlds: ['.tk'],
			publicBannedList: true,
			emailRetentionDays: 90
		});
	});

	it('reports unscheduled or disabled jobs so the policy cannot overpromise', async () => {
		scheduleState.rows = [{ job: 'links.check', enabled: false }];
		const data = await loadData();
		expect(data.policyFacts.checksScheduled).toBe(false);
		expect(data.policyFacts.pruneScheduled).toBe(false);
	});

	it('drops a non-https site.info avatar and hides banned rows when the policy says so', async () => {
		optionState['friends.policy'] = {
			blockedHostSuffixes: [],
			blockedTlds: [],
			acceptedBacklinkHosts: [],
			publicBannedList: false
		};
		optionState['site.info'] = {
			name: 'Web Lair',
			description: '',
			avatar: 'http://cdn.example/avatar.png'
		};
		const data = await loadData();
		expect(listMock).toHaveBeenCalledWith({ publicBannedList: false });
		expect(data.siteInfo.avatar).toBeNull();
	});

	it('keeps the card identity limited to site.info; the favicon never becomes a card avatar (S5)', async () => {
		optionState['site.icon'] = {
			url: 'https://cdn.example/favicon.svg',
			version: 2
		};
		const data = await loadData();
		expect(Object.keys(data.siteInfo).sort()).toEqual(['avatar', 'description', 'name']);
		expect(data.siteInfo.avatar).toBe('https://cdn.example/avatar.png');
		expect(JSON.stringify(data.siteInfo)).not.toContain('favicon');
	});
});

describe('friends apply action', () => {
	it('silently accepts the honeypot without calling the service', async () => {
		expect(await actions.default(event({ ...validFields, website: 'bot' }))).toEqual({
			success: true
		});
		expect(applyMock).not.toHaveBeenCalled();
	});

	it('passes the parsed application (consent on) to the service', async () => {
		expect(await actions.default(event(validFields))).toEqual({ success: true });
		expect(applyMock).toHaveBeenCalledWith(
			{
				name: 'Example',
				url: 'https://example.com',
				avatar: '',
				description: '',
				email: 'owner@example.com',
				backlinkUrl: 'https://example.com/links',
				consent: true
			},
			{ address: '203.0.113.7' }
		);
	});

	it('treats an unchecked consent box as false', async () => {
		const withoutConsent = {
			name: 'Example',
			url: 'https://example.com',
			backlinkUrl: 'https://example.com/links',
			email: 'owner@example.com'
		};
		await actions.default(event(withoutConsent));
		expect(applyMock.mock.calls[0][0].consent).toBe(false);
	});

	it('maps an auditable hard-gate refusal to 400 with the public reason', async () => {
		applyMock.mockResolvedValue({ kind: 'rejected', id: null, code: 'blocked-host' });
		const result = await actions.default(event(validFields));
		expect(result).toMatchObject({ status: 400 });
		expect(result?.data.message).toBe('msg:friends_apply_err_blocked_host');
	});

	it('maps duplicate and rate-limit outcomes to their statuses', async () => {
		applyMock.mockResolvedValue({ kind: 'error', code: 'duplicate' });
		const duplicate = await actions.default(event(validFields));
		expect(duplicate).toMatchObject({ status: 400 });
		expect(duplicate?.data.message).toBe('msg:friends_apply_err_duplicate');

		applyMock.mockResolvedValue({ kind: 'error', code: 'rate-limited' });
		const limited = await actions.default(event(validFields));
		expect(limited).toMatchObject({ status: 429 });
		expect(limited?.data.message).toBe('msg:friends_apply_err_rate');
	});

	it('keeps the submitted values on an error so the form does not reset', async () => {
		applyMock.mockResolvedValue({ kind: 'error', code: 'url-subpath' });
		const result = await actions.default(event(validFields));
		expect(result?.data.values).toMatchObject({
			name: 'Example',
			url: 'https://example.com',
			email: 'owner@example.com'
		});
	});
});
