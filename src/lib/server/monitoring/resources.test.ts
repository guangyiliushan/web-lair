import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	RESOURCE_CLEAR_PERCENT,
	RESOURCE_WARN_PERCENT,
	collectResourceSnapshot,
	defaultMounts,
	emptyResourceState,
	evaluateReadings,
	readCgroupMemory,
	readMountUsage,
	readResourceState,
	resourceStatePath,
	sameResourceState,
	usedPercentOf,
	writeResourceState,
	type MetricState,
	type ResourceSnapshot
} from './resources';

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'wl-resources-'));
	tempDirs.push(dir);
	return dir;
}

const statfsOf =
	(freeRatio: number) => async (): Promise<{ blocks: number; bsize: number; bavail: number }> => ({
		blocks: 1000,
		bsize: 1000,
		bavail: Math.round(1000 * freeRatio)
	});

function readFileFrom(files: Record<string, string>, missing = false) {
	return async (path: string): Promise<string> => {
		if (missing || !(path in files)) {
			const error = new Error(`ENOENT: no such file, open '${path}'`) as Error & { code: string };
			error.code = 'ENOENT';
			throw error;
		}
		return files[path]!;
	};
}

/** `readCgroupMemory` joins under the root, so fixtures must too (Windows). */
const cg = (name: string) => join('/cg', name);

describe('usedPercentOf', () => {
	it('reports one decimal of used space', () => {
		expect(usedPercentOf(1000, 150)).toBe(85);
		expect(usedPercentOf(1000, 250)).toBe(75);
		expect(usedPercentOf(3, 1)).toBe(66.7);
	});

	it('is null when the size is unusable', () => {
		expect(usedPercentOf(0, 0)).toBeNull();
		expect(usedPercentOf(Number.NaN, 1)).toBeNull();
	});
});

describe('readMountUsage', () => {
	it('reads total/free bytes and derives the percentage', async () => {
		const { reading, error } = await readMountUsage(
			{ mount: '/data', label: 'data' },
			statfsOf(0.1)
		);
		expect(error).toBeNull();
		expect(reading).toMatchObject({
			key: 'disk:/data',
			mount: '/data',
			label: 'data',
			totalBytes: 1_000_000,
			freeBytes: 100_000,
			usedPercent: 90
		});
	});

	it('records a statfs failure instead of throwing', async () => {
		const { reading, error } = await readMountUsage({ mount: '/data', label: 'data' }, async () => {
			throw new Error('EACCES: permission denied');
		});
		expect(reading).toBeNull();
		expect(error).toContain('disk /data');
	});
});

describe('readCgroupMemory', () => {
	it('reads memory.current vs memory.max', async () => {
		const { reading, error } = await readCgroupMemory(
			readFileFrom({ [cg('memory.current')]: '512\n', [cg('memory.max')]: '1024\n' }),
			'/cg'
		);
		expect(error).toBeNull();
		expect(reading).toEqual({
			key: 'memory:cgroup',
			source: 'cgroup-v2',
			currentBytes: 512,
			maxBytes: 1024,
			usedPercent: 50
		});
	});

	it('reports usage without a percentage when memory.max is unlimited', async () => {
		const { reading } = await readCgroupMemory(
			readFileFrom({ [cg('memory.current')]: '2048', [cg('memory.max')]: 'max' }),
			'/cg'
		);
		expect(reading).toMatchObject({ currentBytes: 2048, maxBytes: null, usedPercent: null });
	});

	it('is "not observable" (no error) when cgroup v2 files are absent', async () => {
		const { reading, error } = await readCgroupMemory(readFileFrom({}), '/cg');
		expect(reading).toBeNull();
		expect(error).toBeNull();
	});

	it('flags an unparsable limit', async () => {
		const { reading, error } = await readCgroupMemory(
			readFileFrom({ [cg('memory.current')]: '10', [cg('memory.max')]: 'lots' }),
			'/cg'
		);
		expect(reading).toBeNull();
		expect(error).toContain('memory max');
	});

	it('treats an empty memory.current as unparsable, not 0%', async () => {
		const { reading, error } = await readCgroupMemory(
			readFileFrom({ [cg('memory.current')]: '  ', [cg('memory.max')]: '1024' }),
			'/cg'
		);
		expect(reading).toBeNull();
		expect(error).toContain('memory current');
	});

	it.each([
		['', 'empty'],
		['0', 'zero']
	])('rejects memory.max = %j (%s) instead of reporting a bogus percent', async (rawMax) => {
		const { reading, error } = await readCgroupMemory(
			readFileFrom({ [cg('memory.current')]: '10', [cg('memory.max')]: rawMax }),
			'/cg'
		);
		expect(reading).toBeNull();
		expect(error).toContain('memory max');
	});
});

describe('collectResourceSnapshot', () => {
	it('measures DATA_DIR and / once each and collects the memory reading', async () => {
		const calls: string[] = [];
		const snapshot = await collectResourceSnapshot({
			mounts: defaultMounts('/data'),
			statImpl: async (path) => ({ dev: path === '/data' ? 1 : 2 }),
			statfsImpl: async (path) => {
				calls.push(path);
				return { blocks: 100, bsize: 10, bavail: 10 };
			},
			readFileImpl: readFileFrom({
				[cg('memory.current')]: '1',
				[cg('memory.max')]: '4'
			}),
			cgroupRoot: '/cg'
		});
		expect(calls).toEqual(['/data', '/']);
		expect(snapshot.disks.map((disk) => disk.key)).toEqual(['disk:/data', 'disk:/']);
		expect(snapshot.memory?.usedPercent).toBe(25);
		expect(snapshot.errors).toEqual([]);
		expect(snapshot.skipped).toEqual([]);
	});

	it('de-duplicates identical mounts and surfaces collection errors', async () => {
		let calls = 0;
		const snapshot = await collectResourceSnapshot({
			mounts: [
				{ mount: '/data', label: 'data' },
				{ mount: '/data', label: 'again' }
			],
			statfsImpl: async () => {
				calls += 1;
				throw new Error('EIO');
			},
			readFileImpl: readFileFrom({}),
			cgroupRoot: '/cg'
		});
		expect(calls).toBe(1);
		expect(snapshot.disks).toEqual([]);
		expect(snapshot.errors).toHaveLength(1);
		expect(snapshot.skipped).toEqual([{ mount: '/data', label: 'again', reason: 'duplicate' }]);
	});

	it('measures one filesystem once (same device: DATA_DIR on the root volume)', async () => {
		const calls: string[] = [];
		const snapshot = await collectResourceSnapshot({
			mounts: defaultMounts('/data'),
			statImpl: async () => ({ dev: 42 }),
			statfsImpl: async (path) => {
				calls.push(path);
				return { blocks: 100, bsize: 10, bavail: 40 };
			},
			readFileImpl: readFileFrom({}),
			cgroupRoot: '/cg'
		});
		expect(calls).toEqual(['/data']);
		expect(snapshot.disks.map((disk) => disk.key)).toEqual(['disk:/data']);
		expect(snapshot.skipped).toEqual([{ mount: '/', label: 'root', reason: 'same-device' }]);
	});
});

describe('evaluateReadings hysteresis + daily dedupe', () => {
	const disk = (usedPercent: number) => ({
		key: 'disk:/data',
		kind: 'disk' as const,
		usedPercent,
		mount: '/data'
	});

	it('alerts at the warn line and not again on the same day', () => {
		const first = evaluateReadings([disk(85)], emptyResourceState(), '2026-11-15');
		expect(first.alerts).toEqual([
			expect.objectContaining({ key: 'disk:/data', status: 'warn', usedPercent: 85 })
		]);
		expect(first.nextState.metrics['disk:/data']).toEqual({
			status: 'warn',
			alertDay: '2026-11-15'
		});

		const second = evaluateReadings([disk(86)], first.nextState, '2026-11-15');
		expect(second.alerts).toEqual([]);
		expect(second.nextState.metrics['disk:/data']).toEqual({
			status: 'warn',
			alertDay: '2026-11-15'
		});
	});

	it('alerts again on the next day while still over the line', () => {
		const state = {
			version: 1 as const,
			metrics: { 'disk:/data': { status: 'warn' as const, alertDay: '2026-11-15' } }
		};
		const next = evaluateReadings([disk(90)], state, '2026-11-16');
		expect(next.alerts).toHaveLength(1);
		expect(next.nextState.metrics['disk:/data']?.alertDay).toBe('2026-11-16');
	});

	it('holds the latch inside the 75-85% band (no flap)', () => {
		const state = {
			version: 1 as const,
			metrics: { 'disk:/data': { status: 'warn' as const, alertDay: '2026-11-15' } }
		};
		const next = evaluateReadings([disk(80)], state, '2026-11-16');
		expect(next.alerts).toEqual([]);
		expect(next.clears).toEqual([]);
		expect(next.nextState.metrics['disk:/data']).toEqual({
			status: 'warn',
			alertDay: '2026-11-15'
		});
	});

	it('applies the daily cap per metric, not globally', () => {
		// disk already alerted today; memory breaches the same day. A global cap
		// would suppress the memory alert; the per-metric cap must not.
		const state = {
			version: 1 as const,
			metrics: {
				'disk:/data': { status: 'warn' as const, alertDay: '2026-11-15' },
				'memory:cgroup': { status: 'ok' as const, alertDay: null }
			}
		};
		const next = evaluateReadings(
			[disk(90), { key: 'memory:cgroup', kind: 'memory' as const, usedPercent: 95 }],
			state,
			'2026-11-15'
		);
		expect(next.alerts).toEqual([
			expect.objectContaining({ key: 'memory:cgroup', status: 'warn' })
		]);
		expect(next.nextState.metrics['memory:cgroup']).toEqual({
			status: 'warn',
			alertDay: '2026-11-15'
		});
	});

	it('drops a latch for a metric that is no longer observed (clean collection)', () => {
		const state = {
			version: 1 as const,
			metrics: { 'disk:/old': { status: 'warn' as const, alertDay: '2026-11-01' } }
		};
		const next = evaluateReadings([disk(40)], state, '2026-11-16');
		expect(next.dropped).toEqual(['disk:/old']);
		expect(next.nextState.metrics['disk:/old']).toBeUndefined();
	});

	it('keeps unobserved latches when collection reported an error', () => {
		const state = {
			version: 1 as const,
			metrics: { 'disk:/old': { status: 'warn' as const, alertDay: '2026-11-01' } }
		};
		const next = evaluateReadings([disk(40)], state, '2026-11-16', { keepUnobserved: true });
		expect(next.dropped).toEqual([]);
		expect(next.nextState.metrics['disk:/old']).toEqual({
			status: 'warn',
			alertDay: '2026-11-01'
		});
	});

	it('clears at the release line and records the clear', () => {
		const state = {
			version: 1 as const,
			metrics: { 'disk:/data': { status: 'warn' as const, alertDay: '2026-11-15' } }
		};
		const next = evaluateReadings([disk(RESOURCE_CLEAR_PERCENT)], state, '2026-11-16');
		expect(next.clears).toEqual([expect.objectContaining({ key: 'disk:/data', status: 'clear' })]);
		// alertDay survives: the daily cap must not be reopened by a dip.
		expect(next.nextState.metrics['disk:/data']).toEqual({
			status: 'ok',
			alertDay: '2026-11-15'
		});
	});

	it('does not alert twice in one day after a clear-and-recross', () => {
		const state = {
			version: 1 as const,
			metrics: { 'disk:/data': { status: 'warn' as const, alertDay: '2026-11-16' } }
		};
		const dipped = evaluateReadings([disk(70)], state, '2026-11-16');
		expect(dipped.clears).toHaveLength(1);
		const bounced = evaluateReadings([disk(91)], dipped.nextState, '2026-11-16');
		expect(bounced.alerts).toEqual([]);
		expect(bounced.nextState.metrics['disk:/data']).toEqual({
			status: 'warn',
			alertDay: '2026-11-16'
		});

		const nextDay = evaluateReadings([disk(91)], bounced.nextState, '2026-11-17');
		expect(nextDay.alerts).toHaveLength(1);
	});

	it('does not alert below the warn line and ignores unlimited memory', () => {
		const next = evaluateReadings(
			[disk(84.9), { key: 'memory:cgroup', kind: 'memory', usedPercent: null }],
			emptyResourceState(),
			'2026-11-15'
		);
		expect(next.alerts).toEqual([]);
		expect(next.nextState.metrics['disk:/data']).toEqual({ status: 'ok', alertDay: null });
		expect(next.nextState.metrics['memory:cgroup']).toBeUndefined();
	});

	it('keeps the thresholds at the planned values', () => {
		expect(RESOURCE_WARN_PERCENT).toBe(85);
		expect(RESOURCE_CLEAR_PERCENT).toBe(75);
	});
});

describe('resource state file', () => {
	it('round-trips, compares and tolerates corruption', async () => {
		const dir = await tempDir();
		const path = resourceStatePath(dir);
		expect(path).toBe(join(dir, 'system-resources-state.json'));

		const state = {
			version: 1 as const,
			metrics: { 'disk:/data': { status: 'warn' as const, alertDay: '2026-11-15' } }
		};
		await writeResourceState(path, state);
		await expect(readResourceState(path)).resolves.toEqual(state);
		expect(sameResourceState(state, await readResourceState(path))).toBe(true);
		expect(sameResourceState(state, emptyResourceState())).toBe(false);

		// The state file may hold secrets-free numbers only; corrupt input resets.
		await writeFile(path, '{ not json');
		await expect(readResourceState(path)).resolves.toEqual(emptyResourceState());
		await expect(readResourceState(join(dir, 'missing.json'))).resolves.toEqual(
			emptyResourceState()
		);
	});

	it('normalises unknown statuses away instead of trusting the file', async () => {
		const dir = await tempDir();
		const path = join(dir, 'state.json');
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				metrics: { 'disk:/': { status: 'exploded', alertDay: 1 }, 'disk:/data': { status: 'ok' } }
			})
		);
		const state = await readResourceState(path);
		expect(state.metrics['disk:/']).toBeUndefined();
		expect(state.metrics['disk:/data']).toEqual({ status: 'ok', alertDay: null });
	});

	it('resets a state file written by a different schema version', async () => {
		const dir = await tempDir();
		const path = join(dir, 'state.json');
		await writeFile(
			path,
			JSON.stringify({
				version: 2,
				metrics: { 'disk:/data': { status: 'warn', alertDay: '2026-11-15' } }
			})
		);
		await expect(readResourceState(path)).resolves.toEqual(emptyResourceState());
	});

	it('writes the state file with owner-only permissions where the OS honours it', async () => {
		const dir = await tempDir();
		const path = resourceStatePath(dir);
		await writeResourceState(path, emptyResourceState());
		// Readable content is the contract; mode is best-effort on Windows.
		await expect(readFile(path, 'utf8')).resolves.toContain('"version": 1');
		if (process.platform !== 'win32') {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
	});
});

// Type-level guard: the fixture above must stay assignable.
const _stateType: MetricState = { status: 'ok', alertDay: null };
const _snapshotType: ResourceSnapshot = { disks: [], memory: null, skipped: [], errors: [] };
void _stateType;
void _snapshotType;
