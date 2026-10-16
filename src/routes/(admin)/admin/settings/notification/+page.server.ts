import { fail } from '@sveltejs/kit';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { webhookDeliveries, webhooks } from '$lib/server/db/system';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDateTime } from '$lib/utils/i18n';
import { WEBHOOK_EVENT_ROSTER, isWebhookEventName } from '$lib/server/webhooks/events';
import { generateWebhookSecret, maskWebhookSecret } from '$lib/server/webhooks/secret';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Notification settings · Webhooks section. J-3 built the read-only endpoint
 * list + delivery log + retry; SY S2 adds endpoint CRUD (ledger §26).
 *
 * - Retry semantics (plan §26 / runbook §7): copy a new queued row - the
 *   failed row stays for the record, and the drain picks the copy up within
 *   <=1 tick. No audit row: the ledger §26 roster v1 covers only the job.*
 *   and schedule.* events, and the delivery rows themselves are the trail.
 * - Endpoint CRUD: secrets are server-generated only (whsec_ + base64, the
 *   Standard Webhooks shape). The load renders a MASKED preview; the raw
 *   value is revealed exactly once in the create/rotate action result.
 *   Names are soft-rejected case-insensitively at the application layer
 *   (no DB constraint - the 10-13 grill G3 ruling).
 * - Stored payload URLs are the WHATWG-normalized `href` (review round-1:
 *   `new URL()` accepts `https:example.com` / uppercase schemes and folds
 *   them to lowercase with `//`, while the DB CHECK `^https?://` is
 *   case-sensitive - storing the raw string let accepted inputs hit 23514
 *   as an unhandled 500).
 */

const NAME_MAX_LENGTH = 120;
const PAYLOAD_URL_MAX_LENGTH = 2048;

type ParsedEndpointForm =
	{ ok: true; name: string; payloadUrl: string; events: string[] } | { ok: false; message: string };

/** Validate the endpoint form before any DB access. */
function parseEndpointForm(form: FormData): ParsedEndpointForm {
	const name = (form.get('name') ?? '').toString().trim();
	if (!name || name.length > NAME_MAX_LENGTH) {
		return { ok: false, message: m.admin_settings_notification_err_name() };
	}
	const payloadUrl = (form.get('payloadUrl') ?? '').toString().trim();
	if (!payloadUrl || payloadUrl.length > PAYLOAD_URL_MAX_LENGTH) {
		return { ok: false, message: m.admin_settings_notification_err_url() };
	}
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(payloadUrl);
	} catch {
		return { ok: false, message: m.admin_settings_notification_err_url() };
	}
	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		return { ok: false, message: m.admin_settings_notification_err_url() };
	}
	const events = [...new Set(form.getAll('events').map((value) => value.toString()))];
	if (!events.every(isWebhookEventName)) {
		return { ok: false, message: m.admin_settings_notification_err_events() };
	}
	// Store the normalized form, not the raw string: the column CHECK
	// (`^https?://`) must hold for everything this validator accepts.
	return { ok: true, name, payloadUrl: parsedUrl.href, events };
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

export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const siteTz = await getOption('site.timezone');
	const [webhookRows, deliveryRows] = await Promise.all([
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
				responseCode: webhookDeliveries.responseCode,
				error: webhookDeliveries.error,
				deliveredAt: webhookDeliveries.deliveredAt
			})
			.from(webhookDeliveries)
			.orderBy(desc(webhookDeliveries.createdAt))
			.limit(50)
	]);
	// The raw secret never leaves the server: page data carries a mask only.
	const webhookEndpoints = webhookRows.map(({ secret, ...endpoint }) => ({
		...endpoint,
		secretPreview: maskWebhookSecret(secret)
	}));
	const byId = new Map(webhookEndpoints.map((row) => [row.id, row]));
	return {
		webhookEndpoints,
		webhookEventRoster: [...WEBHOOK_EVENT_ROSTER],
		webhookDeliveries: deliveryRows.map((row) => {
			const endpoint = byId.get(row.webhookId);
			return {
				...row,
				webhookName: endpoint?.name ?? m.admin_settings_notification_endpoint_deleted(),
				createdLabel: formatDateTime(row.createdAt, { timeZone: siteTz })
			};
		})
	};
};

export const actions: Actions = {
	retry: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id))
			return fail(400, { message: m.admin_settings_notification_err_bad_id() });
		const [delivery] = await db
			.select({
				id: webhookDeliveries.id,
				webhookId: webhookDeliveries.webhookId,
				event: webhookDeliveries.event,
				payload: webhookDeliveries.payload,
				status: webhookDeliveries.status
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
		try {
			const [row] = await db
				.insert(webhookDeliveries)
				.values({
					webhookId: delivery.webhookId,
					event: delivery.event,
					payload: delivery.payload,
					status: 'queued'
				})
				.returning({ id: webhookDeliveries.id });
			return { retried: true, id: row.id };
		} catch (error) {
			// TOCTOU tail (J-3 review P3-1): the endpoint can be deleted
			// between the check above and this insert; the FK answers 23503.
			if (pgErrorCode(error) === '23503') {
				return fail(400, { message: m.admin_settings_notification_err_gone_race() });
			}
			throw error;
		}
	},

	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const parsed = parseEndpointForm(form);
		if (!parsed.ok) return fail(400, { op: 'create', message: parsed.message });
		if (await endpointNameTaken(parsed.name)) {
			return fail(400, { op: 'create', message: m.admin_settings_notification_err_name_dup() });
		}
		const secret = generateWebhookSecret();
		const [row] = await db
			.insert(webhooks)
			.values({
				name: parsed.name,
				payloadUrl: parsed.payloadUrl,
				events: parsed.events,
				secret
			})
			.returning({ id: webhooks.id });
		// The only reveal of the raw secret - exactly once, right here.
		return { op: 'create', created: true, id: row.id, secret };
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = endpointId(form);
		if (!id)
			return fail(400, {
				op: 'update',
				message: m.admin_settings_notification_err_endpoint_bad_id()
			});
		const parsed = parseEndpointForm(form);
		if (!parsed.ok) return fail(400, { op: 'update', message: parsed.message });
		if (await endpointNameTaken(parsed.name, id)) {
			return fail(400, { op: 'update', message: m.admin_settings_notification_err_name_dup() });
		}
		const updated = await db
			.update(webhooks)
			.set({ name: parsed.name, payloadUrl: parsed.payloadUrl, events: parsed.events })
			.where(eq(webhooks.id, id))
			.returning({ id: webhooks.id });
		if (updated.length === 0) {
			return fail(404, {
				op: 'update',
				message: m.admin_settings_notification_err_endpoint_not_found()
			});
		}
		return { op: 'update', updated: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = endpointId(form);
		if (!id)
			return fail(400, {
				op: 'delete',
				message: m.admin_settings_notification_err_endpoint_bad_id()
			});
		const deleted = await db
			.delete(webhooks)
			.where(eq(webhooks.id, id))
			.returning({ id: webhooks.id });
		if (deleted.length === 0) {
			return fail(404, {
				op: 'delete',
				message: m.admin_settings_notification_err_endpoint_not_found()
			});
		}
		return { op: 'delete', deleted: true };
	},

	toggle: async ({ request }) => {
		await requireAdminRole();
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
		const toggled = await db
			.update(webhooks)
			.set({ isEnabled: rawEnabled === 'true' })
			.where(eq(webhooks.id, id))
			.returning({ id: webhooks.id });
		if (toggled.length === 0) {
			return fail(404, {
				op: 'toggle',
				message: m.admin_settings_notification_err_endpoint_not_found()
			});
		}
		return { op: 'toggle', toggled: true };
	},

	rotate: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = endpointId(form);
		if (!id)
			return fail(400, {
				op: 'rotate',
				message: m.admin_settings_notification_err_endpoint_bad_id()
			});
		const secret = generateWebhookSecret();
		const rotated = await db
			.update(webhooks)
			.set({ secret })
			.where(eq(webhooks.id, id))
			.returning({ id: webhooks.id });
		if (rotated.length === 0) {
			return fail(404, {
				op: 'rotate',
				message: m.admin_settings_notification_err_endpoint_not_found()
			});
		}
		// Same reveal rule as create: the new secret is shown exactly once.
		return { op: 'rotate', rotated: true, secret };
	}
};
