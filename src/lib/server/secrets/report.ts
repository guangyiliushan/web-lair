import { recordActivity } from '../audit.ts';

/**
 * Secret-failure audit from the call path (W2.5, decisions A1/A2/A3).
 *
 * The audit row is the durable record the alert timer reads; the value and the
 * ciphertext never enter the payload. Writes are throttled per
 * (event, provider) for one minute: a provider that is down would otherwise
 * insert one row per request, and a table full of identical rows is not more
 * informative than one row per minute.
 *
 * In-process only - multi-replica deployments may write once per replica per
 * minute. That is acceptable for an audit signal; a durable per-minute
 * aggregation belongs to the M6 outbox, not here.
 */
export type SecretFailureEvent =
	| 'ai.key_missing'
	| 'ai.key_decrypt_failed'
	| 'ai.key_denied'
	| 'webhook.key_missing'
	| 'webhook.key_decrypt_failed';

const THROTTLE_MS = 60_000;
const lastWritten = new Map<string, number>();

/** Test seam: clear the in-process throttle. */
export function resetSecretFailureThrottle(): void {
	lastWritten.clear();
}

export interface SecretFailureInput {
	event: SecretFailureEvent;
	providerId?: string | null;
	providerName?: string | null;
	/** Throttle/payload subject when there is no provider id (webhooks). */
	subject?: string | null;
	/** Typed code (`decrypt_failed`, `missing`, ...) - never a value. */
	reason?: string | null;
	actorId?: string | null;
}

export async function reportSecretFailure(
	executor: Parameters<typeof recordActivity>[0],
	input: SecretFailureInput
): Promise<void> {
	const key = `${input.event}:${input.subject ?? input.providerId ?? 'global'}`;
	const now = Date.now();
	const previous = lastWritten.get(key);
	if (previous !== undefined && previous + THROTTLE_MS > now) return;
	lastWritten.set(key, now);
	try {
		await recordActivity(executor, {
			event: input.event,
			actorId: input.actorId ?? null,
			refType: input.providerId ? 'ai' : undefined,
			refId: input.providerId ?? undefined,
			payload: {
				provider: input.providerName ?? null,
				subject: input.subject ?? null,
				reason: input.reason ?? null
			},
			// Decision A2: secret metadata never fans out to webhooks.
			deliver: false
		});
	} catch (error) {
		// A failing audit path must not replace the caller's typed failure.
		console.warn(
			'[secrets] failure event not recorded',
			input.event,
			error instanceof Error ? error.name : 'unknown'
		);
	}
}
