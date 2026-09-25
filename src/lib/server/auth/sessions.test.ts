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
	pruneOtherSessions,
	pruneOtherSessionsKeepingNewest,
	revokeSessionByToken
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
});
