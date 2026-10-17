import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { buildDeliveryPayload, enqueueWebhookDeliveries } from './outbox';

/**
 * S1 producer unit teeth: the delivery body builder is a pure function, and
 * the enqueue must compile to ONE `insert ... select` statement whose WHERE
 * carries the `@>` subscription test (the exact SQL shape was verified
 * against a real PostgreSQL in the S1 grill scratch probe; the live-PG
 * teeth live in `pnpm db:verify-jobs`).
 */

describe('buildDeliveryPayload', () => {
	it('builds the Standard Webhooks recommended shape', () => {
		const now = new Date('2026-10-16T12:00:00.000Z');
		const payload = buildDeliveryPayload('job.run', { name: 'x' }, now);
		expect(payload).toEqual({
			type: 'job.run',
			timestamp: '2026-10-16T12:00:00.000Z',
			data: { name: 'x' }
		});
	});

	it('defaults data to an empty object', () => {
		expect(buildDeliveryPayload('schedule.create').data).toEqual({});
		expect(buildDeliveryPayload('schedule.create', null).data).toEqual({});
	});

	it('emits an ISO 8601 timestamp of the occurrence', () => {
		const payload = buildDeliveryPayload('job.save', {});
		expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
		expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
	});
});

describe('enqueueWebhookDeliveries', () => {
	function fakeExecutor(execute: ReturnType<typeof vi.fn>) {
		const transaction = vi.fn(
			async (cb: (savepoint: { execute: typeof execute }) => Promise<unknown>) => cb({ execute })
		);
		return { executor: { execute, transaction } as never, transaction };
	}

	it('compiles to one insert ... select with the @> test, inside executor.transaction (Q4)', async () => {
		const execute = vi.fn(async (query: SQL) => {
			void query; // the compiled statement is asserted from the recorded call
			return [];
		});
		const { executor, transaction } = fakeExecutor(execute);
		await enqueueWebhookDeliveries(executor, {
			event: 'job.run',
			payload: { name: 'x' }
		});
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledTimes(1);
		const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
		const text = compiled.sql.toLowerCase();
		expect(text).toContain('insert into "webhook_deliveries"');
		expect(text).toContain('select');
		expect(text).toContain('from "webhooks"');
		expect(text).toContain('@> array[');
		expect(text).toContain('::text');
		expect(text).toContain('is_enabled');
		expect(compiled.params).toContain('job.run');
		const body = compiled.params.find(
			(entry) => typeof entry === 'string' && entry.includes('"type":"job.run"')
		);
		expect(body).toBeDefined();
		expect(JSON.parse(body as string)).toEqual({
			type: 'job.run',
			timestamp: expect.any(String),
			data: { name: 'x' }
		});
	});

	it('swallows ONLY a 23503 (endpoint vanished) and keeps other failures loud', async () => {
		const fkExecute = vi.fn(async () => {
			throw Object.assign(new Error('fk violation'), { code: '23503' });
		});
		await expect(
			enqueueWebhookDeliveries(fakeExecutor(fkExecute).executor, { event: 'job.run' })
		).resolves.toBeUndefined();
		const boomExecute = vi.fn(async () => {
			throw new Error('boom');
		});
		await expect(
			enqueueWebhookDeliveries(fakeExecutor(boomExecute).executor, { event: 'job.run' })
		).rejects.toThrow('boom');
	});
});
