// `mail.probe` job core: two checks with different questions — a daily
// `transporter().verify()` (does the SMTP handshake + AUTH still work with
// the configured credentials? A dead relay is otherwise silent until someone
// registers) and, on site-local Sundays, one REAL mail to the owner with a
// unique subject and the `messageId` recorded in the run ledger, because
// verify() cannot see a spam-foldered, DKIM-broken or From-mismatched
// message.
// Failure routing: `notify()` (the outbox) plus a healthchecks `/fail` ping.
// The job does not throw — the run ledger records the outcome and the
// `job.failed` producer is out of scope here, so alerting is explicit
// instead of inferred from a red status.
import { eq } from 'drizzle-orm';
import { user } from '../db/auth.schema.ts';
import { getOption } from '../config/options-registry.ts';
import { sanitizeErrorText } from '../jobs/error-text.ts';
import type { JobContext } from '../jobs/types.ts';
import { notify as defaultNotify } from '../notifications/notify.ts';
import { pingHealthcheck as defaultPing } from '../monitoring/healthchecks.ts';
import {
	dayInZone,
	isWeeklyProbeDay,
	sendProbeMail,
	verifyMailbox,
	type MailVerifyResult
} from './probe.ts';
import {
	devLogAllowedFrom,
	isMailConfiguredFrom,
	redactMailError,
	type MailEnvReader
} from './smtp.ts';

export interface MailProbeDelivery {
	ok: boolean;
	/** Unique subject (`web-lair mail probe YYYY-MM-DD`). */
	subject: string;
	/** nodemailer's message id when the MTA accepted the message. */
	messageId: string | null;
	/** Sanitized failure text. */
	error?: string;
}

export interface MailProbeDeps {
	getEnv?: MailEnvReader;
	now?: () => Date;
	verify?: typeof verifyMailbox;
	send?: typeof sendProbeMail;
	notify?: typeof defaultNotify;
	ping?: typeof defaultPing;
	/** Site zone for the Sunday decision; defaults to `options.site.timezone`. */
	timezone?: (ctx: JobContext) => Promise<string>;
}

function defaultGetEnv(): MailEnvReader {
	return (name) => process.env[name];
}

/** Settings read failure must not turn the probe into a false red. */
async function siteTimezone(ctx: JobContext): Promise<string> {
	try {
		const value = await getOption('site.timezone', ctx.db);
		return typeof value === 'string' && value ? value : 'UTC';
	} catch {
		return 'UTC';
	}
}

async function ownerEmail(ctx: JobContext): Promise<string | null> {
	const rows = await ctx.db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.role, 'owner'))
		.limit(1);
	const email = rows[0]?.email?.trim();
	return email ? email : null;
}

export async function runMailProbe(ctx: JobContext, deps: MailProbeDeps = {}): Promise<void> {
	const getEnv = deps.getEnv ?? defaultGetEnv();
	const now = (deps.now ?? (() => new Date()))();
	const verify = deps.verify ?? verifyMailbox;
	const send = deps.send ?? sendProbeMail;
	const notify = deps.notify ?? defaultNotify;
	const ping = deps.ping ?? defaultPing;

	const configured = isMailConfiguredFrom(getEnv);
	const devLog = devLogAllowedFrom(getEnv, false);
	const production = getEnv('NODE_ENV') === 'production';

	// No SMTP at all: a local dev box is expected to skip; a production box is
	// broken (registration and password reset are dead) and must alert.
	if (!configured) {
		const failed = production && !devLog;
		const healthcheckStatus = failed ? 'fail' : 'ok';
		const healthcheckPing = await ping('mail', healthcheckStatus);
		if (failed) {
			ctx.logger.error('[mail.probe] mail is not configured in production');
			await notify({
				eventType: 'mail.probe.failed',
				eventKey: `mail:configured:${now.toISOString().slice(0, 10)}`,
				title: 'Mail is not configured',
				body: 'MAIL_ENABLED/MAIL_SMTP_HOST/MAIL_FROM are missing in production.'
			});
		}
		ctx.summary({
			configured: false,
			skipped: devLog ? 'dev-log' : 'not-configured',
			production,
			healthcheck: { status: healthcheckStatus, ping: healthcheckPing }
		});
		return;
	}

	const verification: MailVerifyResult = await verify(getEnv, { now: now.getTime() });
	const timezone = deps.timezone
		? await deps.timezone(ctx).catch(() => 'UTC')
		: await siteTimezone(ctx);
	const weekly = isWeeklyProbeDay(now, timezone);
	let delivery: MailProbeDelivery | null = null;

	if (weekly && verification.ok) {
		const subject = `web-lair mail probe ${dayInZone(now, timezone)}`;
		let to: string | null = null;
		try {
			to = await ownerEmail(ctx);
		} catch (error) {
			// A DB blip must not skip the healthchecks ping below: record the
			// failure and fall through to the alert/ping block.
			const text = sanitizeErrorText(error instanceof Error ? error.message : String(error));
			delivery = {
				ok: false,
				subject,
				messageId: null,
				error: `owner-lookup-failed: ${text}`
			};
			ctx.logger.error(`[mail.probe] owner lookup failed: ${text}`);
		}
		if (!delivery) {
			if (!to) {
				delivery = { ok: false, subject, messageId: null, error: 'owner-missing' };
				ctx.logger.error('[mail.probe] weekly send skipped: no owner account');
			} else {
				try {
					const result = await send(getEnv, {
						to,
						subject,
						text:
							`web-lair mail probe ${dayInZone(now, timezone)}\n\n` +
							'Automated weekly delivery check. If this message reaches the inbox (not the ' +
							'spam folder), the mail path admits real mail end to end.\n'
					});
					delivery = { ok: true, subject, messageId: result.messageId };
					ctx.logger.info(`[mail.probe] weekly send ok message-id=${result.messageId ?? 'n/a'}`);
				} catch (error) {
					// Relay replies echo the recipient and the banner: redact before
					// the text reaches the run ledger / drain log.
					const text = sanitizeErrorText(redactMailError(error));
					delivery = { ok: false, subject, messageId: null, error: text };
					ctx.logger.error(`[mail.probe] weekly send failed: ${text}`);
				}
			}
		}
	}

	const failing = !verification.ok || (delivery !== null && !delivery.ok);
	const healthcheckStatus = failing ? 'fail' : 'ok';
	// External record before the in-app seam: a hung outbox sink must not
	// delay the /fail past the job timeout (the drain hard-exits on timeout).
	const healthcheckPing = await ping('mail', healthcheckStatus);
	if (failing)
		ctx.logger.warn(`[mail.probe] healthcheck ${healthcheckStatus} (ping ${healthcheckPing})`);

	if (!verification.ok) {
		const reason = verification.reason ?? 'verify failed';
		ctx.logger.error(`[mail.probe] SMTP verify failed: ${reason}`);
		await notify({
			eventType: 'mail.probe.failed',
			eventKey: `mail:verify:${dayInZone(now, timezone)}`,
			title: 'SMTP verification failed',
			body: `transporter().verify() failed: ${reason}`
		});
	}
	if (delivery && !delivery.ok) {
		await notify({
			eventType: 'mail.probe.failed',
			eventKey: `mail:send:${dayInZone(now, timezone)}`,
			title: 'Weekly probe mail failed',
			body: `A real send to the owner failed: ${delivery.error ?? 'unknown error'}`
		});
	}

	ctx.summary({
		configured: true,
		verify: {
			ok: verification.ok,
			cached: verification.cached,
			reason: verification.reason ?? null
		},
		weekly,
		timezone,
		delivery,
		// `status` is the probe's verdict; `ping` is whether healthchecks accepted
		// the report (a delivered /fail is not a healthy mailbox).
		healthcheck: { status: healthcheckStatus, ping: healthcheckPing }
	});
}
