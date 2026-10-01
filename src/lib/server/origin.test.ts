import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envState } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> }
}));

vi.mock('$env/dynamic/private', () => envState);

import { getOrigin } from './origin';

describe('getOrigin', () => {
	beforeEach(() => {
		delete envState.env.ORIGIN;
	});

	it('returns the configured origin without trailing slashes', () => {
		envState.env.ORIGIN = 'https://example.com///';
		expect(getOrigin()).toBe('https://example.com');
	});

	it('throws when ORIGIN is missing', () => {
		expect(() => getOrigin()).toThrow('ORIGIN is not set');
	});
});
