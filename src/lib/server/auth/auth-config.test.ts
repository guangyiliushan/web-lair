import { describe, expect, it, vi } from 'vitest';

/**
 * The W1 security options are inert if auth.ts stops wiring them; the unit
 * specs for the policy module alone cannot see that. `betterAuth` is captured
 * as a plain options object (no adapter/context init), so this pins exactly the
 * config auth.ts hands to better-auth.
 */
vi.mock('better-auth/minimal', () => ({
	betterAuth: (options: Record<string, unknown>) => ({ options })
}));
vi.mock('$env/dynamic/private', () => ({
	env: {
		ORIGIN: 'http://localhost:4173',
		BETTER_AUTH_SECRET: 'unit-test-secret-0123456789abcdef',
		GITHUB_CLIENT_ID: '',
		GITHUB_CLIENT_SECRET: ''
	}
}));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/db/auth.schema', () => ({ verification: {} }));
vi.mock('$lib/server/db/account/user-profile.schema', () => ({ userProfiles: {} }));
vi.mock('$lib/server/mail/transport', () => ({ sendMailOrDevLog: vi.fn() }));
vi.mock('$lib/server/auth/site-organization', () => ({
	getSiteOrganizationId: vi.fn(async () => null)
}));
vi.mock('$lib/server/auth/tailscale-plugin', () => ({
	tailscaleSignIn: () => ({ id: 'tailscale' })
}));
vi.mock('@better-auth/drizzle-adapter', () => ({
	drizzleAdapter: () => ({ id: 'test-adapter' })
}));

import { auth } from '../auth';
import { validateUserProvisioning } from './admin-login-policy';
import { hashAccountPassword, verifyAccountPassword } from './password';

interface AuthOptions {
	user?: { validateUserInfo?: unknown; additionalFields?: Record<string, unknown> };
	account?: { encryptOAuthTokens?: unknown };
	database?: unknown;
	onAPIError?: { errorURL?: unknown };
	emailAndPassword?: {
		revokeSessionsOnPasswordReset?: unknown;
		onPasswordReset?: unknown;
		password?: { hash?: unknown; verify?: unknown };
	};
	session?: { expiresIn?: unknown; updateAge?: unknown };
}

describe('auth config security wiring', () => {
	it('keeps the admin GitHub gate, OAuth encryption, reset revocation and error URL wired', () => {
		const options = auth.options as AuthOptions;

		expect(options.user?.validateUserInfo).toBe(validateUserProvisioning);
		expect(options.account?.encryptOAuthTokens).toBe(true);
		expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
		expect(typeof options.emailAndPassword?.onPasswordReset).toBe('function');
		expect(options.onAPIError?.errorURL).toBe('/login');
	});

	it('declares the app-owned user field through the official option (H2)', () => {
		// `default_lang` must come from `additionalFields`, not a hand edit to
		// auth.schema.ts - that is what makes `pnpm auth:schema` reproducible.
		const options = auth.options as AuthOptions;
		expect(options.user?.additionalFields).toEqual({
			defaultLang: { type: 'string', required: false, input: false }
		});
		// The adapter stays the official drizzle adapter (mocked by id): no
		// wrapper that would change better-auth's own storage semantics (H3).
		expect(options.database).toEqual({ id: 'test-adapter' });
	});

	it('wires the W8.8 password hash/verify hooks and the 30-day/24-hour session policy', () => {
		const options = auth.options as AuthOptions;
		expect(options.emailAndPassword?.password?.hash).toBe(hashAccountPassword);
		expect(options.emailAndPassword?.password?.verify).toBe(verifyAccountPassword);
		expect(options.session).toEqual({
			expiresIn: 30 * 24 * 60 * 60,
			updateAge: 24 * 60 * 60
		});
	});
});
