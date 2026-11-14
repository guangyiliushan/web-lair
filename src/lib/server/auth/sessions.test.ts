import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { deleteSpy, whereCalls } = vi.hoisted(() => ({
	deleteSpy: vi.fn(),
	whereCalls: [] as unknown[]
}));

vi.mock('$lib/server/db', () => ({
	db: {
		delete: (table: unknown) => {
			deleteSpy(table);
			return {
				where: (condition: unknown) => {
					whereCalls.push(condition);
					return Promise.resolve();
				}
			};
		},
		execute: (query: unknown) => {
			whereCalls.push(query);
			return Promise.resolve();
		}
	}
}));

import {
	enforceSessionLimit,
	pruneOtherSessions,
	pruneOtherSessionsKeepingNewest,
	revokeSessionByToken,
	SESSION_LIMIT
} from './sessions';

const dialect = new PgDialect();

function lastQuery() {
	const arg = whereCalls.at(-1) as never;
	return dialect.sqlToQuery(arg);
}

describe('session pruning helpers', () => {
	beforeEach(() => {
		deleteSpy.mockClear();
		whereCalls.length = 0;
	});

	it('pruneOtherSessions deletes every session of the user except the kept token', async () => {
		await pruneOtherSessions('user-1', 'keep-token');

		expect(deleteSpy).toHaveBeenCalledTimes(1);
		const { sql, params } = lastQuery();
		expect(sql).toContain('"session"."user_id"');
		expect(sql).toContain('"session"."token"');
		expect(sql).toContain('<>');
		expect(params).toContain('user-1');
		expect(params).toContain('keep-token');
	});

	it('revokeSessionByToken deletes exactly the row of that token', async () => {
		await revokeSessionByToken('dead-token');

		expect(deleteSpy).toHaveBeenCalledTimes(1);
		const { sql, params } = lastQuery();
		expect(sql).toContain('"session"."token"');
		expect(sql).not.toContain('<>');
		expect(params).toEqual(['dead-token']);
	});

	it('pruneOtherSessionsKeepingNewest keeps the newest row via a subquery', async () => {
		await pruneOtherSessionsKeepingNewest('user-2');

		expect(deleteSpy).toHaveBeenCalledTimes(0);
		const { sql, params } = lastQuery();
		expect(sql.toLowerCase()).toContain('order by');
		expect(sql.toLowerCase()).toContain('limit');
		expect(sql).toContain('<>');
		expect(params).toEqual(['user-2', 'user-2']);
	});

	it('enforceSessionLimit deletes the oldest rows beyond the cap, keeping the new one', async () => {
		expect(SESSION_LIMIT).toBe(10);
		await enforceSessionLimit('user-3', 'new-session');

		expect(deleteSpy).toHaveBeenCalledTimes(0);
		const { sql, params } = lastQuery();
		const normalized = sql.toLowerCase();
		expect(normalized).toContain('delete from');
		expect(normalized).toContain('order by');
		expect(normalized).toContain('offset');
		expect(normalized).toContain('<>');
		// user id and keep id appear in both the outer delete and the subquery;
		// the offset is limit - 1 (9 for the default cap of 10).
		expect(params.filter((value) => value === 'user-3')).toHaveLength(2);
		expect(params.filter((value) => value === 'new-session')).toHaveLength(2);
		expect(params).toContain(SESSION_LIMIT - 1);
	});
});
