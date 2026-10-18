import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
	and: vi.fn((...parts: unknown[]) => ({ op: 'and', parts })),
	eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
	lt: vi.fn((column: unknown, value: unknown) => ({ op: 'lt', column, value })),
	sql: vi.fn((strings: TemplateStringsArray) => ({ op: 'sql', text: strings.join('?') })),
	subscriptions: { status: 'status-column', updatedAt: 'updated-at-column' }
}));

vi.mock('#jobs-sdk', () => sdk);

import job from './builtin/subscriptions-sweep';

function context(removed: { id: string }[]) {
	const returning = vi.fn(async () => removed);
	const where = vi.fn((_predicate: unknown) => ({ returning }));
	const del = vi.fn((_table: unknown) => ({ where }));
	const summary = vi.fn();
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	return {
		ctx: { db: { delete: del }, summary, logger } as unknown as Parameters<typeof job.run>[0],
		del,
		where,
		summary,
		logger
	};
}

describe('subscriptions.sweep', () => {
	it('deletes only pending rows older than 30 days', async () => {
		const { ctx, del, where, summary, logger } = context([{ id: 'a' }, { id: 'b' }]);
		await job.run(ctx);

		expect(del).toHaveBeenCalledWith(sdk.subscriptions);
		const predicate = where.mock.calls[0]![0] as { op: string; parts: unknown[] };
		expect(predicate.op).toBe('and');
		expect(predicate.parts).toEqual([
			{ op: 'eq', column: 'status-column', value: 'pending' },
			{
				op: 'lt',
				column: 'updated-at-column',
				value: { op: 'sql', text: "now() - interval '30 days'" }
			}
		]);
		expect(summary).toHaveBeenCalledWith({ pending: 2 });
		expect(logger.info).toHaveBeenCalledWith('swept pending subscriptions=2');
	});

	it('reports zero without deleting anything else', async () => {
		const { ctx, summary } = context([]);
		await job.run(ctx);
		expect(summary).toHaveBeenCalledWith({ pending: 0 });
	});
});
