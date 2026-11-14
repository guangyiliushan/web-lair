import { beforeEach, describe, expect, it, vi } from 'vitest';

const { originState, envState } = vi.hoisted(() => ({
	originState: { origin: 'https://example.com' as string | null },
	envState: { env: {} as Record<string, string | undefined> }
}));

vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$lib/server/db', () => ({ db: { transaction: vi.fn() } }));
vi.mock('$lib/server/audit', () => ({ recordActivity: vi.fn() }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async (key: string) => {
		if (key === 'site.info') return { name: 'Site', description: '', avatar: '' };
		if (key === 'site.languages') return { enabled: ['en', 'zh-cn', 'ja'] };
		if (key === 'site.default_lang') return 'en';
		if (key === 'site.timezone') return 'UTC';
		if (key === 'site.icon') return { url: '', version: 0 };
		throw new Error(`unexpected option ${key}`);
	}),
	setOption: vi.fn(),
	validateOption: vi.fn((_key: string, value: unknown) => value),
	OptionWriteError: class OptionWriteError extends Error {}
}));
vi.mock('$lib/server/config/admin', () => ({ ADMIN_BASE_PATH: '/admin' }));
vi.mock('$lib/server/origin', () => ({ getPublicOrigin: () => originState.origin }));
vi.mock('$env/dynamic/private', () => envState);

import { load } from './+page.server';

describe('Site deployment status', () => {
	beforeEach(() => {
		originState.origin = 'https://example.com';
		envState.env = {};
	});

	it('reads ORIGIN, admin path, NODE_ENV and version without any input control', async () => {
		envState.env.APP_VERSION = '9.9.9';
		const data = (await load({
			locals: { admin: { role: 'owner' } }
		} as never)) as {
			deployment: {
				origin: string | null;
				adminPath: string;
				environment: string;
				version: string;
			};
		};
		expect(data.deployment).toEqual({
			origin: 'https://example.com',
			adminPath: '/admin',
			environment: expect.any(String),
			version: '9.9.9'
		});
	});

	it('falls back to the package version when APP_VERSION is unset and keeps a null ORIGIN', async () => {
		originState.origin = null;
		const data = (await load({
			locals: { admin: { role: 'owner' } }
		} as never)) as {
			deployment: { origin: string | null; version: string };
		};
		expect(data.deployment.origin).toBeNull();
		expect(data.deployment.version).toBe('0.0.1');
	});

	it('exposes granular edit flags: admin edits identity/icon/timezone but not languages', async () => {
		const data = (await load({
			locals: { admin: { role: 'admin' } }
		} as never)) as {
			canEditInfo: boolean;
			canEditIcon: boolean;
			canEditTimezone: boolean;
			canEditLanguages: boolean;
			icon: { url: string; version: number };
		};
		expect(data.canEditInfo).toBe(true);
		expect(data.canEditIcon).toBe(true);
		expect(data.canEditTimezone).toBe(true);
		expect(data.canEditLanguages).toBe(false);
		expect(data.icon).toEqual({ url: '', version: 0 });
	});
});
