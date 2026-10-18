import { describe, expect, it } from 'vitest';
import { isSignUpRequest, SIGN_UP_PATH } from './auth-gate';

describe('API sign-up gate', () => {
	it('matches only a POST to the public sign-up path', () => {
		expect(isSignUpRequest({ method: 'POST', pathname: SIGN_UP_PATH })).toBe(true);
	});

	it('never matches other auth endpoints or methods', () => {
		expect(isSignUpRequest({ method: 'GET', pathname: SIGN_UP_PATH })).toBe(false);
		expect(isSignUpRequest({ method: 'POST', pathname: '/api/auth/sign-in/email' })).toBe(false);
		expect(isSignUpRequest({ method: 'POST', pathname: '/api/auth/sign-out' })).toBe(false);
		expect(isSignUpRequest({ method: 'POST', pathname: `${SIGN_UP_PATH}/` })).toBe(false);
	});
});
