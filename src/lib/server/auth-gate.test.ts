import { describe, expect, it } from 'vitest';
import { isSignUpBlocked, SIGN_UP_PATH } from './auth-gate';

describe('API sign-up gate', () => {
	it('blocks only a POST to the public sign-up path without mail', () => {
		expect(isSignUpBlocked({ method: 'POST', pathname: SIGN_UP_PATH, mailAvailable: false })).toBe(
			true
		);
	});

	it('stays inert when mail is available', () => {
		expect(isSignUpBlocked({ method: 'POST', pathname: SIGN_UP_PATH, mailAvailable: true })).toBe(
			false
		);
	});

	it('never touches other auth endpoints or methods', () => {
		expect(isSignUpBlocked({ method: 'GET', pathname: SIGN_UP_PATH, mailAvailable: false })).toBe(
			false
		);
		expect(
			isSignUpBlocked({ method: 'POST', pathname: '/api/auth/sign-in/email', mailAvailable: false })
		).toBe(false);
		expect(
			isSignUpBlocked({ method: 'POST', pathname: '/api/auth/sign-out', mailAvailable: false })
		).toBe(false);
	});
});
