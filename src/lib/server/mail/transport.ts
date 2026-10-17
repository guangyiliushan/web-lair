import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '$env/dynamic/private';

/**
 * SMTP transport (deploy batch D-2, Q7 ruling).
 *
 * The production endpoint is whatever SMTP host `.env` points at — a
 * self-hosted MTA on the box (default) or a relay if the 25/PBL/PTR probes
 * fail (deploy/RUNBOOK.md). DKIM is signed **in process** by nodemailer, so a
 * dumb relay/MTA needs no milter configuration.
 *
 * Failure semantics (Q8): `sendMail` throws when unconfigured. `sendMailOrDevLog`
 * keeps local development usable (verification links print to the console,
 * the `devLogMail` precedent) and throws in production so a misconfigured
 * deployment cannot silently swallow registration email.
 */

export class MailNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MailNotConfiguredError';
	}
}

export interface OutgoingMail {
	to: string;
	subject: string;
	text: string;
}

export function isMailConfigured(): boolean {
	return env.MAIL_ENABLED === 'true' && Boolean(env.MAIL_SMTP_HOST);
}

/**
 * True when the call sites can hand mail off without throwing: configured, or
 * an explicit dev-log environment. The register page and its action share this
 * predicate so the banner and the submit button agree.
 */
export function isMailDeliveryAvailable(): boolean {
	return isMailConfigured() || import.meta.env.DEV || env.MAIL_DEV_LOG === 'true';
}

function dkimOptions():
	{ domainName: string; keySelector: string; privateKey: string } | undefined {
	const domainName = env.MAIL_DKIM_DOMAIN;
	const keySelector = env.MAIL_DKIM_SELECTOR;
	const key = env.MAIL_DKIM_PRIVATE_KEY;
	if (!domainName || !keySelector || !key) return undefined;
	// `.env` cannot carry literal newlines portably; accept \n escapes.
	return { domainName, keySelector, privateKey: key.replace(/\\n/g, '\n') };
}

let cached: Transporter | null = null;
let warnedUnsigned = false;

function transporter(): Transporter {
	if (cached) return cached;
	const host = env.MAIL_SMTP_HOST ?? '';
	const port = Number(env.MAIL_SMTP_PORT || 587);
	const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
	// A local MTA on loopback rarely offers STARTTLS; external submission
	// ports (587/2525) get mandatory TLS unless explicitly disabled.
	const requireTls = env.MAIL_SMTP_REQUIRE_TLS
		? env.MAIL_SMTP_REQUIRE_TLS === 'true'
		: port !== 465 && !loopback;
	if (!dkimOptions() && !warnedUnsigned) {
		warnedUnsigned = true;
		console.warn('[mail] DKIM is not configured; outbound mail will be unsigned');
	}
	cached = nodemailer.createTransport({
		host,
		port,
		secure: env.MAIL_SMTP_SECURE === 'true' || port === 465,
		auth: env.MAIL_SMTP_USER
			? { user: env.MAIL_SMTP_USER, pass: env.MAIL_SMTP_PASS ?? '' }
			: undefined,
		requireTLS: requireTls,
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 20_000,
		dkim: dkimOptions()
	});
	return cached;
}

/** Test hook: drop the memoised transport after env changes. */
export function resetMailTransport(): void {
	cached = null;
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
		text: mail.text
	});
}

/**
 * Auth/subscription call sites use this: dev prints the message instead of
 * requiring an SMTP server; production delegates to `sendMail` (fail-loud).
 */
export async function sendMailOrDevLog(mail: OutgoingMail): Promise<void> {
	if (env.NODE_ENV === 'production' && env.MAIL_DEV_LOG === 'true' && env.MAIL_SMTP_HOST) {
		// Configured transport + dev logging = tokens in the log instead of mail.
		// (An unconfigured preview may dev-log; e2e relies on that.)
		throw new Error(
			'[mail] MAIL_DEV_LOG cannot be enabled alongside a configured SMTP host in production'
		);
	}
	const devLog = import.meta.env.DEV || env.MAIL_DEV_LOG === 'true';
	if (!isMailConfigured() && devLog) {
		console.info(`[mail:dev] to=${mail.to} subject=${mail.subject}\n${mail.text}`);
		return;
	}
	await sendMail(mail);
}
