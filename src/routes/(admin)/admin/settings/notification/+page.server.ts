import { fail } from '@sveltejs/kit';
import { asc, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { webhookDeliveries, webhooks } from '$lib/server/db/system';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDateTime } from '$lib/utils/i18n';
import type { PageServerLoad, Actions } from './$types';

/**
 * 通知设置 · Webhooks 区块 (J-3, grill R1-5): read-only endpoint list +
 * delivery log with a retry action. Endpoint CRUD is deliberately NOT here
 * (registered as a separate small batch). Retry semantics follow plan §26 /
 * runbook §7: 复制新 queued 行 - the failed row stays for the record, and the
 * drain picks the copy up within ≤1 tick. No audit row: the ledger §26
 * roster v1 covers only the job.* and schedule.* events, and the delivery rows
 * themselves are the trail.
 */

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
				isEnabled: webhooks.isEnabled
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
	const byId = new Map(webhookRows.map((row) => [row.id, row]));
	return {
		webhookEndpoints: webhookRows,
		webhookDeliveries: deliveryRows.map((row) => {
			const endpoint = byId.get(row.webhookId);
			return {
				...row,
				webhookName: endpoint?.name ?? '（端点已删除）',
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
		if (!id || !isUuid(id)) return fail(400, { message: '缺少有效的投递 ID' });
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
		if (!delivery) return fail(404, { message: '投递记录不存在' });
		// Assertion 87: 失败可重投 - a queued/succeeded row has nothing to retry.
		if (delivery.status !== 'failed') return fail(400, { message: '仅失败的投递可重投' });
		const [endpoint] = await db
			.select({ isEnabled: webhooks.isEnabled })
			.from(webhooks)
			.where(eq(webhooks.id, delivery.webhookId))
			.limit(1);
		if (!endpoint) return fail(404, { message: '端点已不存在' });
		if (!endpoint.isEnabled) return fail(400, { message: '端点已停用，启用后再重投' });
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
	}
};
