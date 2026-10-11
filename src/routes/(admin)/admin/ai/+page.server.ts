import { fail } from '@sveltejs/kit';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { aiAgentConversations, aiAgentMemories, aiAgentMessages, aiUsage } from '$lib/server/db/ai';
import { requireAdminRole } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

const MEMORY_LIMIT = 50;

/**
 * AI console v1 (ai-line plan §5.2): conversations list + messages, the
 * memory-card CRUD and the read-only usage view. Conversations/messages stay
 * view-only until the runtime batch wires a model; memory cards are
 * owner-editable already.
 */
export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const rawTab = url.searchParams.get('tab');
	const tab = rawTab === 'memories' || rawTab === 'usage' ? rawTab : 'conversations';
	const rawC = url.searchParams.get('c');
	// Malformed ids never reach the uuid columns (P1.1 review lesson).
	const selectedId = rawC && isUuid(rawC) ? rawC : null;

	const [conversations, memories] = await Promise.all([
		db
			.select({
				id: aiAgentConversations.id,
				title: aiAgentConversations.title,
				summary: aiAgentConversations.summary,
				archivedAt: aiAgentConversations.archivedAt,
				createdAt: aiAgentConversations.createdAt,
				updatedAt: aiAgentConversations.updatedAt,
				messageCount:
					sql<number>`(select count(*) from ${aiAgentMessages} where ${aiAgentMessages.conversationId} = ${aiAgentConversations.id})`.mapWith(
						Number
					)
			})
			.from(aiAgentConversations)
			.orderBy(desc(aiAgentConversations.updatedAt)),
		db.select().from(aiAgentMemories).orderBy(desc(aiAgentMemories.createdAt))
	]);

	const messages = selectedId
		? await db
				.select({
					id: aiAgentMessages.id,
					seq: aiAgentMessages.seq,
					role: aiAgentMessages.role,
					content: aiAgentMessages.content,
					model: aiAgentMessages.model,
					createdAt: aiAgentMessages.createdAt
				})
				.from(aiAgentMessages)
				.where(eq(aiAgentMessages.conversationId, selectedId))
				.orderBy(aiAgentMessages.seq)
		: [];

	const usage = await db
		.select({
			month: sql<string>`to_char(${aiUsage.createdAt}, 'YYYY-MM')`,
			task: aiUsage.task,
			calls: sql<number>`count(*)`.mapWith(Number),
			inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)`.mapWith(Number),
			outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)`.mapWith(Number),
			cost: sql<number | null>`sum(${aiUsage.costEstimate})::float8`
		})
		.from(aiUsage)
		.groupBy(sql`to_char(${aiUsage.createdAt}, 'YYYY-MM')`, aiUsage.task)
		.orderBy(sql`to_char(${aiUsage.createdAt}, 'YYYY-MM') desc`, aiUsage.task);

	return {
		headerTitle: 'AI',
		tab,
		selectedId,
		conversations,
		messages,
		memories,
		usage,
		memoryLimit: MEMORY_LIMIT
	};
};

export const actions: Actions = {
	saveMemory: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		const content = (form.get('content') ?? '').toString().trim();
		if (!content) return fail(400, { message: m.admin_ai_err_content_required() });
		if (content.length > 2000) return fail(400, { message: m.admin_ai_err_content_too_long() });
		if (id) {
			if (!isUuid(id)) return fail(400, { message: m.admin_ai_err_bad_id() });
			const updated = await db
				.update(aiAgentMemories)
				.set({ content })
				.where(eq(aiAgentMemories.id, id))
				.returning({ id: aiAgentMemories.id });
			if (updated.length === 0) return fail(404, { message: m.admin_ai_err_memory_not_found() });
			return { message: m.admin_ai_flash_memory_updated() };
		}
		const [count] = await db
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(aiAgentMemories);
		if (count.n >= MEMORY_LIMIT)
			return fail(400, { message: m.admin_ai_err_memory_limit({ count: MEMORY_LIMIT }) });
		await db.insert(aiAgentMemories).values({ content });
		return { message: m.admin_ai_flash_memory_created() };
	},

	deleteMemory: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_ai_err_bad_id() });
		const deleted = await db
			.delete(aiAgentMemories)
			.where(eq(aiAgentMemories.id, id))
			.returning({ id: aiAgentMemories.id });
		if (deleted.length === 0) return fail(404, { message: m.admin_ai_err_memory_not_found() });
		return { message: m.admin_ai_flash_memory_deleted() };
	},

	archiveConversation: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_ai_err_bad_id() });
		const archive = form.get('archive')?.toString() === 'true';
		const updated = await db
			.update(aiAgentConversations)
			.set({ archivedAt: archive ? new Date() : null })
			.where(eq(aiAgentConversations.id, id))
			.returning({ id: aiAgentConversations.id });
		if (updated.length === 0) return fail(404, { message: m.admin_ai_err_session_not_found() });
		return { message: archive ? m.admin_ai_flash_archived() : m.admin_ai_flash_unarchived() };
	}
} satisfies Actions;
