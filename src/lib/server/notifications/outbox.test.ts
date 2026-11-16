import { describe, expect, it, vi } from 'vitest';
import { createNotificationSink, enqueueNotification } from './outbox';
import type { NotificationOutboxDb } from './outbox';
import type { NotificationPreferences } from './preferences';

/**
 * Outbox teeth (M6 P5, T5.2): the unique key makes a replayed producer a
 * no-op, the hourly windows turn a flood into at most N rows plus log lines,
 * a disabled group stores nothing, and NO failure escapes to the caller -
 * the comment transaction (and the drain tick) must survive a broken outbox.
 */

interface FakeRow {
	eventType: string;
	eventKey: string;
	channel: string;
	createdAt: Date;
}

function fakeOutboxDb(
	options: {
		now?: Date;
		rows?: FakeRow[];
		insertError?: unknown;
	} = {}
) {
	const now = options.now ?? new Date('2026-11-16T10:00:00.000Z');
	const state = {
		rows: [...(options.rows ?? [])],
		inserts: [] as Array<Record<string, unknown>>,
		transactions: 0
	};
	const windowStart = now.getTime() - 60 * 60 * 1000;
	const inWindow = () => state.rows.filter((row) => row.createdAt.getTime() >= windowStart);
	const tx = {
		select: () => ({
			from: () => ({
				// The preferences read awaits `.limit(1)`; the two window counts
				// await the `where()` result directly. Serve both shapes.
				where: () => {
					const counted = Promise.resolve([{ count: inWindow().length }]);
					return { then: counted.then.bind(counted), limit: () => counted };
				}
			})
		}),
		insert: () => ({
			values: (values: Array<Record<string, unknown>>) => {
				state.inserts.push(...values);
				return {
					onConflictDoNothing: () => ({
						returning: async () => {
							if (options.insertError) throw options.insertError;
							const fresh = values.filter(
								(value) =>
									!state.rows.some(
										(row) =>
											row.eventType === value.eventType &&
											row.eventKey === value.eventKey &&
											row.channel === value.channel
									)
							);
							for (const value of fresh) {
								state.rows.push({
									eventType: String(value.eventType),
									eventKey: String(value.eventKey),
									channel: String(value.channel),
									createdAt: now
								});
							}
							return fresh.map((_, index) => ({ id: `row-${index}` }));
						}
					})
				};
			}
		})
	};
	const db = {
		transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> => {
			state.transactions += 1;
			return fn(tx);
		}
	};
	return { db: db as unknown as NotificationOutboxDb, state, now };
}

const PREFERENCES_BARK_ON: NotificationPreferences = {
	comment: { email: true, bark: true },
	job: { email: true, bark: false },
	ops: { email: true, bark: false }
};

describe('enqueueNotification', () => {
	it('stores one queued row per enabled channel, inside a transaction', async () => {
		const { db, state, now } = fakeOutboxDb();
		const outcome = await enqueueNotification(
			db,
			{
				eventType: 'comment.pending',
				eventKey: 'comment:11111111-1111-1111-1111-111111111111',
				title: 'New comment awaiting review',
				body: 'Alice: hello there',
				url: 'https://lair.example/admin/comments'
			},
			{ now: () => now }
		);
		expect(outcome).toBe('enqueued');
		expect(state.transactions).toBe(1);
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0]).toMatchObject({
			eventType: 'comment.pending',
			channel: 'email',
			status: 'queued',
			attempts: 0
		});
		expect(state.inserts[0].nextAttemptAt).toEqual(now);
		expect(state.inserts[0].payload).toMatchObject({
			title: 'New comment awaiting review',
			body: 'Alice: hello there',
			url: 'https://lair.example/admin/comments'
		});
	});

	it('is idempotent: a replayed producer is a no-op, never a second row', async () => {
		const { db, state } = fakeOutboxDb();
		const input = {
			eventType: 'comment.pending',
			eventKey: 'comment:22222222-2222-2222-2222-222222222222',
			title: 't',
			body: 'b'
		};
		expect(await enqueueNotification(db, input)).toBe('enqueued');
		expect(await enqueueNotification(db, input)).toBe('duplicate');
		expect(state.rows).toHaveLength(1);
	});

	it('writes both channels when Bark is enabled for the group', async () => {
		const { db, state } = fakeOutboxDb();
		const outcome = await enqueueNotification(
			db,
			{
				eventType: 'comment.pending',
				eventKey: 'comment:33333333-3333-3333-3333-333333333333',
				title: 't',
				body: 'b'
			},
			{ preferences: PREFERENCES_BARK_ON }
		);
		expect(outcome).toBe('enqueued');
		expect(state.inserts.map((row) => row.channel).sort()).toEqual(['bark', 'email']);
	});

	it('stores nothing when the operator disabled every channel', async () => {
		const { db, state } = fakeOutboxDb();
		const log = vi.fn();
		const outcome = await enqueueNotification(
			db,
			{
				eventType: 'comment.pending',
				eventKey: 'comment:44444444-4444-4444-4444-444444444444',
				title: 't',
				body: 'b'
			},
			{
				log,
				preferences: {
					comment: { email: false, bark: false },
					job: { email: true, bark: false },
					ops: { email: true, bark: false }
				}
			}
		);
		expect(outcome).toBe('skipped');
		expect(state.inserts).toHaveLength(0);
		expect(log.mock.calls.join('\n')).toContain('every channel is disabled');
	});

	it('suppresses a 100-event comment storm at the per-event window (10/h)', async () => {
		const { db, state } = fakeOutboxDb();
		const log = vi.fn();
		const outcomes: string[] = [];
		for (let index = 0; index < 100; index += 1) {
			outcomes.push(
				await enqueueNotification(
					db,
					{
						eventType: 'comment.pending',
						eventKey: `comment:00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
						title: `comment ${index}`,
						body: `body ${index}`
					},
					{ log }
				)
			);
		}
		expect(outcomes.filter((outcome) => outcome === 'enqueued')).toHaveLength(10);
		expect(outcomes.filter((outcome) => outcome === 'suppressed')).toHaveLength(90);
		expect(state.rows).toHaveLength(10);
		expect(log.mock.calls.join('\n')).toContain('event window full');
	});

	it('suppresses once the global hourly window is full (30/h)', async () => {
		const now = new Date('2026-11-16T10:00:00.000Z');
		const rows: FakeRow[] = Array.from({ length: 30 }, (_, index) => ({
			eventType: 'job.failed',
			eventKey: `job_run:${index}`,
			channel: 'email',
			createdAt: now
		}));
		const { db, state } = fakeOutboxDb({ now, rows });
		const log = vi.fn();
		const outcome = await enqueueNotification(
			db,
			{
				eventType: 'comment.pending',
				eventKey: 'comment:55555555-5555-5555-5555-555555555555',
				title: 't',
				body: 'b'
			},
			{
				log,
				preferences: {
					comment: { email: true, bark: false },
					job: { email: true, bark: false },
					ops: { email: true, bark: false }
				}
			}
		);
		expect(outcome).toBe('suppressed');
		expect(state.inserts).toHaveLength(0);
		expect(log.mock.calls.join('\n')).toContain('global window full');
	});

	it('refuses an unregistered event type (a typo must not create a dead row)', async () => {
		const { db, state } = fakeOutboxDb();
		const log = vi.fn();
		expect(
			await enqueueNotification(
				db,
				{ eventType: 'comment.pendng', eventKey: 'comment:x', title: 't', body: 'b' },
				{ log }
			)
		).toBe('failed');
		expect(state.transactions).toBe(0);
		expect(log.mock.calls.join('\n')).toContain('unknown event type');
	});

	it('refuses an event key with whitespace (the table CHECK would reject it)', async () => {
		const { db } = fakeOutboxDb();
		expect(
			await enqueueNotification(db, {
				eventType: 'comment.pending',
				eventKey: 'comment:has space',
				title: 't',
				body: 'b'
			})
		).toBe('failed');
	});

	it('never throws: a DB error becomes `failed` plus a sanitized log line', async () => {
		const { db } = fakeOutboxDb({
			insertError: new Error('insert failed for postgres://root:pw@db:5432/local')
		});
		const log = vi.fn();
		const outcome = await enqueueNotification(
			db,
			{
				eventType: 'comment.pending',
				eventKey: 'comment:66666666-6666-6666-6666-666666666666',
				title: 't',
				body: 'b'
			},
			{ log }
		);
		expect(outcome).toBe('failed');
		const text = log.mock.calls.join('\n');
		expect(text).toContain('enqueue failed');
		// Credentials never survive the sanitizer; the host:port stays (it is
		// what an operator needs to recognize the target).
		expect(text).not.toContain('pw@');
		expect(text).not.toContain('/local');
	});

	it('falls back to the defaults when the preferences read throws', async () => {
		const inserts: Array<Record<string, unknown>> = [];
		// The FIRST select (the preferences row) throws; the window counts that
		// follow must still work, so the fallback path is exercised, not a
		// blanket "everything is broken" case.
		let selects = 0;
		const broken = {
			transaction: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
				fn({
					select: () => {
						selects += 1;
						if (selects === 1) throw new Error('preferences select failed');
						return {
							from: () => ({
								where: () => {
									const counted = Promise.resolve([{ count: 0 }]);
									return { then: counted.then.bind(counted), limit: () => counted };
								}
							})
						};
					},
					insert: () => ({
						values: (values: Array<Record<string, unknown>>) => {
							inserts.push(...values);
							return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'x' }] }) };
						}
					})
				})
		} as unknown as NotificationOutboxDb;
		const outcome = await enqueueNotification(broken, {
			eventType: 'comment.pending',
			eventKey: 'comment:77777777-7777-7777-7777-777777777777',
			title: 't',
			body: 'b'
		});
		expect(outcome).toBe('enqueued');
		expect(inserts[0].channel).toBe('email');
	});
});

describe('createNotificationSink', () => {
	it('turns a failed enqueue into a thrown error so notify() reports `failed`', async () => {
		const { db } = fakeOutboxDb({ insertError: new Error('boom') });
		const sink = createNotificationSink(db);
		await expect(
			sink({
				eventType: 'system.disk_high',
				eventKey: 'disk:/data:2026-11-16',
				title: 't',
				body: 'b'
			})
		).rejects.toThrow(/notification enqueue failed/);
	});

	it('resolves when the row is stored', async () => {
		const { db } = fakeOutboxDb();
		const sink = createNotificationSink(db);
		await expect(
			sink({
				eventType: 'system.disk_high',
				eventKey: 'disk:/data:2026-11-16',
				title: 't',
				body: 'b'
			})
		).resolves.toBeUndefined();
	});

	it('throws when the hourly window suppresses the alert (suppressed is not delivered)', async () => {
		// A full global window: the probe must see a failure, keep retrying and
		// NOT drop its daily latch (review P1-2). Returning "delivered" here would
		// silence the alert for the rest of the day.
		const now = new Date('2026-11-16T10:00:00.000Z');
		const rows: FakeRow[] = Array.from({ length: 30 }, (_, index) => ({
			eventType: 'job.failed',
			eventKey: `job_run:${index}`,
			channel: 'email',
			createdAt: now
		}));
		const { db } = fakeOutboxDb({ now, rows });
		const sink = createNotificationSink(db, { log: vi.fn() });
		await expect(
			sink({
				eventType: 'system.disk_high',
				eventKey: 'disk:/data:2026-11-16',
				title: 't',
				body: 'b'
			})
		).rejects.toThrow(/notification enqueue suppressed/);
	});
});
