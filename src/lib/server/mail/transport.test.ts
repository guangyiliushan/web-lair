import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock, sendMailMock, verifyMock, createTransportMock } = vi.hoisted(() => {
	const envMock: Record<string, string | undefined> = {};
	const sendMailMock = vi.fn(async () => ({ messageId: 'test' }));
	const verifyMock = vi.fn(async () => true);
	const createTransportMock = vi.fn((options: unknown) => ({
		sendMail: sendMailMock,
		verify: verifyMock,
		options
	}));
	return { envMock, sendMailMock, verifyMock, createTransportMock };
});

vi.mock('$env/dynamic/private', () => ({ env: envMock }));
vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }));

import {
	MailNotConfiguredError,
	devLogPermitted,
	isMailConfigured,
	isMailDeliveryAvailable,
	isMailDeliveryAvailableLive,
	resetMailTransport,
	sendMail,
	sendMailOrDevLog
} from './transport';

function configure(overrides: Record<string, string> = {}) {
	Object.assign(envMock, {
		MAIL_ENABLED: 'true',
		MAIL_SMTP_HOST: 'smtp.example.com',
		MAIL_SMTP_PORT: '587',
		MAIL_SMTP_USER: 'user',
		MAIL_SMTP_PASS: 'pass',
		MAIL_FROM: 'noreply@mail.example.com',
		...overrides
	});
	resetMailTransport();
}

beforeEach(() => {
	for (const key of Object.keys(envMock)) delete envMock[key];
	sendMailMock.mockClear();
	verifyMock.mockClear();
	createTransportMock.mockClear();
	resetMailTransport();
});

describe('mail transport (D-2)', () => {
	it('is not configured until the switch, host and sender are set', () => {
		expect(isMailConfigured()).toBe(false);
		envMock.MAIL_ENABLED = 'true';
		expect(isMailConfigured()).toBe(false);
		envMock.MAIL_SMTP_HOST = 'smtp.example.com';
		expect(isMailConfigured()).toBe(false);
		envMock.MAIL_FROM = 'noreply@mail.example.com';
		expect(isMailConfigured()).toBe(true);
	});

	it('fails loudly when a production send has no configuration', async () => {
		await expect(sendMail({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toBeInstanceOf(
			MailNotConfiguredError
		);
		expect(createTransportMock).not.toHaveBeenCalled();
	});

	it('fails loudly when MAIL_FROM is missing', async () => {
		configure({ MAIL_FROM: '' });
		await expect(sendMail({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toBeInstanceOf(
			MailNotConfiguredError
		);
	});

	it('sends through nodemailer with STARTTLS submission defaults', async () => {
		configure();
		await sendMail({ to: 'reader@example.com', subject: 'Hi', text: 'Body' });

		expect(createTransportMock).toHaveBeenCalledTimes(1);
		const options = createTransportMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(options).toMatchObject({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			requireTLS: true,
			auth: { user: 'user', pass: 'pass' }
		});
		expect(sendMailMock).toHaveBeenCalledWith({
			from: 'noreply@mail.example.com',
			to: 'reader@example.com',
			subject: 'Hi',
			text: 'Body'
		});
	});

	it('does not require STARTTLS for a loopback MTA', async () => {
		configure({ MAIL_SMTP_HOST: '127.0.0.1', MAIL_SMTP_PORT: '25', MAIL_SMTP_USER: '' });
		await sendMail({ to: 'a@b.c', subject: 's', text: 't' });
		const options = createTransportMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(options.requireTLS).toBe(false);
		expect(options.auth).toBeUndefined();
	});

	it('reads the port from env and treats 2525 as a STARTTLS submission port', async () => {
		configure({ MAIL_SMTP_PORT: '2525' });
		await sendMail({ to: 'a@b.c', subject: 's', text: 't' });
		const options = createTransportMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(options.port).toBe(2525);
		expect(options.requireTLS).toBe(true);
	});

	it('uses implicit TLS on 465 (secure true, no STARTTLS requirement)', async () => {
		configure({ MAIL_SMTP_PORT: '465' });
		await sendMail({ to: 'a@b.c', subject: 's', text: 't' });
		const options = createTransportMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(options.secure).toBe(true);
		expect(options.requireTLS).toBe(false);
	});

	it('honours MAIL_SMTP_REQUIRE_TLS=false for a relay without STARTTLS', async () => {
		configure({ MAIL_SMTP_REQUIRE_TLS: 'false' });
		await sendMail({ to: 'a@b.c', subject: 's', text: 't' });
		const options = createTransportMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(options.requireTLS).toBe(false);
	});

	it('delegates to the real transport when configured, even in dev', async () => {
		configure();
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		await sendMailOrDevLog({ to: 'a@b.c', subject: 's', text: 't' });
		expect(createTransportMock).toHaveBeenCalledTimes(1);
		expect(info).not.toHaveBeenCalled();
		info.mockRestore();
	});

	it('sends for real in production when a transport is configured, ignoring MAIL_DEV_LOG', async () => {
		configure({ NODE_ENV: 'production', MAIL_DEV_LOG: 'true' });
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		await sendMailOrDevLog({ to: 'a@b.c', subject: 's', text: 't' });
		expect(createTransportMock).toHaveBeenCalledTimes(1);
		expect(sendMailMock).toHaveBeenCalledTimes(1);
		expect(info).not.toHaveBeenCalled();
		info.mockRestore();
	});

	it('fails loudly in production without the second switch (tokens never reach stdout)', async () => {
		Object.assign(envMock, { NODE_ENV: 'production', MAIL_DEV_LOG: 'true' });
		delete envMock.MAIL_DEV_LOG_OK;
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		await expect(sendMailOrDevLog({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toBeInstanceOf(
			MailNotConfiguredError
		);
		expect(info).not.toHaveBeenCalled();
		info.mockRestore();
	});

	it('verifies the SMTP handshake once and caches the result', async () => {
		configure();
		expect(await isMailDeliveryAvailableLive()).toBe(true);
		expect(await isMailDeliveryAvailableLive()).toBe(true);
		expect(verifyMock).toHaveBeenCalledTimes(1);
	});

	it('reports unavailable when the SMTP verification fails', async () => {
		configure();
		verifyMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await isMailDeliveryAvailableLive()).toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('skips SMTP verification in dev-log mode', async () => {
		Object.assign(envMock, { MAIL_DEV_LOG: 'true' });
		expect(await isMailDeliveryAvailableLive()).toBe(true);
		expect(verifyMock).not.toHaveBeenCalled();
	});

	it('treats a missing MAIL_FROM as unconfigured', () => {
		configure({ MAIL_FROM: '' });
		expect(isMailConfigured()).toBe(false);
	});

	it('dev-log policy: production requires the explicit second switch', () => {
		expect(devLogPermitted({ dev: true })).toBe(true);
		// A production deployment outranks the build flag.
		expect(devLogPermitted({ dev: true, nodeEnv: 'production' })).toBe(false);
		expect(devLogPermitted({ dev: false, nodeEnv: 'production', mailDevLog: 'true' })).toBe(false);
		expect(
			devLogPermitted({
				dev: false,
				nodeEnv: 'production',
				mailDevLog: 'true',
				mailDevLogOk: 'true'
			})
		).toBe(true);
		expect(devLogPermitted({ dev: false, nodeEnv: 'production' })).toBe(false);
	});

	it('reports delivery availability through the configured transport', () => {
		configure();
		expect(isMailDeliveryAvailable()).toBe(true);
	});

	it('signs DKIM in-process and unescapes the PEM newlines', async () => {
		configure({
			MAIL_DKIM_DOMAIN: 'mail.example.com',
			MAIL_DKIM_SELECTOR: 'wl',
			MAIL_DKIM_PRIVATE_KEY: 'line-1\\nline-2'
		});
		await sendMail({ to: 'a@b.c', subject: 's', text: 't' });
		const options = createTransportMock.mock.calls[0]![0] as {
			dkim: { domainName: string; keySelector: string; privateKey: string };
		};
		expect(options.dkim).toMatchObject({
			domainName: 'mail.example.com',
			keySelector: 'wl',
			privateKey: 'line-1\nline-2'
		});
	});

	it('signs both RFC 8058 headers (List-Unsubscribe + -Post)', async () => {
		configure({
			MAIL_DKIM_DOMAIN: 'mail.example.com',
			MAIL_DKIM_SELECTOR: 'wl',
			MAIL_DKIM_PRIVATE_KEY: 'line-1\\nline-2'
		});
		await sendMail({ to: 'a@b.c', subject: 's', text: 't' });
		const options = createTransportMock.mock.calls[0]![0] as {
			dkim: { headerFieldNames: string };
		};
		const fields = options.dkim.headerFieldNames.split(':');
		expect(fields).toContain('List-Unsubscribe');
		expect(fields).toContain('List-Unsubscribe-Post');
		// Setting headerFieldNames replaces nodemailer's defaults wholesale.
		expect(fields).toContain('From');
		expect(fields).toContain('To');
		expect(fields).toContain('Subject');
	});

	it('passes bulk headers through to nodemailer, never inventing its own', async () => {
		configure();
		await sendMail({
			to: 'reader@example.com',
			subject: 'Newsletter',
			text: 'Body',
			headers: {
				'List-Unsubscribe': '<https://lair.example/api/unsubscribe/one-click?token=x>',
				'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
			}
		});
		expect(sendMailMock).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: {
					'List-Unsubscribe': '<https://lair.example/api/unsubscribe/one-click?token=x>',
					'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
				}
			})
		);
	});

	it('reuses the transport across sends', async () => {
		configure();
		await sendMail({ to: 'a@b.c', subject: 's1', text: 't' });
		await sendMail({ to: 'a@b.c', subject: 's2', text: 't' });
		expect(createTransportMock).toHaveBeenCalledTimes(1);
		expect(sendMailMock).toHaveBeenCalledTimes(2);
	});

	it('dev-logs instead of throwing when unconfigured', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		await expect(
			sendMailOrDevLog({ to: 'dev@example.com', subject: 'Verify', text: 'link' })
		).resolves.toBeUndefined();
		expect(createTransportMock).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalled();
		info.mockRestore();
	});
});
