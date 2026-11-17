import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { activities, webhookDeliveries, webhookSecrets, webhooks } from '$lib/server/db/system';
import { notificationDeliveries } from '$lib/server/db/system/notification-delivery.schema';
import { readBarkConfig } from '$lib/server/notifications/adapters/bark';
import { requireAdminRole } from '$lib/server/authz';
import { assertSettingWrite, settingAccess } from '$lib/server/settings/tiers';
import { recordActivity } from '$lib/server/audit';
import { isMailConfigured, sendMail } from '$lib/server/mail/transport';
import { readMailStatus, maskEmailAddress, redactMailError } from '$lib/server/mail/status';
import { buildTestMailContent, evaluateMailTestRateLimit } from '$lib/server/mail/test';

import { SecretError } from '$lib/server/secrets/errors';
import { decryptSecret, secretAad } from '$lib/server/secrets/crypto';
import { loadKeyring, type SecretDb } from '$lib/server/secrets/resolver';
import {
	encryptPreviousWebhookSecret,
	encryptWebhookSecretValue,
	readWebhookSecretStatuses,
	WEBHOOK_SECRET_GRACE_MS
} from '$lib/server/secrets/webhook-secrets';
import { getOption, setOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDateTime } from '$lib/utils/i18n';
import { WEBHOOK_EVENT_ROSTER, isWebhookEventName } from '$lib/server/webhooks/events';
import { generateWebhookSecret, maskWebhookSecret } from '$lib/server/webhooks/secret';
import {
	WebhookUrlError,
	validateWebhookUrl,
	webhookAllowPrivateTargets
} from '$lib/server/webhooks/url-guard';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Notification settings: mail status/test plus webhook endpoints.
 * Mail: read-only SMTP status plus a real test send to the signed-in admin; SMTP
 * credentials never reach this module.
 * Retry/replay re-queues the SAME delivery row, so the `webhook-id` header is unchanged and
 * receivers deduplicate manual replays against the automatic retries (which live in the
 * drain).
 * Endpoint CRUD: secrets are server-generated only (`whsec_` + base64, the Standard
 * Webhooks shape), the load renders a MASKED preview and the raw value is revealed exactly
 * once in the create/rotate result; names are soft-rejected case-insensitively (no DB
 * constraint).
 * URLs: HTTPS only, credentials refused, private/loopback/link-local/metadata targets
 * refused (literal or resolved; LAN needs `WEBHOOK_ALLOW_PRIVATE_TARGETS`); stored values
 * are the WHATWG-normalized `href`, and 23514 still maps to 400 as defense in depth.
 * Config audit: create/update/delete/toggle/key_set/key_rotate write local `activities`
 * rows (`deliver:false`) that carry the host, never the path query or the secret.
 * Known hazard: an admin delete racing an in-flight 410 delivery can deadlock (40P01, ABBA
 * on the webhook/delivery row locks) — rare and non-corrupting (one tx aborts, the drain
 * rolls the delivery back to queued); the delete surfaces it as an unhandled 500, accepted.
 */

const NAME_MAX_LENGTH = 120;
const PAYLOAD_URL_MAX_LENGTH = 2048;

type ParsedEndpointForm =
	{ ok: true; name: string; payloadUrl: string; events: string[] } | { ok: false; message: string };

/** Map a URL-guard rejection to its localized message. */
function webhookUrlErrorMessage(error: unknown): string {
	if (!(error instanceof WebhookUrlError)) return m.admin_settings_notification_err_url();
	switch (error.reason) {
		case 'insecure_scheme':
			return m.admin_settings_notification_err_url_https();
		case 'blocked_host':
			return m.admin_settings_notification_err_url_private();
		case 'unresolvable':
			return m.admin_settings_notification_err_url_unresolvable();
		default:
			return m.admin_settings_notification_err_url();
	}
}

/** Validate the endpoint form before any DB access. */
async function parseEndpointForm(
	form: FormData,
	options: { allowPrivate: boolean }
): Promise<ParsedEndpointForm> {
	const name = (form.get('name') ?? '').toString().trim();
	if (!name || name.length > NAME_MAX_LENGTH) {
		return { ok: false, message: m.admin_settings_notification_err_name() };
	}
	const payloadUrl = (form.get('payloadUrl') ?? '').toString().trim();
	if (!payloadUrl || payloadUrl.length > PAYLOAD_URL_MAX_LENGTH) {
		return { ok: false, message: m.admin_settings_notification_err_url() };
	}
	// HTTPS only, no embedded credentials, no private/loopback/
	// link-local/metadata targets (literal or resolved). The guard returns
	// the WHATWG-normalized href, which the DB CHECK requires.
	let normalizedUrl: string;
	try {
		normalizedUrl = await validateWebhookUrl(payloadUrl, { allowPrivate: options.allowPrivate });
	} catch (error) {
		return { ok: false, message: webhookUrlErrorMessage(error) };
	}
	const events = [...new Set(form.getAll('events').map((value) => value.toString()))];
	if (events.length === 0) {
		// An empty subscription matches nothing (`events @> array[event]`) and
		// would deliver forever-nothing - a silent black hole (nine-dimension
		// DB-01 / NOTIF-SY-11). This deliberately reverses the S2 "empty
		// mirrors the schema" intent; a cardinality CHECK is registered for
		// the next schema window.
		return { ok: false, message: m.admin_settings_notification_err_events_empty() };
	}
	if (!events.every(isWebhookEventName)) {
		return { ok: false, message: m.admin_settings_notification_err_events() };
	}
	// Store the normalized form, not the raw string: the column CHECK
	// (`^https?://`) must hold for everything this validator accepts.
	return { ok: true, name, payloadUrl: normalizedUrl, events };
}

/** Host label for the config audit payload (paths may carry receiver tokens). */
function webhookHostOf(payloadUrl: string): string {
	try {
		return new URL(payloadUrl).host;
	} catch {
		return 'invalid';
	}
}

/** Case-insensitive name soft-reject (G3); `exceptId` excludes self on edit. */
async function endpointNameTaken(name: string, exceptId?: string): Promise<boolean> {
	const [row] = await db
		.select({ id: webhooks.id })
		.from(webhooks)
		.where(
			exceptId
				? sql`lower(${webhooks.name}) = lower(${name}) and ${webhooks.id} <> ${exceptId}`
				: sql`lower(${webhooks.name}) = lower(${name})`
		)
		.limit(1);
	return row !== undefined;
}

/** Shared id guard: format first, then normalize to one case (uuid compares). */
function endpointId(form: FormData): string | null {
	const id = (form.get('id') ?? '').toString();
	if (!id || !isUuid(id)) return null;
	return id.toLowerCase();
}

/** The keyring, or null when it is not usable (the action answers 503). */
function webhookKeyring(): ReturnType<typeof loadKeyring> | null {
	try {
		return loadKeyring({ getEnv: (name) => env[name] });
	} catch (error) {
		if (error instanceof SecretError) {
			console.warn('[webhooks] secret write refused:', error.code);
			return null;
		}
		throw error;
	}
}

export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const siteTz = await getOption('site.timezone');
	const [webhookRows, deliveryRows, secretStatuses] = await Promise.all([
		db
			.select({
				id: webhooks.id,
				name: webhooks.name,
				payloadUrl: webhooks.payloadUrl,
				events: webhooks.events,
				isEnabled: webhooks.isEnabled,
				secret: webhooks.secret
			})
			.from(webhooks)
			.orderBy(asc(webhooks.createdAt)),
		db
			.select({
				id: webhookDeliveries.id,
				webhookId: webhookDeliveries.webhookId,
				createdAt: webhookDeliveries.createdAt,
				event: webhookDeliveries.event,
				status: webhookDeliveries.status,
				attemptCount: webhookDeliveries.attemptCount,
				nextAttemptAt: webhookDeliveries.nextAttemptAt,
				responseCode: webhookDeliveries.responseCode,
				error: webhookDeliveries.error,
				deliveredAt: webhookDeliveries.deliveredAt
			})
			.from(webhookDeliveries)
			.orderBy(desc(webhookDeliveries.createdAt))
			.limit(50),
		readWebhookSecretStatuses(
			db as unknown as SecretDb,
			(await db.select({ id: webhooks.id }).from(webhooks)).map((row) => row.id)
		)
	]);
	// The raw secret never leaves the server: page data carries a mask only.
	// The encrypted row's hint wins; the legacy plaintext column is the bridge
	// until `scripts/migrate-webhook-secrets.ts --apply` has run.
	const webhookEndpoints = webhookRows.map(({ secret, ...endpoint }) => {
		const status = secretStatuses.get(endpoint.id);
		return {
			...endpoint,
			secretPreview: status?.hint ?? (secret ? maskWebhookSecret(secret) : null),
			secretSource: status ? ('db' as const) : secret ? ('legacy' as const) : null,
			secretUpdatedAt: status?.updatedAt ?? null,
			previousExpiresAt: status?.previousExpiresAt ?? null
		};
	});
	const byId = new Map(webhookEndpoints.map((row) => [row.id, row]));
	// Preferences, delivery log and the Bark channel status. The device
	// key never leaves the server - `readBarkConfig` returns the origin only.
	const notificationPreferences = await getOption('notifications.preferences', db);
	const bark = readBarkConfig((name) => env[name]);
	// Delivery log DTO: only the columns the page renders. `payload` never leaves
	// the server - it carries the notification body (a comment excerpt is reader
	// content, not log material), which is why the log shows the title alone - a
	// `...row` spread once shipped the whole payload to `__data.json` while the copy
	// promised "bodies are never logged".
	const notificationRows = await db
		.select({
			id: notificationDeliveries.id,
			eventType: notificationDeliveries.eventType,
			channel: notificationDeliveries.channel,
			status: notificationDeliveries.status,
			attempts: notificationDeliveries.attempts,
			error: notificationDeliveries.error,
			createdAt: notificationDeliveries.createdAt,
			title: sql<string>`coalesce(${notificationDeliveries.payload}->>'title', '')`
		})
		.from(notificationDeliveries)
		.orderBy(desc(notificationDeliveries.createdAt))
		.limit(50);
	return {
		webhookEndpoints,
		webhookEventRoster: [...WEBHOOK_EVENT_ROSTER],
		// N3: config is owner-only; admins get a read-only list + manual replay.
		// The section tier ('notifications' = admin) is NOT the field tier.
		editable: settingAccess(event.locals.admin?.role, 'notifications', 'notifications.webhooks')
			.editable,
		mailEditable: settingAccess(event.locals.admin?.role, 'notifications', 'notifications.mail')
			.editable,
		mail: readMailStatus((name) => env[name]),
		// Preferences and the alert log are owner-only; Bark credentials stay
		// env-only for now.
		notificationPreferences,
		notificationPreferencesEditable: settingAccess(
			event.locals.admin?.role,
			'notifications',
			'notifications.preferences'
		).editable,
		notificationLogEditable: settingAccess(
			event.locals.admin?.role,
			'notifications',
			'notifications.deliveries'
		).editable,
		bark: { configured: bark.configured, serverUrl: bark.serverUrl, reason: bark.reason },
		notifications: notificationRows.map((row) => ({
			id: row.id,
			eventType: row.eventType,
			channel: row.channel,
			status: row.status,
			attempts: row.attempts,
			error: row.error,
			title: row.title,
			createdLabel: formatDateTime(row.createdAt, { timeZone: siteTz })
		})),
		webhookDeliveries: deliveryRows.map((row) => {
			// The FK cascade removes a deleted endpoint's deliveries, so this
			// lookup is total by construction (nine-dimension DB-04: the dead
			// "endpoint deleted" fallback and its message key are retired).
			const endpoint = byId.get(row.webhookId);
			return {
				...row,
				webhookName: endpoint?.name ?? '',
				createdLabel: formatDateTime(row.createdAt, { timeZone: siteTz }),
				nextAttemptLabel: row.nextAttemptAt
					? formatDateTime(row.nextAttemptAt, { timeZone: siteTz })
					: null
			};
		})
	};
};

export const actions: Actions = {
	/**
	 * Real SMTP test. The recipient is the signed-in
	 * admin's own address - never a form field, so the page cannot be used to
	 * send mail to third parties. SMTP stays env-only; there is no editable
	 * host/user/password here.
	 *
	 * Throttling reads the `mail.test` audit rows themselves (one source of
	 * truth across replicas). A failed send is audited too and counts toward
	 * the limit: a broken SMTP relay must not be hammered by retry clicks.
	 */
	testMail: async ({ locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.mail');
		const to = locals.user?.email?.trim();
		if (!to) {
			return fail(400, {
				op: 'testMail',
				message: m.admin_settings_notification_test_no_address()
			});
		}
		if (!isMailConfigured()) {
			return fail(400, {
				op: 'testMail',
				message: m.admin_settings_notification_test_unconfigured()
			});
		}
		const now = new Date();
		const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
		const recent = await db
			.select({ createdAt: activities.createdAt })
			.from(activities)
			.where(
				and(
					eq(activities.event, 'mail.test'),
					eq(activities.actorId, locals.user?.id ?? ''),
					gte(activities.createdAt, hourAgo)
				)
			)
			.orderBy(desc(activities.createdAt))
			.limit(10);
		const verdict = evaluateMailTestRateLimit(
			recent.map((row) => row.createdAt),
			now
		);
		if (!verdict.allowed) {
			return fail(429, {
				op: 'testMail',
				message: m.admin_settings_notification_test_rate_limited({
					seconds: Math.ceil(verdict.retryAfterMs / 1000)
				})
			});
		}
		const content = buildTestMailContent(now);
		try {
			await sendMail({ to, subject: content.subject, text: content.text });
		} catch (error) {
			// SMTP errors echo the recipient/banners; never let them defeat the mask.
			const reason = redactMailError(error);
			await recordActivity(db, {
				event: 'mail.test',
				actorId: locals.user?.id ?? null,
				payload: { to: maskEmailAddress(to), ok: false, error: reason },
				deliver: false
			});
			return fail(502, {
				op: 'testMail',
				message: m.admin_settings_notification_test_failed({ reason })
			});
		}
		await recordActivity(db, {
			event: 'mail.test',
			actorId: locals.user?.id ?? null,
			payload: { to: maskEmailAddress(to), ok: true },
			deliver: false
		});
		return {
			op: 'testMail',
			mailTested: true,
			message: m.admin_settings_notification_test_sent({ to })
		};
	},

	retry: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id))
			return fail(400, { message: m.admin_settings_notification_err_bad_id() });
		const [delivery] = await db
			.select({
				id: webhookDeliveries.id,
				webhookId: webhookDeliveries.webhookId,
				status: webhookDeliveries.status,
				attemptCount: webhookDeliveries.attemptCount
			})
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, id))
			.limit(1);
		if (!delivery) return fail(404, { message: m.admin_settings_notification_err_not_found() });
		// Assertion 87: failed rows can be re-queued - a queued/succeeded row has nothing to retry.
		if (delivery.status !== 'failed')
			return fail(400, { message: m.admin_settings_notification_err_not_failed() });
		const [endpoint] = await db
			.select({ isEnabled: webhooks.isEnabled })
			.from(webhooks)
			.where(eq(webhooks.id, delivery.webhookId))
			.limit(1);
		if (!endpoint) return fail(404, { message: m.admin_settings_notification_err_endpoint_gone() });
		if (!endpoint.isEnabled)
			return fail(400, { message: m.admin_settings_notification_err_disabled() });
		// Replay the SAME row. The delivery id is the `webhook-id`, so
		// receivers deduplicate a manual replay exactly like an automatic
		// retry; a copied row would mint a new id and look like a new event.
		// The status predicate makes the write idempotent under two admins
		// (a drain commit between the read and this write cannot be undone).
		const replayed = await db.transaction(async (tx) => {
			const [row] = await tx
				.update(webhookDeliveries)
				.set({
					status: 'queued',
					attemptCount: 0,
					nextAttemptAt: new Date(),
					responseCode: null,
					error: null,
					deliveredAt: null
				})
				.where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, 'failed')))
				.returning({ id: webhookDeliveries.id, webhookId: webhookDeliveries.webhookId });
			if (!row) return null;
			// Admins (not just owners) may replay, so the actor must be recorded
			// even though the replay writes no configuration.
			await recordActivity(tx, {
				event: 'webhook.replay',
				actorId: locals.user?.id ?? null,
				payload: {
					webhookId: row.webhookId,
					deliveryId: row.id,
					previousAttempts: delivery.attemptCount
				},
				deliver: false
			});
			return row;
		});
		if (!replayed) return fail(400, { message: m.admin_settings_notification_err_not_failed() });
		return { retried: true, id: replayed.id };
	},

	/**
	 * Per-group channel switches (owner-only). Form fields
	 * are checkboxes, so absence means "off" - the handler derives the object
	 * from the form instead of trusting a hidden JSON blob.
	 */
	saveNotificationPreferences: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.preferences');
		const form = await request.formData();
		const checked = (name: string) => form.get(name) === 'on';
		const value = {
			comment: { email: checked('comment_email'), bark: checked('comment_bark') },
			job: { email: checked('job_email'), bark: checked('job_bark') },
			ops: { email: checked('ops_email'), bark: checked('ops_bark') }
		};
		try {
			// Validation + persistence + audit commit together: a rejected write
			// leaves no audit row, and the audit event name must satisfy the
			// activities CHECK (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` - ONE dot).
			await db.transaction(async (tx) => {
				await setOption('notifications.preferences', value, tx);
				await recordActivity(tx, {
					event: 'notification.preferences',
					actorId: locals.user?.id ?? null,
					payload: value,
					deliver: false
				});
			});
		} catch (error) {
			// Only an invalid payload is a 400. A database/audit failure is an
			// infrastructure error: rethrowing lets SvelteKit answer 500 (and the
			// logs see the cause) instead of telling the operator "bad request".
			if (error instanceof ZodError) {
				return fail(400, {
					op: 'saveNotificationPreferences',
					message: m.admin_settings_notification_err_bad_request()
				});
			}
			throw error;
		}
		return {
			op: 'saveNotificationPreferences',
			saved: true,
			message: m.admin_settings_notification_prefs_saved()
		};
	},

	/**
	 * Manual resend re-queues the SAME row (never a copy), so the
	 * unique key `(event_type, event_key, channel)` still describes exactly
	 * one notification and the delivery log keeps one history. Only a row
	 * that already reached a terminal state can be requeued; the status
	 * predicate makes two simultaneous clicks idempotent.
	 */
	resendNotification: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.deliveries');
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) {
			return fail(400, {
				op: 'resendNotification',
				message: m.admin_settings_notification_err_bad_id()
			});
		}
		const requeued = await db.transaction(async (tx) => {
			const rows = await tx
				.update(notificationDeliveries)
				.set({
					status: 'queued',
					// A manual resend starts a fresh delivery campaign: the attempt
					// budget is reset so the operator gets the full 1m/5m/15m schedule
					// again (and a row that already spent its budget is not
					// immediately terminal). The history stays visible in `activities`
					// (`notification.resend`), not in this counter.
					attempts: 0,
					nextAttemptAt: new Date(),
					responseCode: null,
					error: null,
					sentAt: null
				})
				.where(
					and(
						eq(notificationDeliveries.id, id),
						inArray(notificationDeliveries.status, ['failed', 'sent'])
					)
				)
				.returning({
					id: notificationDeliveries.id,
					eventType: notificationDeliveries.eventType,
					eventKey: notificationDeliveries.eventKey,
					channel: notificationDeliveries.channel
				});
			const row = rows[0];
			if (!row) return null;
			await recordActivity(tx, {
				event: 'notification.resend',
				actorId: locals.user?.id ?? null,
				payload: {
					deliveryId: row.id,
					eventType: row.eventType,
					eventKey: row.eventKey,
					channel: row.channel
				},
				deliver: false
			});
			return row;
		});
		if (!requeued) {
			return fail(400, {
				op: 'resendNotification',
				message: m.admin_settings_notification_err_not_requeueable()
			});
		}
		return {
			op: 'resendNotification',
			resent: true,
			id: requeued.id,
			message: m.admin_settings_notification_resend_ok()
		};
	},

	create: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.webhooks');
		const form = await request.formData();
		const parsed = await parseEndpointForm(form, {
			allowPrivate: webhookAllowPrivateTargets((name) => env[name])
		});
		if (!parsed.ok) return fail(400, { op: 'create', message: parsed.message });
		if (await endpointNameTaken(parsed.name)) {
			return fail(400, { op: 'create', message: m.admin_settings_notification_err_name_dup() });
		}
		const keyring = webhookKeyring();
		if (!keyring) {
			return fail(503, {
				op: 'create',
				message: m.admin_settings_notification_err_secret_store()
			});
		}
		const secret = generateWebhookSecret();
		// The AAD binds the ciphertext to the row id, so the id is minted here
		// rather than by the column default: encryption must happen before the
		// insert.
		const id = randomUUID();
		const encrypted = encryptWebhookSecretValue(id, secret, keyring);
		try {
			await db.transaction(async (tx) => {
				await tx.insert(webhooks).values({
					id,
					name: parsed.name,
					payloadUrl: parsed.payloadUrl,
					events: parsed.events
				});
				await tx.insert(webhookSecrets).values({
					webhookId: id,
					ciphertext: encrypted.ciphertext,
					hint: encrypted.hint,
					keyVersion: encrypted.keyVersion,
					updatedBy: locals.user?.id ?? null
				});
				await recordActivity(tx, {
					event: 'webhook.create',
					actorId: locals.user?.id ?? null,
					// Config audit: host + subscription only. The path can carry
					// a receiver token, and the secret never enters a payload.
					payload: {
						webhookId: id,
						name: parsed.name,
						host: webhookHostOf(parsed.payloadUrl),
						events: parsed.events
					},
					deliver: false
				});
				await recordActivity(tx, {
					event: 'webhook.key_set',
					actorId: locals.user?.id ?? null,
					payload: { webhookId: id, name: parsed.name, hint: encrypted.hint },
					// Secret metadata never fans out (decision A2).
					deliver: false
				});
			});
			// The only reveal of the raw secret - exactly once, right here.
			return { op: 'create', created: true, id, secret };
		} catch (error) {
			// Defense in depth behind the normalized-href guard (round-2 N1).
			if (pgErrorCode(error) === '23514') {
				return fail(400, { op: 'create', message: m.admin_settings_notification_err_url() });
			}
			if (error instanceof SecretError) {
				return fail(503, {
					op: 'create',
					message: m.admin_settings_notification_err_secret_store()
				});
			}
			throw error;
		}
	},

	update: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.webhooks');
		const form = await request.formData();
		const id = endpointId(form);
		if (!id)
			return fail(400, {
				op: 'update',
				message: m.admin_settings_notification_err_endpoint_bad_id()
			});
		const parsed = await parseEndpointForm(form, {
			allowPrivate: webhookAllowPrivateTargets((name) => env[name])
		});
		if (!parsed.ok) return fail(400, { op: 'update', message: parsed.message });
		if (await endpointNameTaken(parsed.name, id)) {
			return fail(400, { op: 'update', message: m.admin_settings_notification_err_name_dup() });
		}
		// Assigned on the try path; every catch path returns or rethrows, so
		// the definite-assignment analysis below is sound without an init.
		let updated: boolean;
		try {
			updated = await db.transaction(async (tx) => {
				const rows = await tx
					.update(webhooks)
					.set({ name: parsed.name, payloadUrl: parsed.payloadUrl, events: parsed.events })
					.where(eq(webhooks.id, id))
					.returning({ id: webhooks.id });
				if (rows.length === 0) return false;
				await recordActivity(tx, {
					event: 'webhook.update',
					actorId: locals.user?.id ?? null,
					payload: {
						webhookId: id,
						name: parsed.name,
						host: webhookHostOf(parsed.payloadUrl),
						events: parsed.events
					},
					deliver: false
				});
				return true;
			});
		} catch (error) {
			// Defense in depth behind the normalized-href guard (round-2 N1).
			if (pgErrorCode(error) === '23514') {
				return fail(400, { op: 'update', message: m.admin_settings_notification_err_url() });
			}
			throw error;
		}
		if (!updated) {
			return fail(404, {
				op: 'update',
				message: m.admin_settings_notification_err_endpoint_not_found()
			});
		}
		return { op: 'update', updated: true };
	},

	delete: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.webhooks');
		const form = await request.formData();
		const id = endpointId(form);
		if (!id)
			return fail(400, {
				op: 'delete',
				message: m.admin_settings_notification_err_endpoint_bad_id()
			});
		const deleted = await db.transaction(async (tx) => {
			const rows = await tx
				.delete(webhooks)
				.where(eq(webhooks.id, id))
				.returning({ id: webhooks.id, name: webhooks.name });
			if (rows.length === 0) return null;
			await recordActivity(tx, {
				event: 'webhook.delete',
				actorId: locals.user?.id ?? null,
				payload: { webhookId: id, name: rows[0].name },
				deliver: false
			});
			return rows[0];
		});
		if (!deleted) {
			return fail(404, {
				op: 'delete',
				message: m.admin_settings_notification_err_endpoint_not_found()
			});
		}
		return { op: 'delete', deleted: true };
	},

	toggle: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.webhooks');
		const form = await request.formData();
		const id = endpointId(form);
		if (!id)
			return fail(400, {
				op: 'toggle',
				message: m.admin_settings_notification_err_endpoint_bad_id()
			});
		const rawEnabled = (form.get('enabled') ?? '').toString();
		if (rawEnabled !== 'true' && rawEnabled !== 'false') {
			return fail(400, { op: 'toggle', message: m.admin_settings_notification_err_bad_request() });
		}
		const enabled = rawEnabled === 'true';
		const toggled = await db.transaction(async (tx) => {
			const rows = await tx
				.update(webhooks)
				.set({ isEnabled: enabled })
				.where(eq(webhooks.id, id))
				.returning({ id: webhooks.id });
			if (rows.length === 0) return false;
			await recordActivity(tx, {
				event: 'webhook.toggle',
				actorId: locals.user?.id ?? null,
				payload: { webhookId: id, enabled },
				deliver: false
			});
			return true;
		});
		if (!toggled) {
			return fail(404, {
				op: 'toggle',
				message: m.admin_settings_notification_err_endpoint_not_found()
			});
		}
		return {
			op: 'toggle',
			toggled: true,
			message: m.admin_settings_notification_toggled_ok()
		};
	},

	rotate: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'notifications', 'notifications.webhooks');
		const form = await request.formData();
		const id = endpointId(form);
		if (!id)
			return fail(400, {
				op: 'rotate',
				message: m.admin_settings_notification_err_endpoint_bad_id()
			});
		const keyring = webhookKeyring();
		if (!keyring) {
			return fail(503, {
				op: 'rotate',
				message: m.admin_settings_notification_err_secret_store()
			});
		}
		const secret = generateWebhookSecret();
		const encrypted = encryptWebhookSecretValue(id, secret, keyring);
		try {
			const rotated = await db.transaction(async (tx) => {
				const [endpoint] = await tx
					.select({ id: webhooks.id, name: webhooks.name, legacySecret: webhooks.secret })
					.from(webhooks)
					.where(eq(webhooks.id, id))
					.limit(1);
				if (!endpoint) return false;
				const [existing] = await tx
					.select({
						ciphertext: webhookSecrets.ciphertext,
						keyVersion: webhookSecrets.keyVersion
					})
					.from(webhookSecrets)
					.where(eq(webhookSecrets.webhookId, id))
					.limit(1);
				// Grace window: the value this rotation replaces stays
				// verifiable for one day. The current envelope is bound to the
				// `ciphertext` AAD, so it must be decrypted and re-encrypted
				// for the `previous_ciphertext` slot - copying it verbatim
				// would make every delivery fail for the whole window.
				let previousCiphertext: string | null = null;
				let previousKeyVersion: number | null = null;
				let previousExpiresAt: Date | null = null;
				if (existing) {
					const plain = decryptSecret(
						existing.ciphertext,
						keyring.resolve,
						secretAad('webhook_secrets', id, 'ciphertext')
					).plaintext;
					const previous = encryptPreviousWebhookSecret(id, plain, keyring);
					previousCiphertext = previous.ciphertext;
					previousKeyVersion = previous.keyVersion;
					previousExpiresAt = new Date(Date.now() + WEBHOOK_SECRET_GRACE_MS);
				} else if (endpoint.legacySecret) {
					const previous = encryptPreviousWebhookSecret(id, endpoint.legacySecret, keyring);
					previousCiphertext = previous.ciphertext;
					previousKeyVersion = previous.keyVersion;
					previousExpiresAt = new Date(Date.now() + WEBHOOK_SECRET_GRACE_MS);
				}
				const stamp = new Date();
				await tx
					.insert(webhookSecrets)
					.values({
						webhookId: id,
						ciphertext: encrypted.ciphertext,
						hint: encrypted.hint,
						keyVersion: encrypted.keyVersion,
						previousCiphertext,
						previousKeyVersion,
						previousExpiresAt,
						updatedBy: locals.user?.id ?? null
					})
					.onConflictDoUpdate({
						target: webhookSecrets.webhookId,
						set: {
							ciphertext: encrypted.ciphertext,
							hint: encrypted.hint,
							keyVersion: encrypted.keyVersion,
							previousCiphertext,
							previousKeyVersion,
							previousExpiresAt,
							updatedBy: locals.user?.id ?? null,
							updatedAt: stamp
						}
					});
				// The plaintext column is retired as soon as the encrypted row
				// exists; receivers get the previous value from the grace slot.
				if (endpoint.legacySecret !== null) {
					await tx.update(webhooks).set({ secret: null }).where(eq(webhooks.id, id));
				}
				await recordActivity(tx, {
					event: 'webhook.key_rotate',
					actorId: locals.user?.id ?? null,
					payload: { webhookId: id, name: endpoint.name, hint: encrypted.hint },
					deliver: false
				});
				return true;
			});
			if (!rotated) {
				return fail(404, {
					op: 'rotate',
					message: m.admin_settings_notification_err_endpoint_not_found()
				});
			}
		} catch (error) {
			if (error instanceof SecretError) {
				return fail(503, {
					op: 'rotate',
					message: m.admin_settings_notification_err_secret_store()
				});
			}
			throw error;
		}
		// Same reveal rule as create: the new secret is shown exactly once.
		return { op: 'rotate', rotated: true, secret };
	}
};
