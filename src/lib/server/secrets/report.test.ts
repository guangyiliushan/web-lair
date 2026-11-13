import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reportSecretFailure, resetSecretFailureThrottle } from './report.ts';
import { recordActivity } from '../audit.ts';

vi.mock('../audit.ts', () => ({ recordActivity: vi.fn(async () => undefined) }));

const recordMock = vi.mocked(recordActivity);

function executor() {
	return { insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })), execute: vi.fn() };
}

describe('reportSecretFailure', () => {
	beforeEach(() => {
		resetSecretFailureThrottle();
		recordMock.mockClear();
	});

	it('writes a two-segment audit row with no value and no fan-out', async () => {
		const providerId = '66666666-6666-6666-6666-666666666666';
		await reportSecretFailure(executor() as never, {
			event: 'ai.key_decrypt_failed',
			providerId,
			providerName: 'openai',
			reason: 'decrypt_failed'
		});
		expect(recordMock).toHaveBeenCalledTimes(1);
		const [, input] = recordMock.mock.calls[0];
		// Exact shape: any added value/ciphertext/hint-sized field fails here.
		expect(input).toEqual({
			event: 'ai.key_decrypt_failed',
			actorId: null,
			refType: 'ai',
			refId: providerId,
			payload: { provider: 'openai', subject: null, reason: 'decrypt_failed' },
			deliver: false
		});
		expect(JSON.stringify(input)).not.toContain('v1:');
	});

	it('throttles the same event and provider for one minute', async () => {
		const db = executor() as never;
		const input = {
			event: 'ai.key_missing' as const,
			providerId: '77777777-7777-7777-7777-777777777777',
			providerName: 'openai',
			reason: 'missing'
		};
		await reportSecretFailure(db, input);
		await reportSecretFailure(db, input);
		expect(recordMock).toHaveBeenCalledTimes(1);
	});

	it('does not collapse different providers or different events', async () => {
		const db = executor() as never;
		await reportSecretFailure(db, {
			event: 'ai.key_missing',
			providerId: '88888888-8888-8888-8888-888888888888'
		});
		await reportSecretFailure(db, {
			event: 'ai.key_missing',
			providerId: '99999999-9999-9999-9999-999999999999'
		});
		await reportSecretFailure(db, {
			event: 'ai.key_decrypt_failed',
			providerId: '88888888-8888-8888-8888-888888888888'
		});
		expect(recordMock).toHaveBeenCalledTimes(3);
	});

	it('never throws when the audit path fails', async () => {
		recordMock.mockRejectedValueOnce(new Error('db down'));
		await expect(
			reportSecretFailure(executor() as never, { event: 'ai.key_denied', reason: 'denied' })
		).resolves.toBeUndefined();
	});
});
