import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One-time setup token.
 *
 * The old guard only asked "does an admin exist?", which becomes true again if
 * the user table is emptied. The durable `admin.setup_complete` audit row is
 * the receipt that closes that hole; this pins both the refusal and the write.
 */
const state = vi.hoisted(() => ({
	activityRows: [] as unknown[],
	hasAdmin: false,
	recordActivity: vi.fn(async () => undefined),
	signUpEmail: vi.fn(async () => ({ user: { id: 'user-1' } })),
	signInEmail: vi.fn(async () => ({ token: null })),
	claimOwner: vi.fn(async () => true)
}));

vi.mock('$lib/server/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => state.activityRows
				})
			})
		}),
		delete: () => ({ where: async () => undefined })
	}
}));
vi.mock('$lib/server/db/auth.schema', () => ({ user: { id: 'user.id' } }));
vi.mock('$lib/server/db/system', () => ({ activities: { id: 'activities.id', event: 'event' } }));
vi.mock('$lib/server/auth', () => ({
	auth: {
		api: { signUpEmail: state.signUpEmail, signInEmail: state.signInEmail }
	}
}));
vi.mock('$lib/server/audit', () => ({ recordActivity: state.recordActivity }));
vi.mock('$lib/server/config/admin', () => ({
	ADMIN_HOME_PATH: '/admin/dashboard',
	getAdminConfig: () => ({
		setupToken: 'setup-token-0123456789',
		loginPath: '/admin/login',
		loginSlug: 'login',
		twoFactorPath: '/admin/two-factor'
	})
}));
vi.mock('$lib/server/auth/owner', () => ({
	hasAnyAdminAccount: vi.fn(async () => state.hasAdmin),
	claimOwnerRole: state.claimOwner
}));
vi.mock('$lib/server/auth/site-organization-bootstrap', () => ({
	ensureSiteOrganization: vi.fn(async () => undefined)
}));
vi.mock('$lib/server/cache', () => ({ getCache: () => ({}) }));
vi.mock('$lib/server/cache/store', () => ({ rateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('$lib/server/security/request-address', () => ({ requestAddress: () => '127.0.0.1' }));

import { actions, load } from './+page.server';

function setupEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/setup', { method: 'POST', body }),
		getClientAddress: () => '127.0.0.1',
		locals: { user: null }
	};
}

const VALID_FORM = {
	name: 'Owner',
	email: 'owner@example.com',
	password: 'correct horse battery staple',
	setupToken: 'setup-token-0123456789'
};

beforeEach(() => {
	state.activityRows = [];
	state.hasAdmin = false;
	vi.clearAllMocks();
});

describe('one-time setup token', () => {
	it('load reports a consumed bootstrap even with no admin row', async () => {
		state.activityRows = [{ id: 'activity-1' }];
		const data = (await load({} as never)) as { setupConsumed: boolean };
		expect(data.setupConsumed).toBe(true);
	});

	it('refuses a replay with 403 and never creates an account', async () => {
		state.activityRows = [{ id: 'activity-1' }];
		const result = (await (
			actions as never as Record<string, (event: never) => Promise<unknown>>
		).setup(setupEvent(VALID_FORM) as never)) as { status: number };
		expect(result).toMatchObject({ status: 403 });
		expect(state.signUpEmail).not.toHaveBeenCalled();
	});

	it('refuses a wrong token with 403 and never creates an account', async () => {
		state.activityRows = [];
		state.hasAdmin = false;
		const result = (await (
			actions as never as Record<string, (event: never) => Promise<unknown>>
		).setup(setupEvent({ ...VALID_FORM, setupToken: 'wrong-token' }) as never)) as {
			status: number;
		};
		expect(result).toMatchObject({ status: 403 });
		expect(state.signUpEmail).not.toHaveBeenCalled();
		expect(state.signInEmail).not.toHaveBeenCalled();
		expect(state.recordActivity).not.toHaveBeenCalled();
	});

	it('writes the fingerprint marker before signing in (no token in the payload)', async () => {
		// No marker yet: claim succeeds, then sign-in redirects.
		await expect(
			(actions as never as Record<string, (event: never) => Promise<unknown>>).setup(
				setupEvent(VALID_FORM) as never
			)
		).rejects.toMatchObject({ status: 303 });

		expect(state.signUpEmail).toHaveBeenCalledTimes(1);
		expect(state.signInEmail).toHaveBeenCalledTimes(1);
		expect(state.recordActivity).toHaveBeenCalledTimes(1);
		const [, activity] = state.recordActivity.mock.calls[0] as unknown as [
			unknown,
			{ event: string; deliver: boolean; payload: Record<string, unknown> }
		];
		expect(activity.event).toBe('admin.setup_complete');
		expect(activity.deliver).toBe(false);
		expect(activity.payload.tokenFingerprint).toMatch(/^[0-9a-f]{8}$/);
		expect(JSON.stringify(activity.payload)).not.toContain(VALID_FORM.setupToken);
	});
});
