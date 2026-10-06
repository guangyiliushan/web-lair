import type { LinkErrorKind } from '../../utils/link-meta.ts';
import { redactCredentials } from './normalize.ts';

/**
 * Error / status classification for the link checker (plan §4.3, calibrated
 * against the Node v24 fetch probes recorded in the plan §7.2). Pure
 * functions: callers pass real or synthetic errors, tests pass both.
 */
const TLS_CODES = new Set([
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'ERR_TLS_CERT_ALTNAME_INVALID',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'ERR_SSL_WRONG_VERSION_NUMBER',
	'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'
]);

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);

const CONNECT_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EPIPE',
	'ECONNABORTED',
	'UND_ERR_SOCKET'
]);

const TIMEOUT_CODES = new Set([
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'UND_ERR_CONNECT_TIMEOUT'
]);

export interface FailureClass {
	kind: LinkErrorKind;
	countsFailure: boolean;
	retryable: boolean;
	detail?: string;
}

/** Flatten an error graph: the cause chain plus every AggregateError member. */
function flatten(error: unknown, depth = 0, seen = new Set<unknown>()): unknown[] {
	if (depth > 6 || error === null || typeof error !== 'object' || seen.has(error)) return [];
	seen.add(error);
	const out: unknown[] = [error];
	const node = error as { cause?: unknown; errors?: unknown };
	if (Array.isArray(node.errors)) {
		for (const inner of node.errors) out.push(...flatten(inner, depth + 1, seen));
	}
	if (node.cause !== undefined) out.push(...flatten(node.cause, depth + 1, seen));
	return out;
}

function stringsOf(error: unknown, key: 'code' | 'name' | 'message'): string[] {
	return flatten(error)
		.map((node) => (node as Record<string, unknown>)[key])
		.filter((value): value is string => typeof value === 'string');
}

/**
 * Map a fetch-layer failure to the plan §4.3 vocabulary. Precedence mirrors
 * the probe record: timeout > tls > dns > fetch-layer refusal > connect; the
 * AggregateError traversal covers multi-address hosts (v4 + v6).
 */
export function classifyFetchFailure(error: unknown): FailureClass {
	const names = stringsOf(error, 'name');
	const codes = stringsOf(error, 'code');
	if (names.includes('TimeoutError') || codes.some((code) => TIMEOUT_CODES.has(code))) {
		return { kind: 'timeout', countsFailure: true, retryable: true, detail: 'timed out' };
	}
	if (names.includes('AbortError')) {
		// The per-unit deadline can surface as AbortError on body reads.
		return { kind: 'timeout', countsFailure: true, retryable: true, detail: 'aborted by deadline' };
	}
	if (codes.some((code) => TLS_CODES.has(code))) {
		return { kind: 'tls', countsFailure: true, retryable: false };
	}
	if (codes.some((code) => DNS_CODES.has(code))) {
		return { kind: 'dns', countsFailure: true, retryable: false };
	}
	const messages = stringsOf(error, 'message');
	if (messages.some((message) => /bad port/i.test(message)) || codes.includes('ERR_INVALID_URL')) {
		return {
			kind: 'unsupported',
			countsFailure: false,
			retryable: false,
			detail: 'refused by the fetch layer'
		};
	}
	if (codes.some((code) => CONNECT_CODES.has(code))) {
		return { kind: 'connect', countsFailure: true, retryable: false };
	}
	return {
		kind: 'connect',
		countsFailure: true,
		retryable: false,
		detail: redactCredentials(messages[0])
	};
}

/** Map a final HTTP status to the plan §4.3 vocabulary. */
export function classifyHttpStatus(status: number): { ok: boolean; failure: FailureClass | null } {
	if (status >= 200 && status < 300) return { ok: true, failure: null };
	if (status === 404 || status === 410) {
		return {
			ok: false,
			failure: {
				kind: 'http_gone',
				countsFailure: true,
				retryable: false,
				detail: `http ${status}`
			}
		};
	}
	if ([401, 403, 429, 451, 503].includes(status)) {
		return {
			ok: false,
			failure: { kind: 'waf', countsFailure: false, retryable: false, detail: `http ${status}` }
		};
	}
	return {
		ok: false,
		failure: {
			kind: 'http_error',
			countsFailure: true,
			retryable: status >= 500,
			detail: `http ${status}`
		}
	};
}
