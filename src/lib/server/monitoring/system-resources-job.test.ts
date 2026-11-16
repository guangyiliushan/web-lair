import { describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../jobs/types.ts';
import type { NotificationEvent } from '../notifications/notify.ts';
import { defaultMounts, resourceStatePath, type ResourceSnapshot } from './resources.ts';
import { runSystemResources, type SystemResourcesDeps } from './system-resources-job';

interface Harness {
	ctx: JobContext;
	summaries: Array<Record<string, unknown>>;
	logs: { info: string[]; warn: string[]; error: string[] };
}

function harness(): Harness {
	const summaries: Array<Record<string, unknown>> = [];
	const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
	const ctx = {
		job: 'system.resources',
		trigger: 'cli',
		db: {},
		logger: {
			info: (line: string) => logs.info.push(line),
			warn: (line: string) => logs.warn.push(line),
			error: (line: string) => logs.error.push(line)
		},
		summary: (data: Record<string, unknown>) => summaries.push(data)
	} as unknown as JobContext;
	return { ctx, summaries, logs };
}

const NOW = new Date('2026-11-15T12:00:00Z');

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
	return {
		disks: [
			{
				key: 'disk:/data',
				mount: '/data',
				label: 'data',
				totalBytes: 1000,
				freeBytes: 600,
				usedPercent: 40
			}
		],
		memory: {
			key: 'memory:cgroup',
			source: 'cgroup-v2',
			currentBytes: 256,
			maxBytes: 1024,
			usedPercent: 25
		},
		skipped: [],
		errors: [],
		...overrides
	};
}

function deps(overrides: Partial<SystemResourcesDeps> = {}): SystemResourcesDeps {
	return {
		dataDir: 'C:/wl-data',
		collect: vi.fn(async () => snapshot()),
		readState: vi.fn(async () => ({ version: 1 as const, metrics: {} })),
		writeState: vi.fn(async () => {}),
		notify: vi.fn(async () => 'delivered' as const),
		ping: vi.fn(async (_probe: string, status: 'ok' | 'fail') =>
			status === 'fail' ? ('fail' as const) : ('ok' as const)
		),
		now: () => NOW,
		host: {
			totalmem: () => 8_000,
			freemem: () => 6_000,
			loadavg: () => [0.5, 0.4, 0.3],
			uptime: () => 3600
		},
		...overrides
	};
}

describe('system.resources job (M6 P4)', () => {
	it('records each mount and pings healthchecks ok when everything is under the line', async () => {
		const { ctx, summaries } = harness();
		const injected = deps();
		await runSystemResources(ctx, injected);

		expect(injected.notify).not.toHaveBeenCalled();
		expect(injected.ping).toHaveBeenCalledWith('resources', 'ok');
		const summary = summaries[0]!;
		expect(summary.thresholds).toEqual({ warnPercent: 85, clearPercent: 75 });
		expect(summary.mounts).toEqual([
			{
				key: 'disk:/data',
				mount: '/data',
				label: 'data',
				totalBytes: 1000,
				freeBytes: 600,
				usedPercent: 40
			}
		]);
		expect(summary.memory).toEqual({
			source: 'cgroup-v2',
			currentBytes: 256,
			maxBytes: 1024,
			usedPercent: 25
		});
		expect(summary.alerts).toEqual([]);
		expect(summary.healthcheck).toEqual({ status: 'ok', ping: 'ok' });
		// The wiring, not just the snapshot: both mounts and the state path come
		// from deps.dataDir (a hard-coded root or path would mutate silently).
		expect(injected.collect).toHaveBeenCalledWith({ mounts: defaultMounts('C:/wl-data') });
		expect(injected.readState).toHaveBeenCalledWith(resourceStatePath('C:/wl-data'));
		// The latch gained one ok entry per metric, so the state file is written.
		expect(injected.writeState).toHaveBeenCalledTimes(1);
	});

	it('alerts a disk breach through the seam and pings fail', async () => {
		const { ctx, summaries, logs } = harness();
		const injected = deps({
			collect: vi.fn(async () =>
				snapshot({
					disks: [
						{
							key: 'disk:/data',
							mount: '/data',
							label: 'data',
							totalBytes: 1000,
							freeBytes: 50,
							usedPercent: 95
						}
					]
				})
			)
		});
		await runSystemResources(ctx, injected);

		expect(injected.notify).toHaveBeenCalledTimes(1);
		const event = (injected.notify as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as NotificationEvent;
		expect(event.eventType).toBe('system.disk_high');
		expect(event.eventKey).toBe('disk:/data:2026-11-15');
		expect(event.title).toContain('95%');
		expect(injected.ping).toHaveBeenCalledWith('resources', 'fail');
		expect(summaries[0]!.alerts).toEqual([
			{ key: 'disk:/data', kind: 'disk', usedPercent: 95, thresholdPercent: 85, mount: '/data' }
		]);
		expect(logs.warn.join('\n')).toContain('95%');
		// Ordering is load-bearing: the out-of-box ping must go out before a
		// (possibly hanging) notification sink, or the drain's timeout can kill
		// the tick between the condition and its external backstop (review P1-1).
		const pingOrder = (injected.ping as unknown as { mock: { invocationCallOrder: number[] } }).mock
			.invocationCallOrder[0]!;
		const notifyOrder = (injected.notify as unknown as { mock: { invocationCallOrder: number[] } })
			.mock.invocationCallOrder[0]!;
		expect(pingOrder).toBeLessThan(notifyOrder);
	});

	it('clears the daily latch when delivery fails so the next tick retries', async () => {
		const { ctx } = harness();
		const writeState = vi.fn<(path: string, state: unknown) => Promise<void>>(async () => {});
		const notify = vi.fn(async () => 'failed' as const);
		const injected = deps({
			collect: vi.fn(async () =>
				snapshot({
					disks: [
						{
							key: 'disk:/data',
							mount: '/data',
							label: 'data',
							totalBytes: 1000,
							freeBytes: 50,
							usedPercent: 95
						}
					]
				})
			),
			writeState,
			notify
		});

		await runSystemResources(ctx, injected);

		expect(notify).toHaveBeenCalledTimes(1);
		// First write latches the day; the second rewrites it without the latch
		// because the sink rejected the alert.
		expect(writeState).toHaveBeenCalledTimes(2);
		const persisted = writeState.mock.calls[1]![1] as {
			metrics: Record<string, { alertDay: string | null }>;
		};
		expect(persisted.metrics['disk:/data']!.alertDay).toBeNull();
	});

	it('routes a memory breach to system.memory_high', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({
			collect: vi.fn(async () =>
				snapshot({
					memory: {
						key: 'memory:cgroup',
						source: 'cgroup-v2',
						currentBytes: 900,
						maxBytes: 1000,
						usedPercent: 90
					}
				})
			)
		});
		await runSystemResources(ctx, injected);

		const event = (injected.notify as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as NotificationEvent;
		expect(event.eventType).toBe('system.memory_high');
		expect(event.eventKey).toBe('memory:cgroup:2026-11-15');
		expect(summaries[0]!.alerts).toEqual([
			{ key: 'memory:cgroup', kind: 'memory', usedPercent: 90, thresholdPercent: 85, mount: null }
		]);
	});

	it('does not re-alert the same metric on the same UTC day', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({
			readState: vi.fn(async () => ({
				version: 1 as const,
				metrics: {
					'disk:/data': { status: 'warn' as const, alertDay: '2026-11-15' },
					'memory:cgroup': { status: 'ok' as const, alertDay: null }
				}
			})),
			collect: vi.fn(async () =>
				snapshot({
					disks: [
						{
							key: 'disk:/data',
							mount: '/data',
							label: 'data',
							totalBytes: 1000,
							freeBytes: 100,
							usedPercent: 90
						}
					]
				})
			)
		});
		await runSystemResources(ctx, injected);

		expect(injected.notify).not.toHaveBeenCalled();
		// The external check still reflects reality even when the daily alert is
		// already spent.
		expect(injected.ping).toHaveBeenCalledWith('resources', 'fail');
		expect(summaries[0]!.alerts).toEqual([]);
		// The latch is unchanged, so no rewrite.
		expect(injected.writeState).not.toHaveBeenCalled();
	});

	it('records a clear without paging when a latched metric falls under 75%', async () => {
		const { ctx, summaries, logs } = harness();
		const injected = deps({
			readState: vi.fn(async () => ({
				version: 1 as const,
				metrics: { 'disk:/data': { status: 'warn' as const, alertDay: '2026-11-14' } }
			})),
			collect: vi.fn(async () =>
				snapshot({
					disks: [
						{
							key: 'disk:/data',
							mount: '/data',
							label: 'data',
							totalBytes: 1000,
							freeBytes: 400,
							usedPercent: 60
						}
					]
				})
			)
		});
		await runSystemResources(ctx, injected);

		expect(injected.notify).not.toHaveBeenCalled();
		expect(summaries[0]!.clears).toEqual([
			{ key: 'disk:/data', kind: 'disk', usedPercent: 60, mount: '/data' }
		]);
		expect(logs.info.join('\n')).toContain('[clear] disk:/data');
	});

	it('reports collection failures, logs them and pings fail', async () => {
		const { ctx, summaries, logs } = harness();
		const injected = deps({
			collect: vi.fn(async () => snapshot({ disks: [], memory: null, errors: ['disk /data: EIO'] }))
		});
		await runSystemResources(ctx, injected);

		expect(injected.ping).toHaveBeenCalledWith('resources', 'fail');
		expect(logs.error.join('\n')).toContain('disk /data: EIO');
		expect(summaries[0]!.errors).toEqual(['disk /data: EIO']);
	});

	it('still alerts and pings when the latch cannot be written (full disk)', async () => {
		const { ctx, summaries, logs } = harness();
		const injected = deps({
			writeState: vi.fn(async () => {
				throw new Error('ENOSPC: no space left on device');
			}),
			collect: vi.fn(async () =>
				snapshot({
					disks: [
						{
							key: 'disk:/data',
							mount: '/data',
							label: 'data',
							totalBytes: 1000,
							freeBytes: 20,
							usedPercent: 98
						}
					]
				})
			)
		});
		await runSystemResources(ctx, injected);

		expect(injected.notify).toHaveBeenCalledTimes(1);
		expect(injected.ping).toHaveBeenCalledWith('resources', 'fail');
		expect(summaries[0]!.stateFile).toBe('failed');
		expect(logs.error.join('\n')).toContain('state write failed');
	});

	it('fails the external check when only the latch write fails', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({
			writeState: vi.fn(async () => {
				throw new Error('EACCES: permission denied');
			})
		});
		// Healthy readings: only `stateFile === 'failed'` can make this red.
		await runSystemResources(ctx, injected);

		expect(injected.notify).not.toHaveBeenCalled();
		expect(injected.ping).toHaveBeenCalledWith('resources', 'fail');
		expect(summaries[0]!.stateFile).toBe('failed');
	});

	it('drops a stale latch for a metric that is no longer observed', async () => {
		const { ctx, summaries, logs } = harness();
		const injected = deps({
			readState: vi.fn(async () => ({
				version: 1 as const,
				metrics: { 'disk:/old': { status: 'warn' as const, alertDay: '2026-11-01' } }
			}))
		});
		await runSystemResources(ctx, injected);

		// Clean collection + absent metric: the latch self-heals instead of
		// pinning /fail forever.
		expect(injected.ping).toHaveBeenCalledWith('resources', 'ok');
		expect(summaries[0]!.dropped).toEqual(['disk:/old']);
		expect(summaries[0]!.healthcheck).toEqual({ status: 'ok', ping: 'ok' });
		expect(logs.info.join('\n')).toContain('no longer observed');
	});

	it('keeps unobserved latches while collection reports an error', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({
			readState: vi.fn(async () => ({
				version: 1 as const,
				metrics: { 'disk:/old': { status: 'warn' as const, alertDay: '2026-11-01' } }
			})),
			collect: vi.fn(async () => snapshot({ disks: [], memory: null, errors: ['disk /data: EIO'] }))
		});
		await runSystemResources(ctx, injected);

		// A statfs failure must hold the alarm for the metric it hid.
		expect(injected.ping).toHaveBeenCalledWith('resources', 'fail');
		expect(summaries[0]!.dropped).toEqual([]);
		expect(summaries[0]!.latched).toEqual([{ key: 'disk:/old', alertDay: '2026-11-01' }]);
	});

	it('keeps the external check failed for a latched metric inside the band', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({
			readState: vi.fn(async () => ({
				version: 1 as const,
				metrics: {
					'disk:/data': { status: 'warn' as const, alertDay: '2026-11-14' },
					'memory:cgroup': { status: 'ok' as const, alertDay: null }
				}
			})),
			collect: vi.fn(async () =>
				snapshot({
					disks: [
						{
							key: 'disk:/data',
							mount: '/data',
							label: 'data',
							totalBytes: 1000,
							freeBytes: 200,
							usedPercent: 80
						}
					]
				})
			)
		});
		await runSystemResources(ctx, injected);

		// 80% is under the warn line but the latch says the condition is live.
		expect(injected.notify).not.toHaveBeenCalled();
		expect(injected.ping).toHaveBeenCalledWith('resources', 'fail');
		expect(summaries[0]!.alerts).toEqual([]);
		expect(summaries[0]!.latched).toEqual([{ key: 'disk:/data', alertDay: '2026-11-14' }]);
	});

	it('pings ok for an unlatched metric inside the band', async () => {
		const { ctx } = harness();
		const injected = deps({
			collect: vi.fn(async () =>
				snapshot({
					disks: [
						{
							key: 'disk:/data',
							mount: '/data',
							label: 'data',
							totalBytes: 1000,
							freeBytes: 200,
							usedPercent: 80
						}
					]
				})
			)
		});
		await runSystemResources(ctx, injected);
		expect(injected.ping).toHaveBeenCalledWith('resources', 'ok');
	});

	it('records the deduplicated mount list in the summary', async () => {
		const { ctx, summaries } = harness();
		await runSystemResources(
			ctx,
			deps({
				collect: vi.fn(async () =>
					snapshot({ skipped: [{ mount: '/', label: 'root', reason: 'same-device' }] })
				)
			})
		);
		expect(summaries[0]!.skippedMounts).toEqual([
			{ mount: '/', label: 'root', reason: 'same-device' }
		]);
	});

	it('keeps the lane payload free of secrets', async () => {
		const { ctx, summaries } = harness();
		await runSystemResources(
			ctx,
			deps({
				collect: vi.fn(async () => snapshot({ errors: ['disk /data: EIO'] }))
			})
		);
		const serialized = JSON.stringify(summaries[0]);
		expect(serialized).not.toMatch(/https?:\/\//);
		expect(serialized).not.toContain('@');
	});
});
