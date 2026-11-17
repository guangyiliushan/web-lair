/**
 * Read-only mail status.
 *
 * The Notifications page shows what the SMTP transport will actually do. The
 * credentials themselves stay in `.env`: `MAIL_SMTP_USER`/`MAIL_SMTP_PASS`
 * are never read here, so no code path can echo them into page data.
 *
 * The TLS derivation below is a legacy copy: the transport's single source is
 * now `mail/smtp.ts` (`createSmtpTransport`). This read-only surface is kept
 * for the admin page and is known to drift (`MAIL_ENABLED` trim, port guards);
 * unifying the two derivations is still outstanding - do not treat the page
 * as proof of what the sender will do.
 */
export interface MailStatus {
	enabled: boolean;
	configured: boolean;
	host: string | null;
	port: number | null;
	from: string | null;
	tls: 'implicit' | 'starttls' | 'opportunistic' | null;
	dkim: {
		configured: boolean;
		domain: string | null;
		selector: string | null;
	};
}

export type MailEnv = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * Derive the status from the environment. `MAIL_ENABLED` must be the literal
 * `true` (same rule as `isMailConfigured`), so a typo cannot advertise a
 * configured mailer that the send path would refuse.
 */
export function readMailStatus(getEnv: (name: string) => string | undefined): MailStatus {
	const enabled = getEnv('MAIL_ENABLED')?.trim() === 'true';
	const host = nonEmpty(getEnv('MAIL_SMTP_HOST'));
	const from = nonEmpty(getEnv('MAIL_FROM'));
	const rawPort = nonEmpty(getEnv('MAIL_SMTP_PORT'));
	const port = rawPort ? Number(rawPort) : host ? 587 : null;
	const validPort = port !== null && Number.isInteger(port) && port > 0 && port <= 65535;

	const dkimDomain = nonEmpty(getEnv('MAIL_DKIM_DOMAIN'));
	const dkimSelector = nonEmpty(getEnv('MAIL_DKIM_SELECTOR'));
	const dkimKey = nonEmpty(getEnv('MAIL_DKIM_PRIVATE_KEY'));
	const dkimConfigured = Boolean(dkimDomain && dkimSelector && dkimKey);

	const configured = enabled && Boolean(host) && Boolean(from);
	let tls: MailStatus['tls'] = null;
	if (validPort && host) {
		const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
		const secure = getEnv('MAIL_SMTP_SECURE')?.trim() === 'true' || port === 465;
		const requireTls = getEnv('MAIL_SMTP_REQUIRE_TLS')
			? getEnv('MAIL_SMTP_REQUIRE_TLS')?.trim() === 'true'
			: port !== 465 && !loopback;
		tls = secure ? 'implicit' : requireTls ? 'starttls' : 'opportunistic';
	}

	return {
		enabled,
		configured,
		host,
		port: validPort ? port : null,
		from,
		tls,
		dkim: {
			configured: dkimConfigured,
			domain: dkimConfigured ? dkimDomain : null,
			selector: dkimConfigured ? dkimSelector : null
		}
	};
}

/** Mask an address for the audit payload: enough to identify, no full address. */
export function maskEmailAddress(email: string): string {
	const at = email.lastIndexOf('@');
	if (at <= 0) return '[redacted]';
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	if (!domain) return '[redacted]';
	return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * SMTP/nodemailer errors routinely echo the recipient ("550 5.1.1
 * <user@example.com>: ...") and server banners. The implementation moved to
 * `smtp.ts` so the plain-Node mail probe redacts with the exact same rules;
 * re-exported here for the admin surface's existing imports.
 *
 * NOTE: `readMailStatus` below still derives the TLS mode independently;
 * `smtp.ts` is the transport owner, not `mail/transport.ts`. Do not assume
 * this status surface and the sender agree when either derivation changes.
 */
export { redactMailError } from './smtp';
