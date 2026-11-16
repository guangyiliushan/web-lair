import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from 'better-auth/api';

/**
 * The reset route never answers 404 — missing, expired or used tokens render the
 * recovery state — and a successful reset redirects to sign-in with the success
 * marker.
 */
const { resetMock } = vi.hoisted(() => ({ resetMock: vi.fn() }));

vi.mock('$lib/server/auth', () => ({ auth: { api: { resetPassword: resetMock } } }));
vi.mock('$lib/paraglide/messages', () => ({
	m: {
		auth_reset_err_invalid_token: () => 'err-invalid-token',
		auth_reset_err_mismatch: () => 'err-mismatch',
		auth_reset_err_required: () => 'err-required',
		auth_reset_err_short: () => 'err-short',
		auth_reset_err_unexpected: () => 'err-unexpected'
	}
}));

import { actions, load } from './+page.server';

type ResetAction = NonNullable<typeof actions.reset>;

function loadEvent(url: string) {
	return {
		url: new URL(url),
		setHeaders: vi.fn()
	};
}

function callLoad(url: string) {
	const result = (load as (event: never) => unknown)(loadEvent(url) as never);
	return result as { state: string; token: string };
}

function event(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://localhost/reset-password', { method: 'POST', body }),
		url: new URL('http://localhost/reset-password')
	};
}

function call(fields: Record<string, string>) {
	return (actions.reset as ResetAction)(event(fields) as never);
}

async function callCatching(fields: Record<string, string>) {
	try {
		return { result: await call(fields), thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	resetMock.mockResolvedValue({ status: true });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('reset-password load', () => {
	it('asks for the new password when the callback supplied a token', () => {
		expect(callLoad('http://localhost/reset-password?token=tok_1')).toEqual({
			state: 'form',
			token: 'tok_1'
		});
	});

	it('renders the recovery state instead of a 404 for a bare visit', () => {
		expect(callLoad('http://localhost/reset-password')).toEqual({
			state: 'invalid',
			token: ''
		});
	});

	it('renders the recovery state for an expired link (error=INVALID_TOKEN)', () => {
		expect(callLoad('http://localhost/reset-password?error=INVALID_TOKEN')).toEqual({
			state: 'invalid',
			token: ''
		});
	});

	it('keeps the token URL out of the Referer', () => {
		const event = loadEvent('http://localhost/reset-password?token=tok_1');
		(load as (event: never) => unknown)(event as never);
		expect(event.setHeaders).toHaveBeenCalledWith({ 'referrer-policy': 'strict-origin' });
	});
});

describe('reset-password action', () => {
	it('rejects a missing token with the recovery marker', async () => {
		const result = (await call({ token: '', password: 'new-password-1' })) as {
			status: number;
			data: { message: string; errorCode: string };
		};
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ message: 'err-invalid-token', errorCode: 'invalid_token' });
		expect(resetMock).not.toHaveBeenCalled();
	});

	it('rejects an empty or mismatched confirmation before calling better-auth', async () => {
		const missing = (await call({ token: 'tok_1', password: 'new-password-1' })) as {
			status: number;
			data: { message: string };
		};
		expect(missing.status).toBe(400);
		expect(missing.data.message).toBe('err-required');

		const mismatch = (await call({
			token: 'tok_1',
			password: 'new-password-1',
			confirmPassword: 'new-password-2'
		})) as { status: number; data: { message: string } };
		expect(mismatch.status).toBe(400);
		expect(mismatch.data.message).toBe('err-mismatch');

		expect(resetMock).not.toHaveBeenCalled();
	});

	it('rejects a too-short password before calling better-auth', async () => {
		const result = (await call({
			token: 'tok_1',
			password: 'short',
			confirmPassword: 'short'
		})) as { status: number; data: { message: string } };
		expect(result.status).toBe(400);
		expect(result.data.message).toBe('err-short');
		expect(resetMock).not.toHaveBeenCalled();
	});

	it('maps better-auth INVALID_TOKEN to the recovery marker', async () => {
		resetMock.mockRejectedValueOnce(
			APIError.from('BAD_REQUEST', { message: 'Invalid token', code: 'INVALID_TOKEN' })
		);

		const result = (await call({
			token: 'tok_dead',
			password: 'new-password-1',
			confirmPassword: 'new-password-1'
		})) as { status: number; data: { message: string; errorCode: string } };

		expect(result.status).toBe(400);
		expect(result.data).toEqual({ message: 'err-invalid-token', errorCode: 'invalid_token' });
	});

	it('never echoes upstream wording for other API failures', async () => {
		resetMock.mockRejectedValueOnce(
			APIError.from('BAD_REQUEST', { message: 'Password too short', code: 'PASSWORD_TOO_SHORT' })
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const result = (await call({
			token: 'tok_1',
			password: 'new-password-1',
			confirmPassword: 'new-password-1'
		})) as { status: number; data: { message: string; errorCode: string } };

		expect(result.status).toBe(400);
		expect(result.data).toEqual({ message: 'err-unexpected', errorCode: '' });
		expect(warn).toHaveBeenCalledWith('[reset-password] rejected', 'PASSWORD_TOO_SHORT');
	});

	it('reports an unexpected failure as 500', async () => {
		resetMock.mockRejectedValueOnce(new Error('db down'));

		const result = (await call({
			token: 'tok_1',
			password: 'new-password-1',
			confirmPassword: 'new-password-1'
		})) as { status: number; data: { message: string } };

		expect(result.status).toBe(500);
		expect(result.data.message).toBe('err-unexpected');
	});

	it('resets through better-auth and lands on the sign-in page', async () => {
		const { thrown } = await callCatching({
			token: 'tok_1',
			password: 'new-password-1',
			confirmPassword: 'new-password-1'
		});

		expect(resetMock).toHaveBeenCalledWith({
			body: { newPassword: 'new-password-1', token: 'tok_1' },
			headers: expect.any(Headers)
		});
		expect((thrown as { status?: number; location?: string }).status).toBe(303);
		expect((thrown as { status?: number; location?: string }).location).toBe(
			'/login?message=password-reset-success'
		);
	});
});
