import { readNotificationPayload, redactNotificationError } from '../format.ts';
import {
	WebhookUrlError,
	assertDeliveryTarget,
	webhookGuardOptionsFromEnv
} from '../../webhooks/url-guard.ts';
import type { AdapterResult } from './types.ts';

/**
 * Bark push adapter: `POST <server>/push` with JSON `device_key`, `title`,
 * `body` and optional `url`, per Bark API V2. `device_key` goes in the BODY,
 * never the path: a key in a URL lands in access logs and screenshots.
 * Safety rails: the server URL passes the same SSRF guard as webhook
 * endpoints (`webhooks/url-guard.ts`) - https only, no credentials, no
 * loopback / link-local / metadata / RFC1918 target unless the operator set
 * `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`. The device key never enters an error
 * string or log line (failures record `HTTP <status>`, a numeric Bark `code`,
 * or a transport class only); the payload is re-shaped from the stored jsonb
 * (`format.ts`): <= 120 title / <= 200 body chars, one line, addresses
 * redacted. `BARK_SERVER_URL` + `BARK_DEVICE_KEY` come from the environment;
 * Node-strip-loadable.
 */
export const BARK_DEFAULT_SERVER = 'https://api.day.app';
export const BARK_GROUP = 'web-lair';

export interface BarkConfig {
	configured: boolean;
	/** Origin only - never the key, never a key-bearing path. */
	serverUrl: string;
	deviceKey: string | null;
	/** Why it is not configured (`missing-key`, `missing-server`, `invalid-server`). */
	reason: 'missing-key' | 'missing-server' | 'invalid-server' | null;
}

/** Resolve the channel configuration without touching the network. */
export function readBarkConfig(
	getEnv: (name: string) => string | undefined = (name) => process.env[name]
): BarkConfig {
	const rawServer = getEnv('BARK_SERVER_URL')?.trim() || BARK_DEFAULT_SERVER;
	let serverUrl = rawServer;
	let reason: BarkConfig['reason'] = null;
	try {
		const parsed = new URL(rawServer);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') reason = 'invalid-server';
		// Origin only: a configured path is ignored so the key cannot ride a
		// path segment into the request log.
		serverUrl = parsed.origin;
	} catch {
		reason = 'invalid-server';
	}
	const deviceKey = getEnv('BARK_DEVICE_KEY')?.trim() || null;
	if (!reason && !deviceKey) reason = 'missing-key';
	return {
		configured: reason === null,
		serverUrl,
		deviceKey,
		reason
	};
}

/** Body builder - pure, so the payload contract has unit teeth. */
export function buildBarkBody(input: {
	deviceKey: string;
	title: string;
	body: string;
	url?: string;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		device_key: input.deviceKey,
		title: input.title,
		body: input.body,
		group: BARK_GROUP,
		level: 'active'
	};
	if (input.url) body.url = input.url;
	return body;
}

/** 2xx + Bark's own `code` (when present) decides the accept signal. */
export function barkResponseSucceeded(status: number, payload: unknown): boolean {
	if (status < 200 || status >= 300) return false;
	if (typeof payload !== 'object' || payload === null) return true;
	const code = (payload as { code?: unknown }).code;
	if (code === undefined || code === null) return true;
	return Number(code) === 200;
}

/** 400/401/403/404 and a blocked target are permanent; 429/5xx retryable. */
export function barkStatusIsPermanent(status: number): boolean {
	return status >= 400 && status < 500 && status !== 429;
}

export interface BarkAdapterDeps {
	getEnv?: (name: string) => string | undefined;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

/** Push one notification. Never throws; every failure is classified. */
export async function sendBarkNotification(
	payload: unknown,
	deps: BarkAdapterDeps = {}
): Promise<AdapterResult> {
	const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
	const config = readBarkConfig(getEnv);
	if (!config.configured || !config.deviceKey) {
		return {
			ok: false,
			permanent: true,
			error: `bark is not configured (${config.reason ?? 'unknown'})`,
			responseCode: null
		};
	}
	const shaped = readNotificationPayload(payload);
	if (!shaped.body) {
		return { ok: false, permanent: true, error: 'payload is empty', responseCode: null };
	}

	const doFetch = deps.fetch ?? fetch;
	const guard = webhookGuardOptionsFromEnv(getEnv);
	// Delivery-time SSRF pre-flight: a stored/configured target that is (or now
	// resolves) private must never receive a push. A blocked target is
	// permanent - retrying cannot change the address.
	try {
		await assertDeliveryTarget(config.serverUrl, guard);
	} catch (error) {
		if (!(error instanceof WebhookUrlError)) throw error;
		return {
			ok: false,
			permanent: true,
			error: `blocked bark target (${error.reason})`,
			responseCode: null
		};
	}

	const endpoint = `${config.serverUrl}/push`;
	try {
		const response = await doFetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(
				buildBarkBody({
					deviceKey: config.deviceKey,
					title: shaped.title || 'web-lair',
					body: shaped.body,
					url: shaped.url
				})
			),
			redirect: 'manual',
			signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000)
		});
		let parsed: unknown = null;
		try {
			parsed = await response.json();
		} catch {
			// A non-JSON body is not itself a failure; the status decides.
			parsed = null;
		}
		if (barkResponseSucceeded(response.status, parsed)) {
			return { ok: true, responseCode: response.status };
		}
		const code =
			typeof parsed === 'object' && parsed !== null && 'code' in parsed
				? Number((parsed as { code?: unknown }).code)
				: null;
		// Bark answers 200 with an error `code` in the body for a bad key or a
		// rejected payload, so an HTTP-shaped body code decides permanence when
		// present; otherwise the status does.
		const failureCode =
			Number.isFinite(code) && (code as number) >= 400 ? (code as number) : response.status;
		return {
			ok: false,
			permanent: barkStatusIsPermanent(failureCode),
			error: Number.isFinite(code) ? `bark code ${code}` : `HTTP ${response.status}`,
			responseCode: response.status
		};
	} catch (error) {
		// Transport errors never include the key: the URL carries no key and the
		// sanitizer drops query strings/credentials.
		return {
			ok: false,
			permanent: false,
			error: redactNotificationError(error),
			responseCode: null
		};
	}
}
