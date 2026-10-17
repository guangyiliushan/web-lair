import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock, sendMailMock, createTransportMock } = vi.hoisted(() => {
	const envMock: Record<string, string | undefined> = {};
	const sendMailMock = vi.fn(async () => ({ messageId: 'test' }));
	const createTransportMock = vi.fn((options: unknown) => ({ sendMail: sendMailMock, options }));
	return { envMock, sendMailMock, createTransportMock };
});

vi.mock('$env/dynamic/private', () => ({ env: envMock }));
vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }));

import {
	MailNotConfiguredError,
	isMailConfigured,
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
	createTransportMock.mockClear();
	resetMailTransport();
});

describe('mail transport (D-2)', () => {
	it('is not configured until both the switch and a host are set', () => {
		expect(isMailConfigured()).toBe(false);
		envMock.MAIL_ENABLED = 'true';
		expect(isMailConfigured()).toBe(false);
		envMock.MAIL_SMTP_HOST = 'smtp.example.com';
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
			requireTLS: true
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
		expect(options.dkim).toEqual({
			domainName: 'mail.example.com',
			keySelector: 'wl',
			privateKey: 'line-1\nline-2'
		});
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
