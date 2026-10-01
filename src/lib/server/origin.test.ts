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
	});

	it('returns null when ORIGIN is missing so callers fall back to the request origin', () => {
		expect(getPublicOrigin()).toBeNull();
	});
});
