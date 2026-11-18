// SMTP settings shared by the web transport and the mail probe.
//
// The web path reads `$env/dynamic/private` (a SvelteKit virtual module); the
// drain path runs under plain Node and can only read `process.env`. Both feed
// the SAME derivation here, so a probe can never disagree with the transport
// about host/port/TLS/DKIM - the failure mode this seam exists to prevent
// ("configured" but not deliverable).
//
// Node-loadable: imports only `nodemailer` (no `$env`, no `$lib`).
import nodemailer, { type Transporter } from 'nodemailer';

/** Reads one env value; both call sites wrap their own env source. */
export type MailEnvReader = (name: string) => string | undefined;

export class MailNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MailNotConfiguredError';
	}
}

/**
 * RFC 4871 defaults (nodemailer 10's `defaultFieldNames`) plus
 * `List-Unsubscribe-Post`. RFC 8058 §4 requires DKIM to cover **both**
 * List-Unsubscribe headers; nodemailer's default list already includes
 * `List-Unsubscribe` but not the `-Post` variant, and setting
 * `headerFieldNames` replaces the default list wholesale.
 */
export const DKIM_HEADER_FIELDS =
	'From:Sender:Reply-To:Subject:Date:Message-ID:To:Cc:MIME-Version:Content-Type:' +
	'Content-Transfer-Encoding:Content-ID:Content-Description:Resent-Date:Resent-From:' +
	'Resent-Sender:Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References:' +
	'List-Id:List-Help:List-Unsubscribe:List-Unsubscribe-Post:List-Subscribe:List-Post:' +
	'List-Owner:List-Archive';

export function isMailConfiguredFrom(getEnv: MailEnvReader): boolean {
	// MAIL_FROM is not optional: sendMail throws without it, and a gate that
	// ignored it would let sign-up succeed while the verification mail fails.
	return (
		getEnv('MAIL_ENABLED') === 'true' &&
		Boolean(getEnv('MAIL_SMTP_HOST')) &&
		Boolean(getEnv('MAIL_FROM'))
	);
}

/**
 * Dev-logging is allowed in development, or outside production with
 * MAIL_DEV_LOG=true, or in production only with the second explicit switch
 * MAIL_DEV_LOG_OK=true (the e2e preview). A stray MAIL_DEV_LOG in production
 * therefore falls through to sendMail and fails loudly instead of printing
 * verification/reset tokens to the container log.
 */
export function devLogPermitted(input: {
	dev: boolean;
	nodeEnv?: string;
	mailDevLog?: string;
	mailDevLogOk?: string;
}): boolean {
	// Production wins over the build flag: a production deployment must never
	// print tokens just because the bundle was built with DEV semantics.
	if (input.nodeEnv === 'production') {
		return input.mailDevLog === 'true' && input.mailDevLogOk === 'true';
	}
	return input.dev || input.mailDevLog === 'true';
}

/** `devLogPermitted` against an env reader; `dev` comes from the caller. */
export function devLogAllowedFrom(getEnv: MailEnvReader, dev: boolean): boolean {
	return devLogPermitted({
		dev,
		nodeEnv: getEnv('NODE_ENV'),
		mailDevLog: getEnv('MAIL_DEV_LOG'),
		mailDevLogOk: getEnv('MAIL_DEV_LOG_OK')
	});
}

/**
 * Relay/MTA errors routinely echo the recipient address and the server banner.
 * The run ledger is backed up and admin-visible, so every failure string that
 * leaves the mail path goes through this before it is stored (the
 * Notifications page already used it for its test-send result; moved here so
 * the plain-Node probe shares the exact same redaction).
 */
export function redactMailError(error: unknown): string {
	const raw = error instanceof Error ? error.message || error.name : 'unknown error';
	return raw
		.replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[redacted]')
		.slice(0, 200);
}

function dkimOptionsFrom(getEnv: MailEnvReader):
	| {
			domainName: string;
			keySelector: string;
			privateKey: string;
			headerFieldNames: string;
	  }
	| undefined {
	const domainName = getEnv('MAIL_DKIM_DOMAIN');
	const keySelector = getEnv('MAIL_DKIM_SELECTOR');
	const key = getEnv('MAIL_DKIM_PRIVATE_KEY');
	if (!domainName || !keySelector || !key) return undefined;
	// `.env` cannot carry literal newlines portably; accept \n escapes.
	return {
		domainName,
		keySelector,
		privateKey: key.replace(/\\n/g, '\n'),
		headerFieldNames: DKIM_HEADER_FIELDS
	};
}

let warnedUnsigned = false;

/**
 * Build the nodemailer transport from the shared derivation. Callers keep
 * their own memoisation (the web path reuses one connection; the daily probe
 * may build one fresh).
 */
export function createSmtpTransport(getEnv: MailEnvReader): Transporter {
	const host = getEnv('MAIL_SMTP_HOST') ?? '';
	const port = Number(getEnv('MAIL_SMTP_PORT') || 587);
	const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
	// A local MTA on loopback rarely offers STARTTLS; external submission
	// ports (587/2525) get mandatory TLS unless explicitly disabled.
	const requireTlsRaw = getEnv('MAIL_SMTP_REQUIRE_TLS');
	const requireTls = requireTlsRaw ? requireTlsRaw === 'true' : port !== 465 && !loopback;
	if (!dkimOptionsFrom(getEnv) && !warnedUnsigned) {
		warnedUnsigned = true;
		console.warn('[mail] DKIM is not configured; outbound mail will be unsigned');
	}
	const user = getEnv('MAIL_SMTP_USER');
	return nodemailer.createTransport({
		host,
		port,
		secure: getEnv('MAIL_SMTP_SECURE') === 'true' || port === 465,
		auth: user ? { user, pass: getEnv('MAIL_SMTP_PASS') ?? '' } : undefined,
		requireTLS: requireTls,
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 20_000,
		dkim: dkimOptionsFrom(getEnv)
	});
}
