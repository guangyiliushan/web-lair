/**
 * Host resource probe: multi-mount disk usage + cgroup v2 memory,
 * threshold evaluation with hysteresis, and the small state file that makes
 * "one alert per metric per day" survive the 15-minute schedule.
 *
 * Why both mounts and both memory readings are sampled:
 *  - `process.cwd()` in the container is `/app` (the overlay root), while the
 *    data that actually fills the disk lives on `$DATA_DIR` (`/data` in the
 *    production compose). Both mounts are measured now - the root filesystem
 *    still matters (logs, images) and `/data` is the one that fills silently.
 *  - `os.freemem()` reports the HOST's memory; the cgroup's `memory.current`
 *    vs `memory.max` is what the container is actually limited by. The host
 *    reading stays in the summary as a reference only.
 *
 * Thresholds: warn at >= 85%, clear at <= 75% (hysteresis - a metric that
 * hovers on one line must not flap). Between the two the previous state is
 * held. Alerts are deduped per metric per UTC day; the state file is the only
 * durable bit (no schema change, no new table).
 *
 * Node-loadable on purpose: the drain runs jobs under plain type stripping,
 * so this module imports only `node:*`.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Alert at this usage or above. */
export const RESOURCE_WARN_PERCENT = 85;
/** Clear a previous alert at this usage or below (hysteresis band 75-85%). */
export const RESOURCE_CLEAR_PERCENT = 75;

/** File inside `$DATA_DIR` holding the latched state (atomic replace). */
const RESOURCE_STATE_FILE = 'system-resources-state.json';

/** Structural view of `statfs` so tests can inject readings. */
export type StatfsLike = (path: string) => Promise<{
	blocks: number;
	bsize: number;
	bavail: number;
}>;

export type ReadFileLike = (path: string, encoding: 'utf8') => Promise<string>;

/** Structural view of `stat` for the same-device check. */
export type StatLike = (path: string) => Promise<{ dev: number | bigint }>;

export interface MountSpec {
	/** Absolute path to measure. */
	mount: string;
	/** Short label for events/summary (`data`, `root`). */
	label: string;
}

export interface DiskReading {
	/** Stable metric key: `disk:<mount>`. */
	key: string;
	mount: string;
	label: string;
	totalBytes: number;
	freeBytes: number;
	/** Percent used (0-100, one decimal) or null when the size is unknown. */
	usedPercent: number | null;
}

export interface MemoryReading {
	key: 'memory:cgroup';
	source: 'cgroup-v2';
	currentBytes: number;
	/** null when the cgroup is unlimited (`memory.max` = `max`). */
	maxBytes: number | null;
	usedPercent: number | null;
}

export interface SkippedMount {
	mount: string;
	label: string;
	/** `same-device`: same filesystem as an earlier mount; `duplicate`: same path. */
	reason: 'same-device' | 'duplicate';
}

export interface ResourceSnapshot {
	disks: DiskReading[];
	memory: MemoryReading | null;
	/** Mounts deliberately not measured twice (same path or same device). */
	skipped: SkippedMount[];
	/** Collection failures, `path: code` shaped - never a stack trace. */
	errors: string[];
}

export interface CollectResourcesInput {
	mounts: MountSpec[];
	statfsImpl?: StatfsLike;
	statImpl?: StatLike;
	readFileImpl?: ReadFileLike;
	/** cgroup v2 mount point (tests inject a fixture directory). */
	cgroupRoot?: string;
}

/**
 * Percent used, one decimal. `freeBytes` is `bavail` (what an unprivileged
 * writer can still use), matching `df`'s `Use%` closely enough for a
 * threshold probe.
 */
export function usedPercentOf(totalBytes: number, freeBytes: number): number | null {
	if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) return null;
	return Math.round((1 - freeBytes / totalBytes) * 1000) / 10;
}

function errorCode(error: unknown): string {
	return error instanceof Error ? error.message.split('\n')[0]!.slice(0, 160) : String(error);
}

/** One statfs reading; a failure is recorded, never thrown. */
export async function readMountUsage(
	spec: MountSpec,
	statfsImpl: StatfsLike = statfs as unknown as StatfsLike
): Promise<{ reading: DiskReading | null; error: string | null }> {
	try {
		const stats = await statfsImpl(spec.mount);
		const totalBytes = stats.blocks * stats.bsize;
		const freeBytes = stats.bavail * stats.bsize;
		return {
			reading: {
				key: `disk:${spec.mount}`,
				mount: spec.mount,
				label: spec.label,
				totalBytes,
				freeBytes,
				usedPercent: usedPercentOf(totalBytes, freeBytes)
			},
			error: null
		};
	} catch (error) {
		return {
			reading: null,
			error: `disk ${spec.mount}: ${errorCode(error)}`
		};
	}
}

/**
 * cgroup v2 memory: `memory.current` vs `memory.max`. Missing files (v1
 * hosts, macOS/Windows dev, or a container without a memory limit file) yield
 * null - the probe reports "not observable" instead of inventing a number.
 * `memory.max` = `max` means unlimited: usage is reported, percent is null.
 */
export async function readCgroupMemory(
	readFileImpl: ReadFileLike = readFile as unknown as ReadFileLike,
	cgroupRoot = '/sys/fs/cgroup'
): Promise<{ reading: MemoryReading | null; error: string | null }> {
	const currentPath = join(cgroupRoot, 'memory.current');
	const maxPath = join(cgroupRoot, 'memory.max');
	try {
		const rawCurrent = (await readFileImpl(currentPath, 'utf8')).trim();
		// `Number('') === 0`: a truncated/empty read must not report 0% memory.
		if (!/^\d+$/.test(rawCurrent)) {
			return { reading: null, error: 'memory current: unparsable value' };
		}
		const currentBytes = Number(rawCurrent);
		if (!Number.isSafeInteger(currentBytes)) {
			return { reading: null, error: 'memory current: unparsable value' };
		}
		const rawMax = (await readFileImpl(maxPath, 'utf8')).trim();
		const unlimited = rawMax === 'max';
		if (!unlimited && !/^\d+$/.test(rawMax)) {
			return { reading: null, error: 'memory max: unparsable value' };
		}
		const maxBytes = unlimited ? null : Number(rawMax);
		if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
			return { reading: null, error: 'memory max: unparsable value' };
		}
		return {
			reading: {
				key: 'memory:cgroup',
				source: 'cgroup-v2',
				currentBytes,
				maxBytes,
				usedPercent: maxBytes === null ? null : Math.round((currentBytes / maxBytes) * 1000) / 10
			},
			error: null
		};
	} catch (error) {
		// ENOENT is the normal case outside Linux/cgroup v2; report it as an
		// unobservable metric rather than a collection failure.
		const code =
			typeof error === 'object' && error !== null && 'code' in error
				? String((error as { code: unknown }).code)
				: errorCode(error);
		if (code === 'ENOENT') return { reading: null, error: null };
		return { reading: null, error: `memory: ${code}` };
	}
}

/** Collect every reading; never throws. */
export async function collectResourceSnapshot(
	input: CollectResourcesInput
): Promise<ResourceSnapshot> {
	const errors: string[] = [];
	const disks: DiskReading[] = [];
	const skipped: SkippedMount[] = [];
	const statImpl = input.statImpl ?? (stat as unknown as StatLike);
	const seenPaths = new Set<string>();
	const seenDevices = new Set<string>();
	for (const spec of input.mounts) {
		if (seenPaths.has(spec.mount)) {
			skipped.push({ mount: spec.mount, label: spec.label, reason: 'duplicate' });
			continue;
		}
		seenPaths.add(spec.mount);
		// `/data` and `/` are two paths on one filesystem when the data dir is
		// not a separate volume (always true on a dev box, and on a default
		// install without the bind mount). Measuring both would latch the same
		// condition twice and page twice; the device id decides.
		let device: string | null = null;
		try {
			device = String((await statImpl(spec.mount)).dev);
		} catch {
			// Missing path: statfs below records the failure with a code.
		}
		if (device !== null && seenDevices.has(device)) {
			skipped.push({ mount: spec.mount, label: spec.label, reason: 'same-device' });
			continue;
		}
		if (device !== null) seenDevices.add(device);
		const { reading, error } = await readMountUsage(spec, input.statfsImpl);
		if (reading) disks.push(reading);
		if (error) errors.push(error);
	}
	const memory = await readCgroupMemory(input.readFileImpl, input.cgroupRoot);
	if (memory.error) errors.push(memory.error);
	return { disks, memory: memory.reading, skipped, errors };
}

/**
 * The two mounts this probe cares about. `collectResourceSnapshot` drops the second
 * one when both paths live on the same filesystem (device id), so a single
 * volume cannot produce two alerts for one condition.
 */
export function defaultMounts(dataDir: string): MountSpec[] {
	const mounts: MountSpec[] = [{ mount: dataDir, label: 'data' }];
	if (dataDir !== '/') mounts.push({ mount: '/', label: 'root' });
	return mounts;
}

// ---------------------------------------------------------------------------
// Threshold state (latched, daily-deduped)
// ---------------------------------------------------------------------------

export type MetricStatus = 'ok' | 'warn';

export interface MetricState {
	status: MetricStatus;
	/**
	 * UTC day (`YYYY-MM-DD`) of the last alert. Survives a clear on purpose:
	 * the "one alert per metric per day" cap must not be reset by a dip that
	 * bounces straight back over the line.
	 */
	alertDay: string | null;
}

export interface ResourceState {
	version: 1;
	metrics: Record<string, MetricState>;
}

export function emptyResourceState(): ResourceState {
	return { version: 1, metrics: {} };
}

export function resourceStatePath(dataDir: string): string {
	return join(dataDir, RESOURCE_STATE_FILE);
}

/** Tolerant read: a missing or corrupt file resets the latch (never throws). */
export async function readResourceState(
	path: string,
	readFileImpl: ReadFileLike = readFile as unknown as ReadFileLike
): Promise<ResourceState> {
	try {
		const parsed: unknown = JSON.parse(await readFileImpl(path, 'utf8'));
		if (!parsed || typeof parsed !== 'object') return emptyResourceState();
		const candidate = parsed as { version?: unknown; metrics?: unknown };
		if (candidate.version !== 1 || !candidate.metrics || typeof candidate.metrics !== 'object') {
			return emptyResourceState();
		}
		const metrics: Record<string, MetricState> = {};
		for (const [key, value] of Object.entries(candidate.metrics as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') continue;
			const entry = value as { status?: unknown; alertDay?: unknown };
			if (entry.status !== 'ok' && entry.status !== 'warn') continue;
			metrics[key] = {
				status: entry.status,
				alertDay: typeof entry.alertDay === 'string' ? entry.alertDay : null
			};
		}
		return { version: 1, metrics };
	} catch {
		return emptyResourceState();
	}
}

/** Atomic replace (unique tmp + rename), 0600 - same shape as the other sidecars. */
export async function writeResourceState(path: string, state: ResourceState): Promise<void> {
	// Unique per writer: a manual CLI run and the drain tick can overlap even
	// though the job itself is single-flight; a fixed `.tmp` name would let one
	// rename the other's half-written file. rename(2) stays atomic either way.
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let renamed = false;
	try {
		await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
		await rename(temp, path);
		renamed = true;
	} finally {
		// Failure must not accumulate 0600 orphans on the volume being watched.
		if (!renamed) await unlink(temp).catch(() => {});
	}
}

/** True when the two states carry the same latches (no write needed). */
export function sameResourceState(left: ResourceState, right: ResourceState): boolean {
	const keys = new Set([...Object.keys(left.metrics), ...Object.keys(right.metrics)]);
	for (const key of keys) {
		const a = left.metrics[key];
		const b = right.metrics[key];
		if (!a || !b) return false;
		if (a.status !== b.status || a.alertDay !== b.alertDay) return false;
	}
	return true;
}

export type ResourceMetricKind = 'disk' | 'memory';

export interface MetricReading {
	key: string;
	kind: ResourceMetricKind;
	usedPercent: number | null;
	mount?: string;
}

export interface ThresholdEvent {
	key: string;
	kind: ResourceMetricKind;
	/** `warn` = threshold crossed, `clear` = back under the release line. */
	status: 'warn' | 'clear';
	usedPercent: number;
	thresholdPercent: number;
	mount?: string;
}

export interface EvaluationResult {
	/** Alerts to raise now (already deduped against the state + day). */
	alerts: ThresholdEvent[];
	/** Warn -> ok transitions observed in this run (recorded, not paged). */
	clears: ThresholdEvent[];
	/** Latches dropped because the metric is no longer observed (self-heal). */
	dropped: string[];
	nextState: ResourceState;
}

export interface EvaluateOptions {
	/**
	 * Keep latches for metrics that produced no reading this run. The job sets
	 * this when collection reported an error for the run (a statfs failure must
	 * hold the alarm); with clean collection an absent metric is dropped so a
	 * removed mount or a raised cgroup limit cannot pin /fail forever.
	 */
	keepUnobserved?: boolean;
}

/**
 * One pass of the hysteresis state machine.
 *
 *  - `>= 85%`: alert when the metric was not in warn, or when it was but the
 *    last alert was on an earlier day (one alert per metric per day).
 *  - `<= 75%`: clear a latched warn (a clear is recorded in the run summary
 *    and the log; it does not page - the external check goes green instead).
 *  - between the two: hold the previous state (this is the hysteresis).
 */
export function evaluateReadings(
	readings: MetricReading[],
	state: ResourceState,
	day: string,
	options: EvaluateOptions = {}
): EvaluationResult {
	const metrics: Record<string, MetricState> = {};
	const alerts: ThresholdEvent[] = [];
	const clears: ThresholdEvent[] = [];
	const dropped: string[] = [];
	for (const reading of readings) {
		if (reading.usedPercent === null) continue;
		const previous = state.metrics[reading.key];
		const base: MetricState = previous ?? { status: 'ok', alertDay: null };
		if (reading.usedPercent >= RESOURCE_WARN_PERCENT) {
			// The daily cap keys off alertDay alone: a metric that dipped under
			// the clear line and bounced back the same day must not page twice.
			const alreadyAlertedToday = base.alertDay === day;
			if (!alreadyAlertedToday) {
				alerts.push({
					key: reading.key,
					kind: reading.kind,
					status: 'warn',
					usedPercent: reading.usedPercent,
					thresholdPercent: RESOURCE_WARN_PERCENT,
					mount: reading.mount
				});
			}
			metrics[reading.key] = { status: 'warn', alertDay: day };
			continue;
		}
		if (reading.usedPercent <= RESOURCE_CLEAR_PERCENT) {
			if (base.status === 'warn') {
				clears.push({
					key: reading.key,
					kind: reading.kind,
					status: 'clear',
					usedPercent: reading.usedPercent,
					thresholdPercent: RESOURCE_CLEAR_PERCENT,
					mount: reading.mount
				});
			}
			// Keep alertDay: the cap survives the clear (see MetricState).
			metrics[reading.key] = { status: 'ok', alertDay: base.alertDay };
			continue;
		}
		// Hysteresis band: keep the latch exactly as it was.
		metrics[reading.key] = base;
	}
	if (options.keepUnobserved) {
		// Carry the latch forward for metrics this run could not observe (a
		// statfs failure must not silently clear the alarm).
		for (const [key, entry] of Object.entries(state.metrics)) {
			if (!(key in metrics)) metrics[key] = entry;
		}
	} else {
		for (const key of Object.keys(state.metrics)) {
			if (!(key in metrics)) dropped.push(key);
		}
	}
	return { alerts, clears, dropped, nextState: { version: 1, metrics } };
}

/** Turn a snapshot into the metric readings the evaluator consumes. */
export function readingsOf(snapshot: ResourceSnapshot): MetricReading[] {
	const readings: MetricReading[] = snapshot.disks.map((disk) => ({
		key: disk.key,
		kind: 'disk' as const,
		usedPercent: disk.usedPercent,
		mount: disk.mount
	}));
	if (snapshot.memory) {
		readings.push({
			key: snapshot.memory.key,
			kind: 'memory',
			usedPercent: snapshot.memory.usedPercent
		});
	}
	return readings;
}
