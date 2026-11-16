import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createTransportMock, sendMailMock, verifyMock } = vi.hoisted(() => {
	const sendMailMock = vi.fn(async (): Promise<{ messageId?: string }> => ({
		messageId: '<probe-1@mail.example.com>'
	}));
	const verifyMock = vi.fn(async () => true);
	const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock, verify: verifyMock }));
	return { createTransportMock, sendMailMock, verifyMock };
});

vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }));

import {
	MAIL_VERIFY_TTL_MS,
	dayInZone,
	isWeeklyProbeDay,
	resetMailProbeCache,
	sendProbeMail,
	verifyMailbox,
	weekdayInZone
} from './probe';

const CONFIGURED = {
	MAIL_ENABLED: 'true',
	MAIL_SMTP_HOST: 'smtp.example.com',
	MAIL_SMTP_PORT: '587',
	MAIL_FROM: 'noreply@mail.example.com'
};

function reader(values: Record<string, string | undefined>) {
	return (name: string) => values[name];
}

beforeEach(() => {
	resetMailProbeCache();
	sendMailMock.mockClear();
	verifyMock.mockClear();
	createTransportMock.mockClear();
});

describe('verifyMailbox (daily handshake probe)', () => {
	it('verifies once and serves the result from the 60s cache', async () => {
		expect(MAIL_VERIFY_TTL_MS).toBe(60_000);
		const getEnv = reader(CONFIGURED);
		const now = 1_000_000;
		await expect(verifyMailbox(getEnv, { now })).resolves.toEqual({ ok: true, cached: false });
		await expect(verifyMailbox(getEnv, { now: now + 30_000 })).resolves.toEqual({
			ok: true,
			cached: true
		});
		expect(verifyMock).toHaveBeenCalledTimes(1);

		await expect(verifyMailbox(getEnv, { now: now + MAIL_VERIFY_TTL_MS })).resolves.toEqual({
			ok: true,
			cached: false
		});
		expect(verifyMock).toHaveBeenCalledTimes(2);
	});

	it('reports a handshake failure with a sanitized reason and caches it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		verifyMock.mockRejectedValueOnce(
			new Error(
				'550 5.1.1 <user@example.com>: connect ECONNREFUSED https://smtp.example.com:587/socket?token=SECRET'
			)
		);
		const getEnv = reader(CONFIGURED);
		const failed = await verifyMailbox(getEnv, { now: 5 });
		expect(failed.ok).toBe(false);
		expect(failed.reason).toContain('ECONNREFUSED');
		expect(failed.reason).not.toContain('SECRET');
		expect(failed.reason).not.toContain('user@example.com');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('[mail] SMTP verification failed'));

		const again = await verifyMailbox(getEnv, { now: 5 + 1_000 });
		expect(again).toMatchObject({ ok: false, cached: true });
		expect(verifyMock).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it('reports unavailable when transport construction throws', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		createTransportMock.mockImplementationOnce(() => {
			throw new Error('bad env');
		});
		const result = await verifyMailbox(reader(CONFIGURED), { now: 7 });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('bad env');
		warn.mockRestore();
	});

	it('does not cache the unconfigured answer (env may change in-process)', async () => {
		const getEnv = reader({});
		await expect(verifyMailbox(getEnv)).resolves.toMatchObject({
			ok: false,
			cached: false,
			skipped: 'not-configured'
		});
		await expect(
			verifyMailbox(reader({ MAIL_DEV_LOG: 'true' }), { now: 1 })
		).resolves.toMatchObject({ ok: true, cached: false, skipped: 'not-configured' });
		expect(verifyMock).not.toHaveBeenCalled();
	});

	it('never reports the production dev-log switch as a deliverable transport', async () => {
		const getEnv = reader({ NODE_ENV: 'production', MAIL_DEV_LOG: 'true' });
		await expect(verifyMailbox(getEnv)).resolves.toMatchObject({
			ok: false,
			skipped: 'not-configured'
		});
	});
});

describe('sendProbeMail (weekly real delivery)', () => {
	it('sends through the shared transport and returns the message id', async () => {
		await expect(
			sendProbeMail(reader(CONFIGURED), {
				to: 'owner@example.com',
				subject: 'web-lair mail probe 2026-11-15',
				text: 'hello'
			})
		).resolves.toEqual({ messageId: '<probe-1@mail.example.com>' });
		expect(sendMailMock).toHaveBeenCalledWith({
			from: 'noreply@mail.example.com',
			to: 'owner@example.com',
			subject: 'web-lair mail probe 2026-11-15',
			text: 'hello'
		});
	});

	it('reports a missing message id instead of inventing one', async () => {
		sendMailMock.mockResolvedValueOnce({});
		await expect(
			sendProbeMail(reader(CONFIGURED), { to: 'o@e.c', subject: 's', text: 't' })
		).resolves.toEqual({ messageId: null });
	});

	it('refuses to send when mail is unconfigured', async () => {
		await expect(
			sendProbeMail(reader({}), { to: 'o@e.c', subject: 's', text: 't' })
		).rejects.toThrow(/not configured/i);
		expect(sendMailMock).not.toHaveBeenCalled();
	});

	it('refuses to send without MAIL_FROM', async () => {
		await expect(
			sendProbeMail(reader({ ...CONFIGURED, MAIL_FROM: '' }), {
				to: 'o@e.c',
				subject: 's',
				text: 't'
			})
		).rejects.toThrow(/not configured/i);
	});
});

describe('site-local day helpers', () => {
	const sundayNoonUtc = new Date('2026-11-15T12:00:00Z');

	it('resolves the day in the requested zone', () => {
		expect(dayInZone(sundayNoonUtc, 'UTC')).toBe('2026-11-15');
		expect(dayInZone(sundayNoonUtc, 'Asia/Taipei')).toBe('2026-11-15');
		// +14 crosses into the next calendar day at 12:00Z.
		expect(dayInZone(sundayNoonUtc, 'Pacific/Kiritimati')).toBe('2026-11-16');
	});

	it('falls back to UTC for an invalid zone', () => {
		expect(dayInZone(sundayNoonUtc, 'Not/AZone')).toBe('2026-11-15');
		expect(weekdayInZone(sundayNoonUtc, 'Not/AZone')).toBe('Sun');
	});

	it('picks Sunday as the weekly send day', () => {
		expect(isWeeklyProbeDay(sundayNoonUtc, 'UTC')).toBe(true);
		expect(isWeeklyProbeDay(new Date('2026-11-16T12:00:00Z'), 'UTC')).toBe(false);
		// Sunday 23:00 UTC is already Monday in Taipei.
		expect(isWeeklyProbeDay(new Date('2026-11-15T23:00:00Z'), 'Asia/Taipei')).toBe(false);
	});
});
