import { describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../jobs/types.ts';
import type { NotificationEvent } from '../notifications/notify.ts';
import type { MailVerifyResult } from './probe.ts';
import { runMailProbe, type MailProbeDeps } from './probe-job';

interface Harness {
	ctx: JobContext;
	summaries: Array<Record<string, unknown>>;
	logs: { info: string[]; warn: string[]; error: string[] };
}

function makeDb(
	owners: Array<{ email: string | null }>,
	options: { ownerLookupFails?: boolean } = {}
): JobContext['db'] {
	const chain: Record<string, unknown> = {};
	chain.select = () => chain;
	chain.from = () => chain;
	chain.where = () => chain;
	chain.limit = async () => {
		if (options.ownerLookupFails) {
			// Built from parts so the credential is a real string in the fixture
			// (a literal DSN would be masked by tooling and the redaction
			// assertion would be vacuous).
			const dsn = ['postgres://app', ':hunter2@db:5432/app'].join('');
			throw new Error(`ECONNREFUSED ${dsn}`);
		}
		return owners;
	};
	return chain as unknown as JobContext['db'];
}

function harness(
	owners: Array<{ email: string | null }> = [],
	options: { ownerLookupFails?: boolean } = {}
): Harness {
	const summaries: Array<Record<string, unknown>> = [];
	const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
	const ctx = {
		job: 'mail.probe',
		trigger: 'schedule',
		db: makeDb(owners, options),
		logger: {
			info: (line: string) => logs.info.push(line),
			warn: (line: string) => logs.warn.push(line),
			error: (line: string) => logs.error.push(line)
		},
		summary: (data: Record<string, unknown>) => summaries.push(data)
	} as unknown as JobContext;
	return { ctx, summaries, logs };
}

const CONFIGURED = {
	MAIL_ENABLED: 'true',
	MAIL_SMTP_HOST: 'smtp.example.com',
	MAIL_FROM: 'noreply@mail.example.com'
};

const SUNDAY = new Date('2026-11-15T12:00:00Z');
const MONDAY = new Date('2026-11-16T12:00:00Z');

function deps(overrides: Partial<MailProbeDeps> = {}): MailProbeDeps {
	return {
		getEnv: (name) => CONFIGURED[name as keyof typeof CONFIGURED],
		now: () => SUNDAY,
		verify: vi.fn(async (): Promise<MailVerifyResult> => ({ ok: true, cached: false })),
		send: vi.fn(async () => ({ messageId: '<probe-1@mail.example.com>' })),
		notify: vi.fn(async () => 'delivered' as const),
		ping: vi.fn(async (_probe: string, status: 'ok' | 'fail') =>
			status === 'fail' ? ('fail' as const) : ('ok' as const)
		),
		timezone: async () => 'UTC',
		...overrides
	};
}

describe('mail.probe job (M6 P4)', () => {
	it('skips quietly on a dev box without SMTP', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({ getEnv: () => undefined });
		await runMailProbe(ctx, injected);

		expect(injected.notify).not.toHaveBeenCalled();
		expect(injected.verify).not.toHaveBeenCalled();
		expect(injected.ping).toHaveBeenCalledWith('mail', 'ok');
		expect(summaries[0]).toMatchObject({
			configured: false,
			skipped: 'not-configured',
			production: false,
			healthcheck: { status: 'ok', ping: 'ok' }
		});
	});

	it('treats missing SMTP in production as an alarm', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({
			getEnv: (name) => (name === 'NODE_ENV' ? 'production' : undefined)
		});
		await runMailProbe(ctx, injected);

		expect(injected.ping).toHaveBeenCalledWith('mail', 'fail');
		const event = (injected.notify as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as NotificationEvent;
		expect(event.eventType).toBe('mail.probe.failed');
		expect(event.eventKey).toBe('mail:configured:2026-11-15');
		expect(summaries[0]).toMatchObject({
			configured: false,
			production: true,
			healthcheck: { status: 'fail', ping: 'fail' }
		});
	});

	it('alerts when the SMTP handshake fails and pings fail', async () => {
		const { ctx, summaries, logs } = harness();
		const injected = deps({
			verify: vi.fn(async (): Promise<MailVerifyResult> => ({
				ok: false,
				cached: false,
				reason: 'ECONNREFUSED'
			}))
		});
		await runMailProbe(ctx, injected);

		expect(injected.ping).toHaveBeenCalledWith('mail', 'fail');
		const event = (injected.notify as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as NotificationEvent;
		expect(event.eventType).toBe('mail.probe.failed');
		expect(event.eventKey).toBe('mail:verify:2026-11-15');
		expect(event.body).toContain('ECONNREFUSED');
		expect(summaries[0]!.verify).toMatchObject({ ok: false, reason: 'ECONNREFUSED' });
		expect(logs.error.join('\n')).toContain('SMTP verify failed');
	});

	it('sends one real mail to the owner on the site-local Sunday', async () => {
		const { ctx, summaries } = harness([{ email: 'owner@example.com' }]);
		const injected = deps();
		await runMailProbe(ctx, injected);

		expect(injected.send).toHaveBeenCalledTimes(1);
		const mail = (injected.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
			to: string;
			subject: string;
		};
		expect(mail.to).toBe('owner@example.com');
		expect(mail.subject).toBe('web-lair mail probe 2026-11-15');
		expect(summaries[0]!.delivery).toMatchObject({
			ok: true,
			messageId: '<probe-1@mail.example.com>',
			subject: 'web-lair mail probe 2026-11-15'
		});
		expect(injected.ping).toHaveBeenCalledWith('mail', 'ok');
		// The owner address is PII: it must never reach the run ledger.
		expect(JSON.stringify(summaries[0])).not.toContain('owner@example.com');
	});

	it('does not send on a weekday', async () => {
		const { ctx, summaries } = harness([{ email: 'owner@example.com' }]);
		const injected = deps({ now: () => MONDAY });
		await runMailProbe(ctx, injected);

		expect(injected.send).not.toHaveBeenCalled();
		expect(summaries[0]).toMatchObject({
			weekly: false,
			delivery: null,
			healthcheck: { status: 'ok', ping: 'ok' }
		});
	});

	it('alerts on a cached verification failure too (manual run inside the window)', async () => {
		const { ctx, summaries } = harness([{ email: 'owner@example.com' }]);
		const injected = deps({
			verify: vi.fn(async (): Promise<MailVerifyResult> => ({
				ok: false,
				cached: true,
				reason: 'auth failed'
			}))
		});
		await runMailProbe(ctx, injected);

		expect(injected.notify).toHaveBeenCalledTimes(1);
		expect(injected.ping).toHaveBeenCalledWith('mail', 'fail');
		expect(summaries[0]!.verify).toMatchObject({ ok: false, cached: true });
	});

	it('does not alarm in the dev-log preview (production + both switches)', async () => {
		const { ctx, summaries } = harness();
		const injected = deps({
			getEnv: (name) =>
				({
					NODE_ENV: 'production',
					MAIL_DEV_LOG: 'true',
					MAIL_DEV_LOG_OK: 'true'
				})[name]
		});
		await runMailProbe(ctx, injected);

		expect(injected.notify).not.toHaveBeenCalled();
		expect(injected.ping).toHaveBeenCalledWith('mail', 'ok');
		expect(summaries[0]).toMatchObject({
			configured: false,
			skipped: 'dev-log',
			production: true,
			healthcheck: { status: 'ok', ping: 'ok' }
		});
	});

	it('falls back to UTC when the site timezone read fails', async () => {
		const { ctx, summaries } = harness([{ email: 'owner@example.com' }]);
		// No injected timezone: the getOption path runs against the fake chain
		// (owner rows for every table), which fails validation -> UTC.
		const injected = deps({ timezone: undefined });
		await runMailProbe(ctx, injected);

		expect(summaries[0]!.timezone).toBe('UTC');
		expect(injected.send).toHaveBeenCalledTimes(1);
	});

	it('alerts when the weekly send fails, with a sanitized reason', async () => {
		const { ctx, summaries } = harness([{ email: 'owner@example.com' }]);
		const injected = deps({
			send: vi.fn(async () => {
				throw new Error(
					'550 5.1.1 <owner@example.com> rejected https://smtp.example.com/path?token=SECRET'
				);
			})
		});
		await runMailProbe(ctx, injected);

		expect(injected.ping).toHaveBeenCalledWith('mail', 'fail');
		const event = (injected.notify as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as NotificationEvent;
		expect(event.eventType).toBe('mail.probe.failed');
		expect(event.eventKey).toBe('mail:send:2026-11-15');
		expect(event.body).not.toContain('SECRET');
		// The relay reply echoes the recipient: the ledger must not keep it.
		expect(event.body).not.toContain('owner@example.com');
		const delivery = summaries[0]!.delivery as { ok: boolean; error: string };
		expect(delivery.ok).toBe(false);
		expect(delivery.error).not.toContain('SECRET');
		expect(delivery.error).not.toContain('owner@example.com');
		expect(delivery.error).toContain('[redacted]');
	});

	it('alerts when no owner account exists', async () => {
		const { ctx, summaries } = harness([]);
		const injected = deps();
		await runMailProbe(ctx, injected);

		expect(injected.send).not.toHaveBeenCalled();
		expect(injected.ping).toHaveBeenCalledWith('mail', 'fail');
		const event = (injected.notify as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as NotificationEvent;
		expect(event.eventType).toBe('mail.probe.failed');
		expect(event.eventKey).toBe('mail:send:2026-11-15');
		expect(summaries[0]!.delivery).toMatchObject({ ok: false, error: 'owner-missing' });
	});

	it('still pings and alerts when the owner lookup throws', async () => {
		const { ctx, summaries } = harness([], { ownerLookupFails: true });
		const injected = deps();
		await runMailProbe(ctx, injected);

		expect(injected.send).not.toHaveBeenCalled();
		expect(injected.ping).toHaveBeenCalledWith('mail', 'fail');
		const event = (injected.notify as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as NotificationEvent;
		expect(event.eventKey).toBe('mail:send:2026-11-15');
		const delivery = summaries[0]!.delivery as { ok: boolean; error: string };
		expect(delivery.ok).toBe(false);
		expect(delivery.error).toContain('owner-lookup-failed');
		// The DB error carries a real DSN credential here: no password and no
		// user:pass segment may survive into the backed-up run ledger.
		expect(delivery.error).not.toContain('hunter2');
		expect(delivery.error).not.toContain('postgres://app:');
	});

	it('skips the real send when the handshake already failed', async () => {
		const { ctx } = harness([{ email: 'owner@example.com' }]);
		const injected = deps({
			verify: vi.fn(async (): Promise<MailVerifyResult> => ({
				ok: false,
				cached: false,
				reason: 'auth failed'
			}))
		});
		await runMailProbe(ctx, injected);
		expect(injected.send).not.toHaveBeenCalled();
	});
});
