import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * job-schedules service tests (J-3): the validation gate (5-field cron, Intl
 * probe, PG membership, cron-parser trial) and the watermark rules of §3.2 -
 * create/enable reset `last_due_at`, a cron/tz edit resets it, a no-op edit
 * does not. Audit rows must ride the same transaction path (fake db records
 * the captured sets/values; recordActivity is captured per call).
 */

const { auditRows } = vi.hoisted(() => ({ auditRows: [] as Record<string, unknown>[] }));

vi.mock('../audit.ts', () => ({
	recordActivity: vi.fn(async (_executor: unknown, input: Record<string, unknown>) => {
		auditRows.push(input);
	})
}));
vi.mock('../pg-timezone.ts', () => ({
	isPgAcceptableTimeZone: vi.fn(async (tz: string) => tz !== 'Japan'),
	// type-only export; the value stands in for the interface
	PgTimeZoneExecutor: undefined
}));
vi.mock('./user-layer.ts', () => ({
	resolveJobDefinition: vi.fn(async (name: string) => (name === 'known' ? { name } : null))
}));

import {
	createSchedule,
	deleteSchedule,
	listSchedules,
	toggleSchedule,
	updateSchedule,
	validateScheduleInput
} from './job-schedules';

interface FakeState {
	selectQueue: unknown[][];
	insertRows: unknown[];
	insertError: Error | null;
	deleteRows: unknown[];
	updateRows: unknown[];
	updateError: Error | null;
	updateSets: unknown[];
	insertValues: unknown[];
	updateCount: number;
}

function makeDb(state: FakeState) {
	const makeSelect = () => ({
		from: () => {
			const terminal = {
				orderBy: async () => state.selectQueue.shift() ?? [],
				limit: async () => state.selectQueue.shift() ?? []
			};
			return {
				...terminal,
				where: () => terminal
			};
		}
	});
	const makeTx = () => ({
		insert: () => ({
			values: (values: unknown) => {
				state.insertValues.push(values);
				return {
					returning: async () => {
						if (state.insertError) throw state.insertError;
						return state.insertRows;
					}
				};
			}
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: () => ({
					returning: async () => {
						state.updateCount += 1;
						state.updateSets.push(values);
						if (state.updateError) throw state.updateError;
						return state.updateRows;
					}
				})
			})
		}),
		delete: () => ({
			where: () => ({
				returning: async () => state.deleteRows
			})
		})
	});
	return {
		select: makeSelect,
		insert: () => makeTx().insert(),
		update: () => makeTx().update(),
		delete: () => makeTx().delete(),
		transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx())
	} as never;
}

function freshState(): FakeState {
	return {
		selectQueue: [],
		insertRows: [{ id: 'sched-new' }],
		insertError: null,
		deleteRows: [{ id: 'sched-1', job: 'known' }],
		updateRows: [{ id: 'sched-1' }],
		updateError: null,
		updateSets: [],
		insertValues: [],
		updateCount: 0
	};
}

let state: FakeState;
let db: never;

beforeEach(() => {
	auditRows.length = 0;
	state = freshState();
	db = makeDb(state);
});

const dupError = () => Object.assign(new Error('duplicate key'), { cause: { code: '23505' } });

describe('validateScheduleInput', () => {
	it('accepts a 5-field cron with a PG-acceptable zone and trims input', async () => {
		const ok = await validateScheduleInput({ cronExpr: '  */15 * * * * ', tz: ' Etc/UTC ' }, db);
		expect(ok).toEqual({ ok: true, cronExpr: '*/15 * * * *', tz: 'Etc/UTC' });
	});

	it('rejects seconds-bearing and short expressions through the drain gate', async () => {
		const six = await validateScheduleInput({ cronExpr: '0 4 * * * *', tz: 'Etc/UTC' }, db);
		expect(six.ok).toBe(false);
		if (!six.ok) expect(six.message).toContain('5 fields');
		const four = await validateScheduleInput({ cronExpr: '0 4 * *', tz: 'Etc/UTC' }, db);
		expect(four.ok).toBe(false);
	});

	it('rejects offset-shaped zones via Intl and ICU-unreachable zones via PG', async () => {
		const offset = await validateScheduleInput({ cronExpr: '0 4 * * *', tz: '+08:00' }, db);
		expect(offset.ok).toBe(false);
		if (!offset.ok) expect(offset.message).toContain('IANA');
		// 'Japan' passes the Intl probe (probed in the notes line) - only the
		// pg_timezone_names gate rejects it.
		const japan = await validateScheduleInput({ cronExpr: '0 4 * * *', tz: 'Japan' }, db);
		expect(japan.ok).toBe(false);
		if (!japan.ok) expect(japan.message).toContain('PostgreSQL');
	});

	it('rejects empty fields with field-specific messages (J-3 review S10)', async () => {
		expect(await validateScheduleInput({ cronExpr: '  ', tz: 'Etc/UTC' }, db)).toEqual({
			ok: false,
			message: 'cron 表达式不能为空'
		});
		expect(await validateScheduleInput({ cronExpr: '0 4 * * *', tz: '  ' }, db)).toEqual({
			ok: false,
			message: '时区不能为空'
		});
	});

	it('rejects values that pass the 5-field gate but not cron-parser (J-3 review S13)', async () => {
		for (const expr of ['61 4 * * *', '0 25 * * *']) {
			const result = await validateScheduleInput({ cronExpr: expr, tz: 'Etc/UTC' }, db);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.message).toContain('无法解析');
		}
	});
});

describe('createSchedule', () => {
	it('creates with the watermark reset and audits in the transaction path', async () => {
		const result = await createSchedule({
			db,
			dataDir: '/data',
			job: 'known',
			cronExpr: '0 4 * * *',
			tz: 'Etc/UTC',
			actorId: 'admin-1'
		});
		expect(result).toEqual({ kind: 'created', id: 'sched-new' });
		expect(state.insertValues[0]).toMatchObject({
			job: 'known',
			cronExpr: '0 4 * * *',
			tz: 'Etc/UTC',
			isEnabled: true
		});
		expect((state.insertValues[0] as { lastDueAt: unknown }).lastDueAt).toBeInstanceOf(Date);
		expect(auditRows[0]).toMatchObject({
			event: 'schedule.create',
			actorId: 'admin-1',
			payload: { job: 'known', cron_expr: '0 4 * * *', tz: 'Etc/UTC' }
		});
	});

	it('rejects unknown jobs before any validation or write', async () => {
		const result = await createSchedule({
			db,
			dataDir: '/data',
			job: 'ghost',
			cronExpr: '0 4 * * *',
			tz: 'Etc/UTC',
			actorId: null
		});
		expect(result.kind).toBe('unknown-job');
		expect(state.insertValues).toHaveLength(0);
	});

	it('surfaces validation failures without writing', async () => {
		const result = await createSchedule({
			db,
			dataDir: '/data',
			job: 'known',
			cronExpr: '0 4 * *',
			tz: 'Etc/UTC',
			actorId: null
		});
		expect(result.kind).toBe('invalid');
		expect(state.insertValues).toHaveLength(0);
		expect(auditRows).toHaveLength(0);
	});

	it('resolves the job before validating the cron (J-3 review S14)', async () => {
		const result = await createSchedule({
			db,
			dataDir: '/data',
			job: 'ghost',
			cronExpr: '0 4 * *',
			tz: 'Etc/UTC',
			actorId: null
		});
		// Order pinned: the job probe runs first, so a ghost + bad cron is
		// unknown-job - swapping the order would answer invalid.
		expect(result.kind).toBe('unknown-job');
	});

	it('maps 23505 to a duplicate result (no audit row)', async () => {
		state.insertError = dupError();
		const result = await createSchedule({
			db,
			dataDir: '/data',
			job: 'known',
			cronExpr: '0 4 * * *',
			tz: 'Etc/UTC',
			actorId: null
		});
		expect(result.kind).toBe('duplicate');
		expect(auditRows).toHaveLength(0);
	});
});

describe('updateSchedule / toggleSchedule / deleteSchedule', () => {
	it('resets the watermark when the due grid moves and keeps it on a no-op edit', async () => {
		state.selectQueue.push([{ job: 'known', cronExpr: '0 4 * * *', tz: 'Etc/UTC' }]);
		const moved = await updateSchedule({
			db,
			id: 'sched-1',
			cronExpr: '0 5 * * *',
			tz: 'Etc/UTC',
			actorId: 'admin-1'
		});
		expect(moved).toEqual({ kind: 'updated', id: 'sched-1', watermarkReset: true });
		expect(state.updateSets[0]).toMatchObject({ cronExpr: '0 5 * * *', tz: 'Etc/UTC' });
		expect((state.updateSets[0] as { lastDueAt?: unknown }).lastDueAt).toBeInstanceOf(Date);
		expect(auditRows[0]).toMatchObject({
			event: 'schedule.update',
			payload: { watermark_reset: true }
		});

		state.selectQueue.push([{ job: 'known', cronExpr: '0 5 * * *', tz: 'Etc/UTC' }]);
		const noop = await updateSchedule({
			db,
			id: 'sched-1',
			cronExpr: '0 5 * * *',
			tz: 'Etc/UTC',
			actorId: null
		});
		expect(noop).toMatchObject({ kind: 'updated', watermarkReset: false });
		expect(state.updateSets[1]).toEqual({ cronExpr: '0 5 * * *', tz: 'Etc/UTC' });
	});

	it('reports not-found when the update target does not exist', async () => {
		state.selectQueue.push([]);
		expect(
			await updateSchedule({ db, id: 'sched-x', cronExpr: '0 5 * * *', tz: 'UTC', actorId: null })
		).toEqual({ kind: 'not-found' });
	});

	it('resets the watermark when only the timezone changes (J-3 review S4)', async () => {
		state.selectQueue.push([{ job: 'known', cronExpr: '0 4 * * *', tz: 'Etc/UTC' }]);
		const result = await updateSchedule({
			db,
			id: 'sched-1',
			cronExpr: '0 4 * * *',
			tz: 'Asia/Tokyo',
			actorId: null
		});
		expect(result).toMatchObject({ kind: 'updated', watermarkReset: true });
		expect((state.updateSets[0] as { lastDueAt?: unknown }).lastDueAt).toBeInstanceOf(Date);
	});

	it('maps a 23505 update to duplicate with no audit row (J-3 review S6)', async () => {
		state.selectQueue.push([{ job: 'known', cronExpr: '0 4 * * *', tz: 'Etc/UTC' }]);
		state.updateError = dupError();
		const result = await updateSchedule({
			db,
			id: 'sched-1',
			cronExpr: '0 5 * * *',
			tz: 'Etc/UTC',
			actorId: null
		});
		expect(result).toEqual({ kind: 'duplicate' });
		expect(auditRows).toHaveLength(0);
	});

	it('answers not-found when the row vanishes between read and write (J-3 review J3-2)', async () => {
		state.selectQueue.push([{ job: 'known', cronExpr: '0 4 * * *', tz: 'Etc/UTC' }]);
		state.updateRows = [];
		expect(
			await updateSchedule({
				db,
				id: 'sched-1',
				cronExpr: '0 5 * * *',
				tz: 'Etc/UTC',
				actorId: null
			})
		).toEqual({ kind: 'not-found' });

		state.selectQueue.push([{ job: 'known', isEnabled: true }]);
		expect(await toggleSchedule({ db, id: 'sched-1', actorId: null })).toEqual({
			kind: 'not-found'
		});
		expect(auditRows).toHaveLength(0);
	});

	it('toggle: enabling resets the watermark, disabling does not', async () => {
		state.selectQueue.push([{ job: 'known', isEnabled: false }]);
		expect(await toggleSchedule({ db, id: 'sched-1', actorId: 'admin-1' })).toEqual({
			kind: 'toggled',
			id: 'sched-1',
			enabled: true
		});
		expect(state.updateSets[0]).toMatchObject({ isEnabled: true });
		expect((state.updateSets[0] as { lastDueAt?: unknown }).lastDueAt).toBeInstanceOf(Date);

		state.selectQueue.push([{ job: 'known', isEnabled: true }]);
		expect(await toggleSchedule({ db, id: 'sched-1', actorId: null })).toMatchObject({
			enabled: false
		});
		expect(state.updateSets[1]).toEqual({ isEnabled: false });
		expect(auditRows[1]).toMatchObject({ event: 'schedule.toggle', payload: { enabled: false } });
	});

	it('toggle reports not-found for unknown rows', async () => {
		state.selectQueue.push([]);
		expect(await toggleSchedule({ db, id: 'sched-x', actorId: null })).toEqual({
			kind: 'not-found'
		});
	});

	it('delete: audits in the transaction and reports not-found on zero rows', async () => {
		const ok = await deleteSchedule({ db, id: 'sched-1', actorId: 'admin-1' });
		expect(ok).toEqual({ kind: 'deleted', id: 'sched-1' });
		expect(auditRows[0]).toMatchObject({
			event: 'schedule.delete',
			actorId: 'admin-1',
			payload: { job: 'known' }
		});

		state.deleteRows = [];
		expect(await deleteSchedule({ db, id: 'sched-x', actorId: null })).toEqual({
			kind: 'not-found'
		});
	});
});

describe('listSchedules', () => {
	it('returns the rows from the query', async () => {
		const row = {
			id: 's1',
			job: 'known',
			cronExpr: '0 4 * * *',
			tz: 'Etc/UTC',
			isEnabled: true,
			lastDueAt: null,
			createdAt: new Date(),
			updatedAt: new Date()
		};
		state.selectQueue.push([row]);
		expect(await listSchedules(db)).toEqual([row]);
	});
});
