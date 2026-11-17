import { sanitizeErrorText } from '../jobs/error-text.ts';

/**
 * Notification payload shaping (payload <=200 chars, no PII): one shape
 * serves both adapters — `{ title, body, url? }`, built by the producers,
 * stored verbatim by the outbox, re-shaped by the adapters (Bark: title/body;
 * email: subject/text). Bounding and redaction live HERE, once, so a
 * producer cannot widen what leaves the box.
 * Rules: one line (every whitespace run collapses to one space — Bark
 * renders a newline as a line break and a stack trace as a wall of noise);
 * no control characters (they survive `trim()` and break JSON parsing in
 * some Bark servers); email addresses are redacted (a comment excerpt or an
 * SMTP error routinely contains one, and the payload is stored in a table
 * plus pushed to a phone); hard caps title <= 120 / body <= 200 with an
 * ellipsis on truncation (the cap is the promise, not an aspiration); `url`
 * must be absolute http(s) and loses credentials, the query string and the
 * fragment (a link is for navigation, not a token carrier).
 * Node-strip-loadable: relative `.ts` imports only.
 */
export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_BODY_MAX = 200;
export const NOTIFICATION_URL_MAX = 500;

const EMAIL_PATTERN = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// eslint-disable-next-line no-control-regex -- deliberate: strip control characters
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

export interface NotificationPayload {
	title: string;
	body: string;
	url?: string;
}

/** Collapse to one printable line and redact address-like tokens. */
export function sanitizeNotificationText(value: string, max: number): string {
	const collapsed = `${value ?? ''}`.replace(CONTROL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
	const redacted = collapsed.replace(EMAIL_PATTERN, '[address]');
	// Slice by CODE POINT: a UTF-16 slice can split a surrogate pair and leave
	// a lone surrogate, which `JSON.stringify` escapes as `\ud83d` and jsonb
	// rejects - the insert would fail and the alert would be lost.
	// `Array.from` keeps astral characters (emoji, rare CJK) intact.
	const points = Array.from(redacted);
	if (points.length <= max) return redacted;
	// Reserve one character for the ellipsis so the cap is exact.
	return `${points
		.slice(0, Math.max(0, max - 1))
		.join('')
		.trimEnd()}…`;
}

/** Absolute http(s) link, credentials/query/fragment stripped; null otherwise. */
export function sanitizeNotificationUrl(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
	if (parsed.username || parsed.password) return undefined;
	parsed.search = '';
	parsed.hash = '';
	if (parsed.href.length > NOTIFICATION_URL_MAX) return undefined;
	return parsed.href;
}

/**
 * Build the stored payload. The type is widened to a plain record because the
 * column is `jsonb`; every field is optional on input and required on output.
 */
export function buildNotificationPayload(input: {
	title: string;
	body: string;
	url?: string | null;
}): Record<string, unknown> {
	const payload: NotificationPayload = {
		title: sanitizeNotificationText(input.title, NOTIFICATION_TITLE_MAX),
		body: sanitizeNotificationText(input.body, NOTIFICATION_BODY_MAX)
	};
	const url = sanitizeNotificationUrl(input.url);
	if (url) payload.url = url;
	return { ...payload };
}

/** Read a payload back for the adapters; a hand-written row cannot widen caps. */
export function readNotificationPayload(value: unknown): NotificationPayload {
	const record = (value ?? {}) as Record<string, unknown>;
	const title = sanitizeNotificationText(String(record.title ?? ''), NOTIFICATION_TITLE_MAX);
	const body = sanitizeNotificationText(String(record.body ?? ''), NOTIFICATION_BODY_MAX);
	const url = sanitizeNotificationUrl(typeof record.url === 'string' ? record.url : null);
	return url ? { title, body, url } : { title, body };
}

/**
 * Failure text for the delivery log: shared URL/DSN sanitizer, address
 * redaction, one line, 200 characters. The log page and the drain log both
 * print this string, so it is the last place a relay banner could leak.
 */
export function redactNotificationError(error: unknown): string {
	const raw = error instanceof Error ? error.message || error.name : String(error ?? '');
	return sanitizeNotificationText(sanitizeErrorText(raw), NOTIFICATION_BODY_MAX);
}
