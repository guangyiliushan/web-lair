import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock } = vi.hoisted(() => ({
	envMock: {
		ADMIN_LOGIN_SLUG: '',
		ADMIN_SETUP_TOKEN: ''
	} as Record<string, string>
}));

vi.mock('$env/dynamic/private', () => ({ env: envMock }));

import { ADMIN_BASE_PATH, assertAdminSlug, getAdminConfig, isAdminPath } from './admin';

describe('admin config', () => {
	beforeEach(() => {
		envMock.ADMIN_LOGIN_SLUG = '';
		envMock.ADMIN_SETUP_TOKEN = '';
	});

	it('falls back to the built-in slug and composes the two-factor path', () => {
		const config = getAdminConfig();
		expect(config.loginSlug).toBe('secure-9x7k2q');
		expect(config.loginPath).toBe(`${ADMIN_BASE_PATH}/secure-9x7k2q/login`);
		expect(config.twoFactorPath).toBe(`${ADMIN_BASE_PATH}/secure-9x7k2q/two-factor`);
	});

	it('normalizes a configured slug (trim + strip slashes)', () => {
		envMock.ADMIN_LOGIN_SLUG = '  /custom-slug/ ';
		const config = getAdminConfig();
		expect(config.loginSlug).toBe('custom-slug');
		expect(config.loginPath).toBe('/admin/custom-slug/login');
	});

	it('matches the admin base path only on segment boundaries', () => {
		expect(isAdminPath('/admin')).toBe(true);
		expect(isAdminPath('/admin/comments')).toBe(true);
		expect(isAdminPath('/administrator')).toBe(false);
		expect(isAdminPath('/')).toBe(false);
	});

	it('assertAdminSlug returns the config for the right slug and 404s otherwise', () => {
		envMock.ADMIN_LOGIN_SLUG = 'secret';
		expect(assertAdminSlug('secret').loginPath).toBe('/admin/secret/login');

		let thrown: unknown;
		try {
			assertAdminSlug('wrong');
		} catch (caught) {
			thrown = caught;
		}
		expect((thrown as { status?: number } | undefined)?.status).toBe(404);
	});
});
