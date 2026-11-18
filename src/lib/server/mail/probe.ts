// Mail probe primitives: the SMTP handshake check and the
// weekly real delivery, both runnable under plain Node (the drain's
// `node jobs/drain.ts` process cannot load `$env/dynamic/private`).
//
// Same derivation as the web transport (`smtp.ts`) - a probe that passes must
// mean the app's own send path would pass too. The 60s verify cache matches
// the sign-up gate's window: within one tick and one sign-up burst the server
// is asked once, not once per caller.
//
// Failure text is sanitized: nodemailer errors can embed the endpoint URL
// (which may carry credentials in a DSN-shaped host), and this string reaches
// the run ledger.
import type { Transporter } from 'nodemailer';
import { sanitizeErrorText } from '../jobs/error-text.ts';
import {
	MailNotConfiguredError,
	createSmtpTransport,
	devLogAllowedFrom,
	isMailConfiguredFrom,
	redactMailError,
	type MailEnvReader
} from './smtp.ts';

/** Sign-up gate and probe share this window (was 60s in the transport). */
export const MAIL_VERIFY_TTL_MS = 60_000;

export interface MailVerifyResult {
	/** False only when a configured transport refused the handshake. */
	ok: boolean;
	/** True when the answer came from the 60s cache. */
	cached: boolean;
	/** Sanitized failure text; never contains credentials. */
	reason?: string;
	/** Set when no transport was contacted (not configured / dev-log). */
	skipped?: 'not-configured' | 'dev-log';
}

let verifyCache: { at: number; ok: boolean; reason?: string } | null = null;

/** Drop the memoised verify result (env changes, tests). */
export function resetMailProbeCache(): void {
	verifyCache = null;
}

export interface VerifyMailboxOptions {
	/** Injectable clock (tests); defaults to Date.now. */
	now?: number;
	/** Reuse the caller's memoised transporter (the web path does). */
	transport?: Transporter;
}

/**
 * `transporter().verify()` with a 60-second cache. Unconfigured mail is not
 * cached: the answer depends on env, and a cached "dev-log allowed" would
 * survive a config change inside the same process.
 */
export async function verifyMailbox(
	getEnv: MailEnvReader,
	options: VerifyMailboxOptions = {}
): Promise<MailVerifyResult> {
	if (!isMailConfiguredFrom(getEnv)) {
		return { ok: devLogAllowedFrom(getEnv, false), cached: false, skipped: 'not-configured' };
	}
	const now = options.now ?? Date.now();
	if (verifyCache && now - verifyCache.at < MAIL_VERIFY_TTL_MS) {
		return { ok: verifyCache.ok, cached: true, reason: verifyCache.reason };
	}
	const transport = options.transport ?? null;
	try {
		// Construction can throw synchronously (bad env); keeping it inside the
		// try preserves the "returns false, never throws" contract its callers
		// (register/forgot-password gates) rely on.
		await (transport ?? createSmtpTransport(getEnv)).verify();
		verifyCache = { at: now, ok: true };
		return { ok: true, cached: false };
	} catch (error) {
		// The relay reply may echo the SMTP user or the recipient: redact
		// addresses first, then strip URLs/params before the reason is stored.
		const reason = sanitizeErrorText(redactMailError(error));
		verifyCache = { at: now, ok: false, reason };
		console.warn(`[mail] SMTP verification failed: ${reason}`);
		return { ok: false, cached: false, reason };
	}
}

export interface ProbeMail {
	to: string;
	subject: string;
	text: string;
}

/**
 * Send one real probe mail through the shared transport and report the
 * `messageId` nodemailer assigned (the run ledger records it so a missing
 * arrival can be traced through the MTA). Throws when mail is unconfigured.
 */
export async function sendProbeMail(
	getEnv: MailEnvReader,
	mail: ProbeMail
): Promise<{ messageId: string | null }> {
	const from = getEnv('MAIL_FROM')?.trim();
	if (!isMailConfiguredFrom(getEnv) || !from) {
		throw new MailNotConfiguredError(
			'Mail is not configured: set MAIL_ENABLED=true, MAIL_SMTP_HOST and MAIL_FROM'
		);
	}
	const info = await createSmtpTransport(getEnv).sendMail({
		from,
		to: mail.to,
		subject: mail.subject,
		text: mail.text
	});
	const messageId = typeof info.messageId === 'string' && info.messageId ? info.messageId : null;
	return { messageId };
}

/** `YYYY-MM-DD` in the site's zone; an invalid zone falls back to UTC. */
export function dayInZone(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: safeZone(timeZone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(date);
	const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
	return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function safeZone(timeZone: string): string {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone }).format();
		return timeZone;
	} catch {
		return 'UTC';
	}
}

/** `Sun` on the site's Sunday (the weekly real-send day). */
export function weekdayInZone(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-US', {
		timeZone: safeZone(timeZone),
		weekday: 'short'
	}).format(date);
}

/** True when the site-local day is Sunday (weekly real delivery). */
export function isWeeklyProbeDay(date: Date, timeZone: string): boolean {
	return weekdayInZone(date, timeZone) === 'Sun';
}
