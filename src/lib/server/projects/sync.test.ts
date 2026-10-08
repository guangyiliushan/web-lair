import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ProjectsFetchError, type FetchJson, type FetchJsonResponse } from './fetch';
import { runSync } from './sync';
import type { SyncTarget } from './types';

/** Renders a captured drizzle condition so tests can assert its shape. */
const dialect = new PgDialect();
const renderCondition = (condition: unknown): string => dialect.sqlToQuery(condition as never).sql;

/**
 * T9 (plan §7): the four write rules against a fake db + stubbed transport -
 * new -> pending insert with prefill; existing -> snapshot only (user fields
 * never written); rejected -> skipped forever; rename -> same row updated.
 * Plus: fork filter, dry-run silence, account failure isolation, partial
 * rate-limited lists, the 23505 insert race fallback and refresh mode.
 */

interface FakeState {
	selectQueue: unknown[][];
	inserts: Record<string, unknown>[];
	updates: Record<string, unknown>[];
	insertError: unknown;
	/** Captured where-conditions (predicate teeth, review 2026-10-08). */
	selectWhere: unknown[];
	updateWhere: unknown[];
}

function makeChain(rows: unknown[]) {
	const value = () => rows;
	return {
		limit: () => Promise.resolve(value()),
		then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(value()).then(resolve)
	};
}

function makeFakeDb() {
	const state: FakeState = {
		selectQueue: [],
		inserts: [],
		updates: [],
		insertError: null,
		selectWhere: [],
		updateWhere: []
	};
	const db = {
		select: () => {
			const rows = state.selectQueue.shift() ?? [];
			return {
				from: () => ({
					where: (condition: unknown) => {
						state.selectWhere.push(condition);
						return makeChain(rows);
					}
				})
			};
		},
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				state.inserts.push(values);
				if (state.insertError) {
					const error = state.insertError;
					state.insertError = null;
					return Promise.reject(error);
				}
				return Promise.resolve();
			}
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				state.updates.push(values);
				return {
					where: (condition: unknown) => {
						state.updateWhere.push(condition);
						return Promise.resolve();
					}
				};
			}
		})
	};
	return { state, db: db as never };
}

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function response(json: unknown, headers: Record<string, string> = {}): FetchJsonResponse {
	return { status: 200, headers: new Headers(headers), json };
}

function githubRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 1,
		full_name: 'guang/reborn',
		html_url: 'https://github.com/guang/reborn',
		homepage: 'https://reborn.example',
		owner: { avatar_url: 'https://avatars.example/u.png' },
		language: 'TypeScript',
		stargazers_count: 12,
		pushed_at: '2026-10-01T00:00:00Z',
		archived: false,
		fork: false,
		description: 'reborn project',
		private: false,
		...overrides
	};
}

const TARGET: SyncTarget = { provider: 'github', account: 'guang' };
const NOW = () => new Date('2026-10-07T12:00:00Z');

const SNAPSHOT_KEYS = [
	'language',
	'stars',
	'pushedAt',
	'archived',
	'fork',
	'projectUrl',
	'fullName',
	'lastSyncedAt',
	'lastErrorKind'
];

describe('projects runSync (write rules, plan §3.5)', () => {
	it('inserts a new repo as a pending row with snapshot + prefill', async () => {
		const { state, db } = makeFakeDb();
		const fetchJson: FetchJson = async (url) => {
			expect(url).toContain('/users/guang/repos');
			return response([githubRepo()]);
		};
		const summary = await runSync({
			db,
			targets: [TARGET],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary).toMatchObject({ added: 1, updated: 0, skipped: 0, failed: 0, targets: 1 });
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0]).toEqual({
			name: 'reborn',
			description: 'reborn project',
			provider: 'github',
			externalId: '1',
			fullName: 'guang/reborn',
			projectUrl: 'https://github.com/guang/reborn',
			previewUrl: 'https://reborn.example',
			avatar: 'https://avatars.example/u.png',
			language: 'TypeScript',
			stars: 12,
			pushedAt: new Date('2026-10-01T00:00:00Z'),
			archived: false,
			fork: false,
			lastSyncedAt: NOW(),
			lastErrorKind: null
		});
		// status / sort_order fall to the DB defaults - never written here.
		expect(Object.keys(state.inserts[0])).not.toContain('status');
		expect(Object.keys(state.inserts[0])).not.toContain('sortOrder');
	});

	it('updates existing rows with the snapshot only - never user fields', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[{ id: 'row-1', externalId: '1', status: 'published' }]];
		const fetchJson: FetchJson = async () =>
			response([
				githubRepo({ stargazers_count: 99, html_url: 'https://github.com/guang/reborn-renamed' })
			]);
		const summary = await runSync({
			db,
			targets: [TARGET],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.updated).toBe(1);
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0]).toEqual({
			language: 'TypeScript',
			stars: 99,
			pushedAt: new Date('2026-10-01T00:00:00Z'),
			archived: false,
			fork: false,
			projectUrl: 'https://github.com/guang/reborn-renamed',
			fullName: 'guang/reborn',
			lastSyncedAt: NOW(),
			lastErrorKind: null
		});
		for (const forbidden of [
			'name',
			'description',
			'previewUrl',
			'docUrl',
			'avatar',
			'sortOrder',
			'status'
		]) {
			expect(Object.keys(state.updates[0])).not.toContain(forbidden);
		}
		expect(state.inserts).toHaveLength(0);
	});

	it('skips rejected rows forever (maintenance of permanent memory)', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[{ id: 'row-1', externalId: '1', status: 'rejected' }]];
		const fetchJson: FetchJson = async () => response([githubRepo()]);
		const summary = await runSync({
			db,
			targets: [TARGET],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary).toMatchObject({ added: 0, updated: 0, skipped: 1, failed: 0 });
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
	});

	it('filters forks out of the candidate set', async () => {
		const { state, db } = makeFakeDb();
		const fetchJson: FetchJson = async () =>
			response([githubRepo(), githubRepo({ id: 2, fork: true, full_name: 'guang/forked' })]);
		const summary = await runSync({
			db,
			targets: [TARGET],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.added).toBe(1);
		expect(state.inserts).toHaveLength(1);
	});

	it('dry-run counts without writing', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[]];
		const fetchJson: FetchJson = async () => response([githubRepo()]);
		const summary = await runSync({
			db,
			targets: [TARGET],
			logger: makeLogger(),
			now: NOW,
			fetchJson,
			dryRun: true
		});
		expect(summary).toMatchObject({ dryRun: true, added: 1 });
		expect(state.inserts).toHaveLength(0);
		expect(state.updates).toHaveLength(0);
	});

	it('records an account-level failure and continues with the next target', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[]];
		const fetchJson: FetchJson = async (url) => {
			if (url.includes('/users/broken/')) {
				throw new ProjectsFetchError('rate_limited', 'HTTP 429');
			}
			return response([
				githubRepo({ id: 7, full_name: 'other/ok', html_url: 'https://github.com/other/ok' })
			]);
		};
		const summary = await runSync({
			db,
			targets: [TARGET, { provider: 'github', account: 'broken' }],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.failed).toBe(1);
		expect(summary.failures[0]).toEqual({
			provider: 'github',
			account: 'broken',
			repo: null,
			kind: 'rate_limited'
		});
		expect(summary.added).toBe(1);
	});

	it('upserts a partial list when pagination hits the quota, recording rate_limited', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[]];
		const fetchJson: FetchJson = async () =>
			response([githubRepo()], {
				'x-ratelimit-remaining': '0',
				link: '<https://api.github.com/users/guang/repos?per_page=100&page=2>; rel="next"'
			});
		const summary = await runSync({
			db,
			targets: [TARGET],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.added).toBe(1);
		expect(summary.failures).toContainEqual({
			provider: 'github',
			account: 'guang',
			repo: null,
			kind: 'rate_limited'
		});
	});

	it('falls back to a snapshot update when the insert loses the unique race', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[], [{ id: 'raced-row' }]];
		state.insertError = Object.assign(new Error('duplicate key value violates unique constraint'), {
			cause: { code: '23505' }
		});
		const fetchJson: FetchJson = async () => response([githubRepo()]);
		const summary = await runSync({
			db,
			targets: [TARGET],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary).toMatchObject({ added: 0, updated: 1 });
		expect(state.updates).toHaveLength(1);
		expect(Object.keys(state.updates[0]).sort()).toEqual([...SNAPSHOT_KEYS].sort());
	});

	it('refresh mode re-GETs selected rows and stamps not_found without touching status', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [
			[{ id: 'row-1', provider: 'github', projectUrl: 'https://github.com/guang/reborn' }]
		];
		const fetchJson: FetchJson = async () => {
			throw new ProjectsFetchError('not_found', 'HTTP 404', 404);
		};
		const summary = await runSync({
			db,
			targets: [],
			refreshIds: ['row-1'],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.failed).toBe(1);
		expect(summary.failures[0]).toMatchObject({ repo: 'reborn', kind: 'not_found' });
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0]).toEqual({ lastErrorKind: 'not_found', lastSyncedAt: NOW() });
	});

	it('refresh mode refreshes a row successfully through the adapter', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [
			[{ id: 'row-1', provider: 'github', projectUrl: 'https://github.com/guang/reborn' }]
		];
		const fetchJson: FetchJson = async (url) => {
			expect(url).toBe('https://api.github.com/repos/guang/reborn');
			return response(githubRepo({ stargazers_count: 42 }));
		};
		const summary = await runSync({
			db,
			targets: [],
			refreshIds: ['row-1'],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.updated).toBe(1);
		expect(state.updates[0]).toMatchObject({ stars: 42, lastErrorKind: null });
	});
});

describe('projects runSync hardening (review 2026-10-08)', () => {
	it('scopes selects by provider/externalId and updates by row id (predicate teeth)', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[{ id: 'row-1', externalId: '1', status: 'published' }]];
		const fetchJson: FetchJson = async () => response([githubRepo()]);
		await runSync({ db, targets: [TARGET], logger: makeLogger(), now: NOW, fetchJson });
		expect(state.selectWhere).toHaveLength(1);
		const selectSql = renderCondition(state.selectWhere[0]);
		expect(selectSql).toContain('"projects"."provider"');
		expect(selectSql).toContain('"projects"."external_id"');
		expect(state.updateWhere).toHaveLength(1);
		expect(renderCondition(state.updateWhere[0])).toContain('"projects"."id"');
	});

	it('leaves rejected rows untouched in refresh mode', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [
			[
				{
					id: 'row-1',
					provider: 'github',
					projectUrl: 'https://github.com/guang/reborn',
					status: 'rejected'
				}
			]
		];
		const fetchJson: FetchJson = async () => {
			throw new Error('must not fetch');
		};
		const summary = await runSync({
			db,
			targets: [],
			refreshIds: ['row-1'],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.skipped).toBe(1);
		expect(state.updates).toHaveLength(0);
	});

	it('skips refresh rows whose URL provider no longer matches the row', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [
			[
				{
					id: 'row-1',
					provider: 'github',
					projectUrl: 'https://gitlab.com/group/project',
					status: 'pending'
				}
			]
		];
		const fetchJson: FetchJson = async () => {
			throw new Error('must not fetch');
		};
		const summary = await runSync({
			db,
			targets: [],
			refreshIds: ['row-1'],
			logger: makeLogger(),
			now: NOW,
			fetchJson
		});
		expect(summary.skipped).toBe(1);
		expect(state.updates).toHaveLength(0);
	});

	it('dry-run refresh writes nothing, even on failures', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [
			[
				{
					id: 'row-1',
					provider: 'github',
					projectUrl: 'https://github.com/guang/reborn',
					status: 'pending'
				}
			]
		];
		const fetchJson: FetchJson = async () => {
			throw new ProjectsFetchError('not_found', 'HTTP 404', 404);
		};
		const summary = await runSync({
			db,
			targets: [],
			refreshIds: ['row-1'],
			logger: makeLogger(),
			now: NOW,
			fetchJson,
			dryRun: true
		});
		expect(summary.failed).toBe(1);
		expect(state.updates).toHaveLength(0);
	});

	it('rethrows the original 23505 when the raced row cannot be found', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[], []];
		state.insertError = Object.assign(new Error('duplicate key value violates unique constraint'), {
			cause: { code: '23505' }
		});
		const fetchJson: FetchJson = async () => response([githubRepo()]);
		await expect(
			runSync({ db, targets: [TARGET], logger: makeLogger(), now: NOW, fetchJson })
		).rejects.toThrow(/duplicate key/);
		expect(state.updates).toHaveLength(0);
	});

	it('warns when a list stops at the pagination cap', async () => {
		const { state, db } = makeFakeDb();
		state.selectQueue = [[]];
		const fetchJson: FetchJson = async () =>
			response([githubRepo()], {
				link: '<https://api.github.com/users/guang/repos?page=2>; rel="next"'
			});
		const logger = makeLogger();
		await runSync({ db, targets: [TARGET], logger, now: NOW, fetchJson });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('truncated at the pagination cap')
		);
	});
});
