import { describe, expect, it, vi } from 'vitest';
import { buildNotificationMail, sendNotificationEmail } from './email';

/**
 * Email adapter teeth: the owner is the only recipient, the
 * subject is prefixed so it is recognizable in the inbox, an auth/envelope
 * rejection is permanent (retrying cannot fix it) while a transport error is
 * retryable, and a relay banner cannot leak the owner's address into the
 * delivery log.
 */
const OWNER = 'owner@lair.example';

function env(values: Record<string, string | undefined>) {
	return (name: string) => values[name];
}

describe('buildNotificationMail', () => {
	it('prefixes the subject and appends the link', () => {
		const mail = buildNotificationMail({
			title: 'New comment awaiting review',
			body: 'Alice: hello',
			url: 'https://lair.example/admin/comments'
		});
		expect(mail.subject).toBe('[web-lair] New comment awaiting review');
		expect(mail.text).toBe('Alice: hello\n\nhttps://lair.example/admin/comments');
	});

	it('omits the link block when there is no url', () => {
		expect(buildNotificationMail({ title: 't', body: 'b' }).text).toBe('b');
	});
});

describe('sendNotificationEmail', () => {
	const configured = env({
		MAIL_FROM: 'noreply@lair.example',
		MAIL_ENABLED: 'true',
		MAIL_SMTP_HOST: 'smtp.lair.example'
	});

	it('sends through the injected transport with the owner as recipient', async () => {
		const sendMail = vi.fn(async () => ({ messageId: 'abc' }));
		const result = await sendNotificationEmail(
			OWNER,
			{ title: 'Disk high', body: 'disk /data at 91%' },
			{ getEnv: configured, transport: { sendMail } }
		);
		expect(result).toEqual({ ok: true, responseCode: null });
		expect(sendMail).toHaveBeenCalledWith({
			from: 'noreply@lair.example',
			to: OWNER,
			subject: '[web-lair] Disk high',
			text: 'disk /data at 91%'
		});
	});

	it('is a permanent failure when there is no owner account', async () => {
		const result = await sendNotificationEmail(
			null,
			{ title: 't', body: 'b' },
			{ getEnv: configured }
		);
		expect(result).toMatchObject({ ok: false, permanent: true });
	});

	it('is a permanent failure when MAIL_FROM is missing', async () => {
		const result = await sendNotificationEmail(
			OWNER,
			{ title: 't', body: 'b' },
			{ getEnv: env({}), transport: { sendMail: vi.fn() } }
		);
		expect(result).toMatchObject({ ok: false, permanent: true, error: 'MAIL_FROM is not set' });
	});

	it('classifies an auth rejection as permanent', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error('Invalid login: 535 5.7.8'), { code: 'EAUTH' });
		});
		const result = await sendNotificationEmail(
			OWNER,
			{ title: 't', body: 'b' },
			{ getEnv: configured, transport: { sendMail } }
		);
		expect(result).toMatchObject({ ok: false, permanent: true });
	});

	it('classifies a transport error as retryable and redacts the address', async () => {
		const sendMail = vi.fn(async () => {
			throw Object.assign(new Error(`connect ETIMEDOUT while sending to ${OWNER}`), {
				code: 'ETIMEDOUT'
			});
		});
		const result = await sendNotificationEmail(
			OWNER,
			{ title: 't', body: 'b' },
			{ getEnv: configured, transport: { sendMail } }
		);
		expect(result).toMatchObject({ ok: false, permanent: false });
		if (!result.ok) {
			expect(result.error).not.toContain(OWNER);
			expect(result.error).toContain('[address]');
		}
	});

	it('refuses an empty payload instead of sending a blank mail', async () => {
		const result = await sendNotificationEmail(
			OWNER,
			{ title: '', body: '' },
			{ getEnv: configured, transport: { sendMail: vi.fn() } }
		);
		expect(result).toMatchObject({ ok: false, permanent: true, error: 'payload is empty' });
	});
});
