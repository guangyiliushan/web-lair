import { readNotificationPayload, redactNotificationError } from '../format.ts';
import type { AdapterResult } from './types.ts';

/**
 * Email adapter: owner-facing notification mail over the SAME
 * SMTP derivation the rest of the app uses (`mail/smtp.ts` - one source for
 * host/port/TLS/AUTH/DKIM, so the notification path cannot disagree with
 * registration mail).
 *
 * Recipient: the owner row (`user.role = 'owner'`), resolved by the caller at
 * delivery time. Notifications are transactional admin mail: no unsubscribe
 * headers, no bulk classification.
 *
 * Failure classification: a missing configuration, an auth rejection or an
 * envelope refusal (`EAUTH`, `EENVELOPE`, `MailNotConfiguredError`) is
 * permanent - retrying cannot fix it and the operator must act. Transport
 * errors (timeout, connection reset, 4xx greeting) are retryable.
 *
 * Node-strip-loadable: the SMTP module (and nodemailer with it) is imported
 * lazily, so the drain's static graph stays lean and a tick with no email
 * due pays nothing for it.
 */
export interface EmailAdapterDeps {
	getEnv?: (name: string) => string | undefined;
	/** Test seam: a transport that resolves/rejects like nodemailer's. */
	transport?: {
		sendMail(message: {
			from: string;
			to: string;
			subject: string;
			text: string;
		}): Promise<{ messageId?: string }>;
	};
}

const PERMANENT_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE', 'EMISSINGFROM']);

/** `[web-lair] <title>` + one link line; the payload is already bounded. */
export function buildNotificationMail(input: { title: string; body: string; url?: string }): {
	subject: string;
	text: string;
} {
	const subject = `[web-lair] ${input.title}`.slice(0, 160);
	const lines = [input.body];
	if (input.url) lines.push('', input.url);
	return { subject, text: lines.join('\n') };
}

/**
 * Send one notification mail. `ownerEmail` is resolved by the caller inside
 * the delivery transaction (a missing owner is a permanent failure: nothing
 * will ever accept this message).
 */
export async function sendNotificationEmail(
	ownerEmail: string | null,
	payload: unknown,
	deps: EmailAdapterDeps = {}
): Promise<AdapterResult> {
	const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
	if (!ownerEmail) {
		return {
			ok: false,
			permanent: true,
			error: 'no owner account with an email address',
			responseCode: null
		};
	}
	const shaped = readNotificationPayload(payload);
	if (!shaped.title && !shaped.body) {
		return { ok: false, permanent: true, error: 'payload is empty', responseCode: null };
	}
	const mail = buildNotificationMail(shaped);
	const from = getEnv('MAIL_FROM');
	if (!from) {
		return { ok: false, permanent: true, error: 'MAIL_FROM is not set', responseCode: null };
	}
	try {
		let transport = deps.transport;
		if (!transport) {
			// Lazy: pulls nodemailer in only when a mail is actually due.
			const { createSmtpTransport, isMailConfiguredFrom } = await import('../../mail/smtp.ts');
			if (!isMailConfiguredFrom(getEnv)) {
				return {
					ok: false,
					permanent: true,
					error: 'mail is not configured (MAIL_ENABLED/MAIL_SMTP_HOST/MAIL_FROM)',
					responseCode: null
				};
			}
			transport = createSmtpTransport(getEnv);
		}
		await transport.sendMail({ from, to: ownerEmail, subject: mail.subject, text: mail.text });
		return { ok: true, responseCode: null };
	} catch (error) {
		const code =
			typeof error === 'object' && error !== null && 'code' in error
				? String((error as { code?: unknown }).code ?? '')
				: '';
		const permanent = PERMANENT_CODES.has(code);
		return {
			ok: false,
			permanent,
			error: redactNotificationError(error),
			responseCode: null
		};
	}
}
