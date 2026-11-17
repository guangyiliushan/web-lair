import type { Transporter } from 'nodemailer';
import { env } from '$env/dynamic/private';
import {
	MailNotConfiguredError,
	createSmtpTransport,
	devLogAllowedFrom,
	isMailConfiguredFrom,
	redactMailError,
	type MailEnvReader
} from './smtp';
import { resetMailProbeCache, verifyMailbox } from './probe';
import { sanitizeErrorText } from '../jobs/error-text.ts';

/**
 * SMTP transport.
 *
 * The production endpoint is whatever SMTP host `.env` points at — a
 * self-hosted MTA on the box (default) or a relay if the 25/PBL/PTR probes
 * fail (deploy/RUNBOOK.md). DKIM is signed **in process** by nodemailer, so a
 * dumb relay/MTA needs no milter configuration.
 *
 * Failure semantics: `sendMail` throws when unconfigured. `sendMailOrDevLog`
 * keeps local development usable (verification links print to the console,
 * the `devLogMail` precedent) and throws in production so a misconfigured
 * deployment cannot silently swallow registration email.
 *
 * The settings derivation and the verify cache live in `smtp.ts` / `probe.ts`
 * so the plain-Node mail probe uses the exact same rules.
 */

export { MailNotConfiguredError } from './smtp';
export { DKIM_HEADER_FIELDS, devLogPermitted } from './smtp';

export interface OutgoingMail {
	to: string;
	subject: string;
	text: string;
	/**
	 * Extra headers. Bulk senders add RFC 8058 `List-Unsubscribe` and
	 * `List-Unsubscribe-Post`; transactional mail (confirmation, reset) must
	 * not carry them (Gmail classifies it separately).
	 */
	headers?: Record<string, string>;
}

const getEnv: MailEnvReader = (name) => env[name] as string | undefined;

export function isMailConfigured(): boolean {
	return isMailConfiguredFrom(getEnv);
}

function devLogAllowed(): boolean {
	return devLogAllowedFrom(getEnv, import.meta.env.DEV);
}

/**
 * True when the call sites can hand mail off without throwing. The register
 * page and its action share this predicate so the banner and the button agree.
 */
export function isMailDeliveryAvailable(): boolean {
	return isMailConfigured() || devLogAllowed();
}

/** Better-auth swallows this error in its background runner; log it here. */
export function sendVerificationFailure(email: string, error: unknown): void {
	// Keep the address and any SMTP banner address out of the log; the domain is
	// enough to spot a bad sender.
	console.error('[mail] verification send failed', {
		domain: email.split('@')[1] ?? '?',
		error: sanitizeErrorText(redactMailError(error))
	});
}

/**
 * Sign-up is the one path where a silently swallowed transport error creates an
 * account that can never be verified. Verify the SMTP handshake first (cached
 * for a minute); dev-log mode needs no verification. Shares the cache and the
 * settings derivation with the `mail.probe` job.
 */
export async function isMailDeliveryAvailableLive(): Promise<boolean> {
	if (!isMailConfigured()) return devLogAllowed();
	try {
		const result = await verifyMailbox(getEnv, { transport: transporter() });
		return result.ok;
	} catch (error) {
		// `transporter()` builds the transport synchronously and reads env, so a
		// malformed host/port throws HERE, not inside the probe's try block. A
		// throw must read as "not available" (the register page shows its banner)
		// rather than a 500.
		console.warn('[mail] live availability probe threw', sanitizeErrorText(redactMailError(error)));
		return false;
	}
}

let cached: Transporter | null = null;

function transporter(): Transporter {
	cached ??= createSmtpTransport(getEnv);
	return cached;
}

/** Test hook: drop the memoised transport after env changes. */
export function resetMailTransport(): void {
	cached = null;
	resetMailProbeCache();
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
	if (!isMailConfigured()) {
		throw new MailNotConfiguredError(
			'Mail is not configured: set MAIL_ENABLED=true and MAIL_SMTP_HOST'
		);
	}
	const from = env.MAIL_FROM;
	if (!from) throw new MailNotConfiguredError('MAIL_FROM is not set');
	await transporter().sendMail({
		from,
		to: mail.to,
		subject: mail.subject,
		text: mail.text,
		headers: mail.headers
	});
}

/**
 * Auth/subscription call sites use this: dev prints the message instead of
 * requiring an SMTP server; production delegates to `sendMail` (fail-loud).
 */
export async function sendMailOrDevLog(mail: OutgoingMail): Promise<void> {
	if (!isMailConfigured() && devLogAllowed()) {
		console.info(`[mail:dev] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
		return;
	}
	await sendMail(mail);
}
