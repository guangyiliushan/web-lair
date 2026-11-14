import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The retention sweep only ever removes history. Two rules matter and are
 * pinned here: `discardDays = 0` disables it, and the cutoff is measured
 * against `updated_at` (when the row was discarded) rather than `created_at`,
 * or a long-lived draft discarded yesterday would vanish today.
 */
const { captured, state } = vi.hoisted(() => {
	const state = {
		option: { discardDays: 180 } as { discardDays: number },
		returning: [] as unknown[],
		whereArg: null as unknown
	};
	return { captured: state, state };
});

vi.mock('../config/options-registry.ts', () => ({
	getOption: async () => captured.option
}));

const db = {
	delete: () => ({
		where: (arg: unknown) => {
			state.whereArg = arg;
			return { returning: async () => state.returning };
		}
	})
} as never;

const { pruneDiscardedTranslations } = await import('./translation-retention.ts');

beforeEach(() => {
	state.option = { discardDays: 180 };
	state.returning = [{ id: 'a' }, { id: 'b' }];
	state.whereArg = null;
});

/**
 * Walk drizzle's SQL tree and collect the fragments it is built from. Drizzle
 * keeps the condition as nested chunk objects (a table reference is circular),
 * so plain JSON.stringify cannot be used.
 */
function describeSql(node: unknown): string {
	const seen = new Set<unknown>();
	const parts: string[] = [];
	const visit = (value: unknown) => {
		if (value == null || typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const record = value as Record<string, unknown>;
		if (typeof record.name === 'string') parts.push(record.name);
		if (typeof record.value === 'string') parts.push(record.value);
		if (record.value instanceof Date) parts.push('cutoff-date');
		if (Array.isArray(record.value)) {
			for (const entry of record.value) if (typeof entry === 'string') parts.push(entry);
		}
		if (Array.isArray(record.queryChunks)) {
			for (const chunk of record.queryChunks) visit(chunk);
		}
	};
	visit(node);
	return parts.join(' ');
}

describe('pruneDiscardedTranslations', () => {
	it('deletes only discarded rows older than the window', async () => {
		const removed = await pruneDiscardedTranslations(db, new Date('2026-11-08T00:00:00Z'));
		expect(removed).toBe(2);
		const sqlText = describeSql(state.whereArg);
		expect(sqlText).toContain('discarded');
		// The cutoff rides on `updated_at` (falling back to `created_at`), not on
		// the creation time alone.
		expect(sqlText).toContain('updated_at');
		// ...and it is bound as an ISO string cast to timestamptz. A JS Date
		// against the raw coalesce() expression makes postgres.js throw
		// ERR_INVALID_ARG_TYPE (db:verify-jobs caught it on W9.5).
		expect(sqlText).toContain('timestamptz');
		expect(sqlText).not.toContain('cutoff-date');
	});

	it('does nothing when the retention window is disabled', async () => {
		state.option = { discardDays: 0 };
		await expect(pruneDiscardedTranslations(db)).resolves.toBe(0);
		expect(state.whereArg).toBeNull();
	});

	it('reports 0 when nothing is old enough', async () => {
		state.returning = [];
		await expect(pruneDiscardedTranslations(db)).resolves.toBe(0);
	});
});
