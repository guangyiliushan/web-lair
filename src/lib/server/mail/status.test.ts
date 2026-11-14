import { describe, expect, it } from 'vitest';
import { maskEmailAddress, readMailStatus } from './status';
import { buildTestMailContent, evaluateMailTestRateLimit } from './test';

function envOf(values: Record<string, string | undefined>) {
	return (name: string) => values[name];
}

describe('readMailStatus (W9.1)', () => {
	it('reports unconfigured with no env at all', () => {
		const status = readMailStatus(envOf({}));
		expect(status).toEqual({
			enabled: false,
			configured: false,
			host: null,
			port: null,
			from: null,
			tls: null,
			dkim: { configured: false, domain: null, selector: null }
		});
	});

	it('needs the literal switch, host and sender (same gate as the transport)', () => {
		const base = { MAIL_ENABLED: 'true', MAIL_SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'n@e.c' };
		expect(readMailStatus(envOf(base)).configured).toBe(true);
		expect(readMailStatus(envOf({ ...base, MAIL_ENABLED: 'TRUE' })).configured).toBe(false);
		expect(readMailStatus(envOf({ ...base, MAIL_SMTP_HOST: '  ' })).configured).toBe(false);
		expect(readMailStatus(envOf({ ...base, MAIL_FROM: undefined })).configured).toBe(false);
	});

	it('derives the TLS mode from the same rules as the transport', () => {
		const base = { MAIL_ENABLED: 'true', MAIL_SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'n@e.c' };
		expect(readMailStatus(envOf({ ...base, MAIL_SMTP_PORT: '465' })).tls).toBe('implicit');
		expect(readMailStatus(envOf({ ...base, MAIL_SMTP_PORT: '587' })).tls).toBe('starttls');
		expect(readMailStatus(envOf({ ...base, MAIL_SMTP_HOST: 'localhost' })).tls).toBe(
			'opportunistic'
		);
		expect(
			readMailStatus(envOf({ ...base, MAIL_SMTP_PORT: '2525', MAIL_SMTP_REQUIRE_TLS: 'false' })).tls
		).toBe('opportunistic');
		expect(readMailStatus(envOf({ ...base, MAIL_SMTP_PORT: 'nope' })).port).toBeNull();
	});

	it('reports DKIM only when domain, selector and key are all present', () => {
		const base = { MAIL_ENABLED: 'true', MAIL_SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'n@e.c' };
		const partial = readMailStatus(
			envOf({ ...base, MAIL_DKIM_DOMAIN: 'mail.example.com', MAIL_DKIM_SELECTOR: 's1' })
		);
		expect(partial.dkim).toEqual({ configured: false, domain: null, selector: null });
		const full = readMailStatus(
			envOf({
				...base,
				MAIL_DKIM_DOMAIN: 'mail.example.com',
				MAIL_DKIM_SELECTOR: 's1',
				MAIL_DKIM_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----'
			})
		);
		expect(full.dkim).toEqual({
			configured: true,
			domain: 'mail.example.com',
			selector: 's1'
		});
	});

	it('never reads the SMTP credentials', () => {
		const seen: string[] = [];
		readMailStatus((name) => {
			seen.push(name);
			return undefined;
		});
		expect(seen.some((name) => name === 'MAIL_SMTP_USER' || name === 'MAIL_SMTP_PASS')).toBe(false);
	});
});

describe('mail test throttle (W9.1)', () => {
	const now = new Date('2026-11-14T12:00:00Z');

	it('allows the first attempt', () => {
		expect(evaluateMailTestRateLimit([], now)).toEqual({ allowed: true });
	});

	it('refuses a second attempt inside the minute window', () => {
		const verdict = evaluateMailTestRateLimit([new Date(now.getTime() - 15_000)], now);
		expect(verdict).toMatchObject({ allowed: false, reason: 'too_soon' });
		if (!verdict.allowed) expect(verdict.retryAfterMs).toBe(45_000);
	});

	it('allows a new attempt after the minute window', () => {
		expect(evaluateMailTestRateLimit([new Date(now.getTime() - 61_000)], now)).toEqual({
			allowed: true
		});
	});

	it('caps the rolling hour', () => {
		const attempts = Array.from(
			{ length: 10 },
			(_, index) => new Date(now.getTime() - (index + 2) * 60_000)
		);
		const verdict = evaluateMailTestRateLimit(attempts, now);
		expect(verdict).toMatchObject({ allowed: false, reason: 'hourly' });
		if (!verdict.allowed) expect(verdict.retryAfterMs).toBeGreaterThan(0);
	});

	it('ignores attempts older than the hour', () => {
		const attempts = Array.from(
			{ length: 10 },
			(_, index) => new Date(now.getTime() - (61 + index) * 60_000)
		);
		expect(evaluateMailTestRateLimit(attempts, now)).toEqual({ allowed: true });
	});
});

describe('test mail content', () => {
	it('names the site and carries a timestamp but no configuration', () => {
		const content = buildTestMailContent(new Date('2026-11-14T12:00:00Z'), 'Lair');
		expect(content.subject).toBe('[Lair] SMTP test email');
		expect(content.text).toContain('2026-11-14T12:00:00.000Z');
		expect(content.text).not.toMatch(/MAIL_SMTP|password|whsec_/i);
	});

	it('masks an audit address down to one local character', () => {
		expect(maskEmailAddress('guang@example.com')).toBe('g***@example.com');
		expect(maskEmailAddress('not-an-email')).toBe('[redacted]');
	});
});
