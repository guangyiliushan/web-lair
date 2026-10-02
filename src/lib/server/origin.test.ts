import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envState } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> }
}));

vi.mock('$env/dynamic/private', () => envState);

import { getPublicOrigin } from './origin';

describe('getPublicOrigin', () => {
	beforeEach(() => {
		delete envState.env.ORIGIN;
	});

	it('normalises the configured origin (trailing slashes, stray paths)', () => {
		envState.env.ORIGIN = 'https://example.com///';
		expect(getPublicOrigin()).toBe('https://example.com');
		envState.env.ORIGIN = 'https://example.com/base/';
		expect(getPublicOrigin()).toBe('https://example.com');
	});

	it('returns null when ORIGIN is missing so callers fall back to the request origin', () => {
		expect(getPublicOrigin()).toBeNull();
	});

	it('fails loudly on non-http(s) values instead of yielding a "null" origin', () => {
		envState.env.ORIGIN = 'lair.example.com:8080';
		expect(() => getPublicOrigin()).toThrow('[origin]');
		envState.env.ORIGIN = 'ftp://example.com';
		expect(() => getPublicOrigin()).toThrow('[origin]');
		envState.env.ORIGIN = 'not a url';
		expect(() => getPublicOrigin()).toThrow();
	});
});
