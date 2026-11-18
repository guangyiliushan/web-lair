// `system.resources` job core: the builtin stays a two-line shell
// (`#jobs-sdk` runner) and the logic lives here so it can be unit-tested
// with injected readings and sinks. Three outputs, each with its own
// reliability envelope: `ctx.summary` records every mount, the cgroup memory
// reading and the host memory reference for the run ledger; `notify()` raises
// a threshold alert, deduped per metric per UTC day by the latched state
// file; the healthchecks ping reports fail while any metric is latched in
// warn (including the 75-85 band), a collection failed, or the daily latch
// could not be persisted, and ok otherwise. The ping is the external
// backstop: when the disk is full the DB/outbox may be unwritable, but it is
// one GET, sent BEFORE the in-app notify loop for exactly that reason.
import os from 'node:os';
import { resolveDataDir } from '../jobs/data-dir.ts';
import { sanitizeErrorText } from '../jobs/error-text.ts';
import type { JobContext } from '../jobs/types.ts';
import { notify as defaultNotify, type NotificationOutcome } from '../notifications/notify.ts';
import { pingHealthcheck as defaultPing } from './healthchecks.ts';
import {
	RESOURCE_CLEAR_PERCENT,
	RESOURCE_WARN_PERCENT,
	collectResourceSnapshot,
	defaultMounts,
	evaluateReadings,
	readResourceState,
	readingsOf,
	resourceStatePath,
	sameResourceState,
	writeResourceState,
	type ResourceSnapshot
} from './resources.ts';

export interface SystemResourcesDeps {
	dataDir?: string;
	collect?: typeof collectResourceSnapshot;
	readState?: typeof readResourceState;
	writeState?: typeof writeResourceState;
	notify?: typeof defaultNotify;
	ping?: typeof defaultPing;
	now?: () => Date;
	/** Test seam for the host readings; defaults to `node:os`. */
	host?: {
		totalmem: () => number;
		freemem: () => number;
		loadavg: () => number[];
		uptime: () => number;
	};
}

/** One decimal, matching the disk readings. */
function pct(value: number): number {
	return Math.round(value * 10) / 10;
}

function eventTypeOf(kind: 'disk' | 'memory'): string {
	return kind === 'memory' ? 'system.memory_high' : 'system.disk_high';
}

function alertTitle(kind: 'disk' | 'memory', mount: string | undefined, percent: number): string {
	const where = kind === 'memory' ? 'cgroup memory' : `disk ${mount ?? '?'}`;
	return `${where} at ${percent}% (warn ${RESOURCE_WARN_PERCENT}%, clear ${RESOURCE_CLEAR_PERCENT}%)`;
}

export async function runSystemResources(
	ctx: JobContext,
	deps: SystemResourcesDeps = {}
): Promise<void> {
	const dataDir = deps.dataDir ?? resolveDataDir();
	const collect = deps.collect ?? collectResourceSnapshot;
	const readState = deps.readState ?? readResourceState;
	const writeState = deps.writeState ?? writeResourceState;
	const notify = deps.notify ?? defaultNotify;
	const ping = deps.ping ?? defaultPing;
	const now = (deps.now ?? (() => new Date()))();
	const host = deps.host ?? {
		totalmem: () => os.totalmem(),
		freemem: () => os.freemem(),
		loadavg: () => os.loadavg(),
		uptime: () => os.uptime()
	};

	const snapshot: ResourceSnapshot = await collect({ mounts: defaultMounts(dataDir) });
	const statePath = resourceStatePath(dataDir);
	const state = await readState(statePath);
	const day = now.toISOString().slice(0, 10);
	const { alerts, clears, dropped, nextState } = evaluateReadings(
		readingsOf(snapshot),
		state,
		day,
		// A collection error must hold the alarm for the metric it hid; a clean
		// run drops latches for metrics that are no longer observed (self-heal).
		{ keepUnobserved: snapshot.errors.length > 0 }
	);
	// The state file lives on the volume the probe is watching: a full disk makes
	// this write fail. Ordering matters - the alert outlets below must run
	// regardless, otherwise the one condition that needs to page is the one that
	// throws before paging.
	let stateFile: 'ok' | 'failed' = 'ok';
	if (!sameResourceState(state, nextState)) {
		try {
			await writeState(statePath, nextState);
		} catch (error) {
			stateFile = 'failed';
			const text = sanitizeErrorText(error instanceof Error ? error.message : String(error));
			ctx.logger.error(`[resources] state write failed: ${text}`);
		}
	}

	// The latch, not just this reading: a metric held in the 75-85 band is still
	// an active warning, and clearing the external check while the state says
	// "warn" would hand the operator a green signal for a latched condition.
	const latched = Object.entries(nextState.metrics)
		.filter(([, metric]) => metric.status === 'warn')
		.map(([key, metric]) => ({ key, alertDay: metric.alertDay }));
	const failing = latched.length > 0 || snapshot.errors.length > 0 || stateFile === 'failed';
	const healthcheckStatus = failing ? 'fail' : 'ok';
	// External record FIRST: a hung outbox sink must not sit between the
	// condition and its out-of-box backstop (the drain hard-exits on timeout).
	const healthcheckPing = await ping('resources', healthcheckStatus);
	for (const entry of latched) {
		ctx.logger.warn(`[latched] ${entry.key} (alert ${entry.alertDay ?? 'n/a'})`);
	}
	for (const key of dropped) {
		ctx.logger.info(`[clear] ${key} no longer observed; latch dropped`);
	}

	const notified: Array<{ key: string; eventType: string; delivered: NotificationOutcome }> = [];
	for (const alert of alerts) {
		const eventType = eventTypeOf(alert.kind);
		const title = alertTitle(alert.kind, alert.mount, alert.usedPercent);
		const delivered = await notify({
			eventType,
			// Day-scoped: the (event_type,event_key,channel) unique key must not
			// silence tomorrow's alert for the same mount.
			eventKey: `${alert.key}:${day}`,
			title,
			body: `${title}. Mount: ${alert.mount ?? 'cgroup'}.`
		});
		notified.push({ key: alert.key, eventType, delivered });
		ctx.logger.warn(`[alert] ${title}`);
	}

	// A failed delivery must not keep the day's latch: the dedupe key is
	// day-scoped, so a latched failure would silence the alert until tomorrow.
	// Clearing `alertDay` makes the next tick retry; the unique key absorbs a
	// duplicate if both the retry and a late delivery land.
	const failedAlertKeys = notified
		.filter((entry) => entry.delivered === 'failed')
		.map((entry) => entry.key);
	if (failedAlertKeys.length > 0) {
		for (const key of failedAlertKeys) {
			const metric = nextState.metrics[key];
			if (metric) metric.alertDay = null;
		}
		try {
			await writeState(statePath, nextState);
			ctx.logger.warn(
				`[notify] delivery failed for ${failedAlertKeys.join(', ')}; latch cleared for a retry next tick`
			);
		} catch (error) {
			const text = sanitizeErrorText(error instanceof Error ? error.message : String(error));
			ctx.logger.error(`[notify] could not persist the retry latch: ${text}`);
		}
	}
	for (const clear of clears) {
		ctx.logger.info(
			`[clear] ${clear.key} back to ${clear.usedPercent}% (release ${RESOURCE_CLEAR_PERCENT}%)`
		);
	}
	for (const error of snapshot.errors) ctx.logger.error(`[resources] ${error}`);

	const [load1, load5, load15] = host.loadavg();
	const totalMemory = host.totalmem();
	const freeMemory = host.freemem();
	ctx.summary({
		thresholds: { warnPercent: RESOURCE_WARN_PERCENT, clearPercent: RESOURCE_CLEAR_PERCENT },
		mounts: snapshot.disks.map((disk) => ({
			key: disk.key,
			mount: disk.mount,
			label: disk.label,
			totalBytes: disk.totalBytes,
			freeBytes: disk.freeBytes,
			usedPercent: disk.usedPercent
		})),
		memory: snapshot.memory
			? {
					source: snapshot.memory.source,
					currentBytes: snapshot.memory.currentBytes,
					maxBytes: snapshot.memory.maxBytes,
					usedPercent: snapshot.memory.usedPercent
				}
			: null,
		/** Mounts measured once (same path or same filesystem). */
		skippedMounts: snapshot.skipped,
		/** `failed` means the daily latch could not be persisted this run. */
		stateFile,
		// Reference only: the HOST's memory, which is not what the container is
		// limited by; the alerting metric is the cgroup reading.
		hostMemory: {
			totalBytes: totalMemory,
			freeBytes: freeMemory,
			usedPercent: totalMemory > 0 ? pct((1 - freeMemory / totalMemory) * 100) : null
		},
		alerts: alerts.map((alert) => ({
			key: alert.key,
			kind: alert.kind,
			usedPercent: alert.usedPercent,
			thresholdPercent: alert.thresholdPercent,
			mount: alert.mount ?? null
		})),
		clears: clears.map((clear) => ({
			key: clear.key,
			kind: clear.kind,
			usedPercent: clear.usedPercent,
			mount: clear.mount ?? null
		})),
		notified,
		// Why the external check is red (or not): the latch set drives
		// `healthcheck.status`, and `dropped` names self-healed stale latches.
		latched,
		dropped,
		// `status` is what the probe decided; `ping` is whether healthchecks
		// accepted the report - a /fail ping that returns 2xx is a delivered
		// failure, not a healthy disk.
		healthcheck: { status: healthcheckStatus, ping: healthcheckPing },
		errors: snapshot.errors,
		loadavg: {
			'1m': Math.round(load1 * 100) / 100,
			'5m': Math.round(load5 * 100) / 100,
			'15m': Math.round(load15 * 100) / 100
		},
		uptimeSeconds: Math.round(host.uptime()),
		process: {
			pid: process.pid,
			node: process.version,
			rssBytes: process.memoryUsage().rss
		}
	});
}
