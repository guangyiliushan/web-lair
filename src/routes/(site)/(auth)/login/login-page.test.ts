import { describe, expect, it, vi } from 'vitest';

/**
 * The sign-in page is the landing spot for both the reset success marker and
 * the OAuth error codes; a wrong ternary would silently drop the only admin
 * explanation. No DB or auth API is touched by the load.
 */
vi.mock('$lib/server/auth', () => ({ auth: { api: {} } }));

import { load } from './+page.server';

type LoadResult = { resetSuccess: boolean; oauthError: 'admin_blocked' | 'failed' | null };

function callLoad(url: string, user: unknown = null) {
	const result = (load as (event: never) => unknown)({
		locals: { user },
		url: new URL(url)
	} as never);
	return result as LoadResult;
}

describe('login page load', () => {
	it('renders no banner on a plain visit', () => {
		expect(callLoad('http://localhost/login')).toEqual({
			resetSuccess: false,
			oauthError: null
		});
	});

	it('maps the reset success marker', () => {
		expect(callLoad('http://localhost/login?message=password-reset-success')).toEqual({
			resetSuccess: true,
			oauthError: null
		});
	});

	it('maps the admin/GitHub refusal to its own explanation', () => {
		expect(callLoad('http://localhost/login?error=admin_github_sign_in_blocked')).toEqual({
			resetSuccess: false,
			oauthError: 'admin_blocked'
		});
	});

	it('falls back to the generic message for any other OAuth error', () => {
		expect(callLoad('http://localhost/login?error=state_not_found')).toEqual({
			resetSuccess: false,
			oauthError: 'failed'
		});
	});
});
