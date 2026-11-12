import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkSiteMock } = vi.hoisted(() => ({ checkSiteMock: vi.fn() }));
vi.mock('./check-site', () => ({ checkSite: checkSiteMock }));

import { PrecheckError, executePrecheck, runPrecheck } from './precheck';

const now = new Date('2026-11-11T00:00:00.000Z');
const link = { id: 'link-1', url: 'https://example.com', backlinkUrl: 'https://example.com/links' };
const config = {
	checks: { enabled: true, timeoutMs: 5_000 },
	policy: { acceptedBacklinkHosts: [] }
};
const deps = { fetchDeps: { fetch: vi.fn() } as never, now: () => now };

interface FakeOptions {
	lastCompleted?: { finishedAt: Date | null } | null;
	insertError?: unknown;
	/** Simulate the FK cascade removing the run while the network check runs. */
	completeEmpty?: boolean;
}

function fakeDb(options: FakeOptions = {}) {
	const sets: Record<string, unknown>[] = [];
	const inserted: Record<string, unknown>[] = [];
	const runningRow = { id: 'run-1', linkId: link.id, status: 'running', ok: null };

	const db = {
		update: () => ({
			set: (value: Record<string, unknown>) => {
				sets.push(value);
				return {
					where: () => ({
						returning: async () =>
							options.completeEmpty && value.status === 'completed'
								? []
								: [{ ...runningRow, ...value, id: runningRow.id }]
					})
				};
			}
		}),
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: async () => (options.lastCompleted ? [options.lastCompleted] : [])
					})
				})
			})
		}),
		insert: () => ({
			values: (value: Record<string, unknown>) => {
				inserted.push(value);
				return {
					returning: async () => {
						if (options.insertError) throw options.insertError;
						return [runningRow];
					}
				};
			}
		})
	};

	return { db: db as never, sets, inserted };
}

beforeEach(() => checkSiteMock.mockReset());

describe('runPrecheck', () => {
	it('is ok only when both axes pass', async () => {
		checkSiteMock.mockResolvedValue({
			reach: 'ok',
			backlink: 'missing',
			entries: [
				{ at: now.toISOString(), kind: 'reachability', ok: true },
				{ at: now.toISOString(), kind: 'backlink', ok: false, err: 'link_missing' }
			]
		});

		const outcome = await runPrecheck(link, config, deps);

		expect(outcome.ok).toBe(false);
		expect(outcome.reach).toBe('ok');
		expect(outcome.backlink).toBe('missing');
		expect(outcome.errorKind).toBe('link_missing');
	});

	it('records a skipped outcome when checks are disabled', async () => {
		const outcome = await runPrecheck(
			link,
			{ ...config, checks: { enabled: false, timeoutMs: 5_000 } },
			deps
		);

		expect(outcome).toMatchObject({
			ok: false,
			reach: 'skipped',
			backlink: 'skipped',
			note: 'precheck: disabled'
		});
		expect(checkSiteMock).not.toHaveBeenCalled();
	});
});

describe('executePrecheck', () => {
	it('reclaims a stale running row before taking the slot', async () => {
		checkSiteMock.mockResolvedValue({
			reach: 'ok',
			backlink: 'ok',
			entries: [
				{ at: now.toISOString(), kind: 'reachability', ok: true },
				{ at: now.toISOString(), kind: 'backlink', ok: true }
			]
		});
		const { db, sets } = fakeDb();

		const run = await executePrecheck({ db, link, trigger: 'admin', config, deps });

		expect(sets[0]).toMatchObject({ status: 'stale' });
		expect(sets.at(-1)).toMatchObject({ status: 'completed', ok: true });
		expect(run.status).toBe('completed');
	});

	it('refuses a manual run while checks are disabled, writing nothing', async () => {
		const { db, sets, inserted } = fakeDb();

		await expect(
			executePrecheck({
				db,
				link,
				trigger: 'admin',
				config: { ...config, checks: { enabled: false, timeoutMs: 5_000 } },
				deps
			})
		).rejects.toBeInstanceOf(PrecheckError);
		expect(sets).toHaveLength(0);
		expect(inserted).toHaveLength(0);
	});

	it('records the skipped run for an application when checks are disabled', async () => {
		const { db, sets } = fakeDb();

		await executePrecheck({
			db,
			link,
			trigger: 'application',
			config: { ...config, checks: { enabled: false, timeoutMs: 5_000 } },
			deps
		});

		expect(sets.at(-1)).toMatchObject({
			status: 'completed',
			ok: false,
			note: 'precheck: disabled'
		});
	});

	it('maps the running-unique conflict to busy', async () => {
		const { db } = fakeDb({
			insertError: { code: '23505', constraint: 'link_prechecks_running_uniq' }
		});

		await expect(
			executePrecheck({ db, link, trigger: 'admin', config, deps })
		).rejects.toMatchObject({ code: 'busy' });
	});

	it('throws missing instead of returning a phantom run when the link was deleted', async () => {
		checkSiteMock.mockResolvedValue({
			reach: 'ok',
			backlink: 'ok',
			entries: [
				{ at: now.toISOString(), kind: 'reachability', ok: true },
				{ at: now.toISOString(), kind: 'backlink', ok: true }
			]
		});
		const { db } = fakeDb({ completeEmpty: true });

		await expect(
			executePrecheck({ db, link, trigger: 'admin', config, deps })
		).rejects.toMatchObject({ code: 'missing' });
	});

	it('enforces the cooldown from the newest completed run', async () => {
		const recent = fakeDb({ lastCompleted: { finishedAt: new Date(now.getTime() - 10_000) } });
		await expect(
			executePrecheck({ db: recent.db, link, trigger: 'admin', config, deps })
		).rejects.toMatchObject({ code: 'busy' });

		const old = fakeDb({ lastCompleted: { finishedAt: new Date(now.getTime() - 40_000) } });
		checkSiteMock.mockResolvedValue({ reach: 'ok', backlink: 'ok', entries: [] });
		await expect(
			executePrecheck({ db: old.db, link, trigger: 'admin', config, deps })
		).resolves.toMatchObject({ id: 'run-1' });
	});
});
