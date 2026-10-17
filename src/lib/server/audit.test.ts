import { describe, expect, it, vi } from 'vitest';

vi.mock('./webhooks/outbox.ts', () => ({ enqueueWebhookDeliveries: vi.fn() }));

import { recordActivity } from './audit';
import { enqueueWebhookDeliveries } from './webhooks/outbox.ts';

const enqueueMock = vi.mocked(enqueueWebhookDeliveries);

function fakeExecutor() {
	const insert = vi.fn(() => ({ values: vi.fn(async () => undefined) }));
	const execute = vi.fn(async () => undefined);
	return { insert, execute };
}

describe('recordActivity -> outbox seam (nine-dimension SYF-2)', () => {
	it('fans the audit row out to the outbox on the SAME executor', async () => {
		const executor = fakeExecutor();
		enqueueMock.mockResolvedValueOnce(undefined);
		await recordActivity(executor as never, {
			event: 'job.run',
			actorId: null,
			payload: { name: 'x' }
		});
		expect(executor.insert).toHaveBeenCalledTimes(1);
		expect(enqueueMock).toHaveBeenCalledTimes(1);
		expect(enqueueMock.mock.calls[0]?.[0]).toBe(executor);
	});

	it('propagates an outbox failure loudly (deliveries are never silently dropped)', async () => {
		const executor = fakeExecutor();
		enqueueMock.mockRejectedValueOnce(new Error('boom'));
		await expect(
			recordActivity(executor as never, { event: 'job.run', actorId: null, payload: {} })
		).rejects.toThrow('boom');
		// The audit row was written before the enqueue threw; the caller's
		// transaction (or fail-loud surface) owns the shared fate.
		expect(executor.insert).toHaveBeenCalledTimes(1);
	});
});
