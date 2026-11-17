/**
 * healthchecks.io pings: the external backstop for the two probes.
 *
 * The box can die with its own alert path (disk full blocks the outbox/DB;
 * a dead SMTP host is exactly what the mail probe reports), so each probe
 * pings an out-of-box check as a second, independent record:
 *
 *   GET <check-url>          -> check healthy (clears a previous failure)
 *   GET <check-url>/fail     -> check failed (healthchecks alerts)
 *
 * One check per probe, not one shared check: a failing disk must not mask a
 * dead mailer (single source per alarm). Env holds the *ping URL* of each
 * check (`https://hc-ping.com/<uuid>`); the UUID is a bearer-ish capability,
 * so it never reaches a log line - only the probe name and the outcome do.
 *
 * Pings are best-effort: a missing URL (dev, or a probe without one) is
 * `skipped`, and any transport failure is logged and swallowed. The probe's
 * own run ledger stays the primary record.
 */

export type HealthcheckProbe = 'resources' | 'mail';
export type HealthcheckStatus = 'ok' | 'fail';

/** Env var holding each check's base ping URL (no `/fail` suffix). */
export const HEALTHCHECK_ENV: Record<HealthcheckProbe, string> = {
	resources: 'HEALTHCHECKS_RESOURCES_URL',
	mail: 'HEALTHCHECKS_MAIL_URL'
};

export const HEALTHCHECK_TIMEOUT_MS = 10_000;

export type HealthcheckPingResult = 'skipped' | 'ok' | 'fail';

/** Appends `/fail` for a failure ping; null when the check is not configured. */
export function healthcheckUrl(
	probe: HealthcheckProbe,
	status: HealthcheckStatus,
	env: Record<string, string | undefined> = process.env
): string | null {
	const base = env[HEALTHCHECK_ENV[probe]]?.trim();
	if (!base) return null;
	const trimmed = base.replace(/\/+$/, '');
	return status === 'fail' ? `${trimmed}/fail` : trimmed;
}

export interface PingHealthcheckOptions {
	env?: Record<string, string | undefined>;
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * Warn once per probe when production runs without a healthchecks URL: the
 * out-of-box channel is then absent, and a silent `skipped` would leave the
 * operator believing the external backstop exists.
 */
const warnedMissingUrl = new Set<string>();

/**
 * Send one status ping. Never throws; returns what actually happened so the
 * job can put it in `ctx.summary`.
 */
export async function pingHealthcheck(
	probe: HealthcheckProbe,
	status: HealthcheckStatus,
	options: PingHealthcheckOptions = {}
): Promise<HealthcheckPingResult> {
	const env = options.env ?? process.env;
	const url = healthcheckUrl(probe, status, env);
	if (!url) {
		if (env.NODE_ENV === 'production' && !warnedMissingUrl.has(probe)) {
			warnedMissingUrl.add(probe);
			console.warn(
				`[healthchecks] ${probe} has no URL configured in production; the external alert channel is off`
			);
		}
		return 'skipped';
	}
	const doFetch = options.fetchImpl ?? fetch;
	try {
		const response = await doFetch(url, {
			method: 'GET',
			signal: AbortSignal.timeout(options.timeoutMs ?? HEALTHCHECK_TIMEOUT_MS)
		});
		if (!response.ok) {
			console.warn(`[healthchecks] ${probe} ${status} ping answered ${response.status}`);
			return 'fail';
		}
		return 'ok';
	} catch (error) {
		// The URL carries the check UUID: log the probe and the failure class only.
		const text = error instanceof Error ? error.name : 'unknown error';
		console.warn(`[healthchecks] ${probe} ${status} ping failed (${text})`);
		return 'fail';
	}
}
