import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntervalLoop } from './drain-loop';

/**
 * The dev drain is the only thing claiming queued rows when `vite dev` runs, so
 * its loop has two jobs beyond "call the tick": never overlap two ticks, and
 * stop when told. Both are pinned here with fake timers instead of waiting on a
 * real clock.
 */

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('createIntervalLoop', () => {
	it('runs immediately, then one interval after each run settles', async () => {
		const run = vi.fn(async () => {});
		const loop = createIntervalLoop({ run, intervalMs: 1000, log: () => {} });
		loop.start();

		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(run).toHaveBeenCalledTimes(2);
		loop.stop();
	});

	it('never starts a second tick while one is still running', async () => {
		const first = deferred();
		let calls = 0;
		const run = vi.fn(async () => {
			calls += 1;
			if (calls === 1) await first.promise;
		});
		const loop = createIntervalLoop({ run, intervalMs: 1000, log: () => {} });
		loop.start();

		// A slow tick (a translation job can run for minutes) must not be joined
		// by a second one: no timer is armed until it settles.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(run).toHaveBeenCalledTimes(1);

		first.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(2);
		loop.stop();
	});

	it('stop() cancels the pending tick and lets the in-flight one finish', async () => {
		const gate = deferred();
		let calls = 0;
		const run = vi.fn(async () => {
			calls += 1;
			if (calls === 2) await gate.promise;
		});
		const loop = createIntervalLoop({ run, intervalMs: 1000, log: () => {} });
		loop.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(2);

		loop.stop();
		gate.resolve();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(run).toHaveBeenCalledTimes(2);
		expect(loop.active).toBe(false);
	});

	it('keeps draining after a failed tick', async () => {
		const log = vi.fn();
		let calls = 0;
		const run = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error('database unreachable');
		});
		const loop = createIntervalLoop({ run, intervalMs: 1000, log });
		loop.start();

		await vi.advanceTimersByTimeAsync(0);
		expect(log).toHaveBeenCalledWith('[dev-drain] tick failed: database unreachable');
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(2);
		loop.stop();
	});

	it('start() twice does not double the loop', async () => {
		const run = vi.fn(async () => {});
		const loop = createIntervalLoop({ run, intervalMs: 1000, log: () => {} });
		loop.start();
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(1);
		loop.stop();
	});
});
