import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import {
	aiAgentConversations,
	aiAgentMessages,
	aiAgentProposals,
	aiModelPool,
	aiProviders
} from '$lib/server/db/ai';
import { adminContextFor, requireAdminRole, requireAiUse } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { getOption, setOption } from '$lib/server/config/options-registry';
import { toConsoleMessages, type ConsoleMessageRow } from '$lib/components/admin/ai/console-view';
import { runAgentChat } from '$lib/server/ai/agent/run';
import { agentSettingTier } from '$lib/server/ai/agent/setting-tiers';
import { chatErrorMessage } from '$lib/server/ai/chat-error';
import { resolveProviderKey, type SecretDb } from '$lib/server/secrets/resolver';
import { aiReadiness, type ReadinessProvider } from '$lib/server/services/ai-readiness';
import { m } from '$lib/paraglide/messages';
import type { Actions, PageServerLoad } from './$types';

const MAX_USER_CHARS = 4000;

function messageText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (content && typeof content === 'object') {
		const text = (content as { text?: unknown }).text;
		if (typeof text === 'string') return text;
	}
	return '';
}

/**
 * The chat surface replaces the admin header's default "访问站点" with the one
 * verb that belongs to this screen. The click cannot be described by `load`
 * (handlers do not cross the server boundary), so the page binds `chat:new`
 * through the action registry and submits a hidden `?/new` form.
 *
 * Resolved per request, not at module scope: module-level `m.*()` calls run
 * once at import, before the request locale is known.
 */
function headerData() {
	return {
		headerActions: [
			{
				label: m.admin_ai_chat_new_action(),
				iconName: 'plus',
				variant: 'outline' as const,
				actionId: 'chat:new'
			}
		]
	};
}

/**
 * Readiness for the slot this screen runs on, computed from the same inputs as
 * `/admin/ai` and the settings page. The composer disables itself on anything
 * but `ready` and says why, so an unassigned slot can no longer look like a
 * working chat until the first send fails.
 */
async function chatReadiness() {
	const [providers, assignments, poolModels] = await Promise.all([
		db
			.select({
				name: aiProviders.name,
				enabled: aiProviders.enabled,
				apiKeyEnv: aiProviders.apiKeyEnv,
				models: aiProviders.models
			})
			.from(aiProviders)
			.orderBy(aiProviders.name),
		getOption('ai.assignments'),
		db
			.select({ model: aiModelPool.model })
			.from(aiModelPool)
			.where(eq(aiModelPool.enabled, true))
			.orderBy(aiModelPool.position)
	]);
	const readinessProviders: ReadinessProvider[] = providers.map((provider) => ({
		name: provider.name,
		enabled: provider.enabled,
		apiKeyEnv: provider.apiKeyEnv,
		models: provider.models
	}));
	return aiReadiness({
		providers: readinessProviders,
		assignments,
		// Presence only; the secret never leaves the server.
		hasEnv: (name) => Boolean(env[name]),
		pool: poolModels.map((row) => row.model)
	}).chat;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	await requireAiUse();
	const chat = await chatReadiness();
	const userId = locals.user?.id;
	if (!userId)
		return {
			...headerData(),
			chatReadiness: chat,
			conversations: [],
			selectedId: null,
			messages: [],
			proposals: []
		};

	const conversations = await db
		.select({
			id: aiAgentConversations.id,
			title: aiAgentConversations.title,
			summary: aiAgentConversations.summary,
			archivedAt: aiAgentConversations.archivedAt,
			createdAt: aiAgentConversations.createdAt,
			updatedAt: aiAgentConversations.updatedAt
		})
		.from(aiAgentConversations)
		.where(eq(aiAgentConversations.userId, userId))
		.orderBy(desc(aiAgentConversations.updatedAt));

	const counts = await db
		.select({
			conversationId: aiAgentMessages.conversationId,
			n: sql<number>`count(*)`.mapWith(Number)
		})
		.from(aiAgentMessages)
		.groupBy(aiAgentMessages.conversationId);
	const countByConversation = new Map(counts.map((row) => [row.conversationId, row.n]));

	const requested = url.searchParams.get('c');
	const selectedId =
		requested && conversations.some((conversation) => conversation.id === requested)
			? requested
			: (conversations[0]?.id ?? null);

	const rows = selectedId
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
				.orderBy(asc(aiAgentMessages.seq))
		: [];

	const proposals = selectedId
		? await db
				.select({
					id: aiAgentProposals.id,
					settingKey: aiAgentProposals.settingKey,
					before: aiAgentProposals.before,
					after: aiAgentProposals.after,
					expiresAt: aiAgentProposals.expiresAt,
					createdAt: aiAgentProposals.createdAt
				})
				.from(aiAgentProposals)
				.where(
					and(
						eq(aiAgentProposals.conversationId, selectedId),
						eq(aiAgentProposals.status, 'pending'),
						gt(aiAgentProposals.expiresAt, new Date())
					)
				)
				.orderBy(desc(aiAgentProposals.createdAt))
		: [];

	return {
		...headerData(),
		chatReadiness: chat,
		conversations: conversations.map((conversation) => ({
			...conversation,
			messageCount: countByConversation.get(conversation.id) ?? 0
		})),
		selectedId,
		messages: toConsoleMessages(rows as ConsoleMessageRow[]),
		proposals
	};
};

export const actions: Actions = {
	new: async ({ locals }) => {
		await requireAdminRole();
		const userId = locals.user?.id;
		if (!userId) return fail(401, { message: m.admin_ai_chat_error({ message: 'no session' }) });
		const [created] = await db
			.insert(aiAgentConversations)
			.values({ userId, title: m.admin_ai_untitled_session(), updatedAt: new Date() })
			.returning({ id: aiAgentConversations.id });
		redirect(303, `?c=${created.id}`);
	},

	send: async ({ request, locals }) => {
		await requireAiUse();
		const userId = locals.user?.id;
		if (!userId) return fail(401, { message: m.admin_ai_chat_error({ message: 'no session' }) });
		const form = await request.formData();
		const conversationId = (form.get('conversationId') ?? '').toString();
		const text = (form.get('text') ?? '').toString().trim();
		if (!conversationId || !text) {
			return fail(400, { message: m.admin_ai_chat_error({ message: 'empty' }) });
		}
		if (text.length > MAX_USER_CHARS) {
			return fail(400, { message: m.admin_ai_chat_error({ message: 'too long' }) });
		}
		const [conversation] = await db
			.select({ id: aiAgentConversations.id, title: aiAgentConversations.title })
			.from(aiAgentConversations)
			.where(
				and(eq(aiAgentConversations.id, conversationId), eq(aiAgentConversations.userId, userId))
			)
			.limit(1);
		if (!conversation)
			return fail(404, { message: m.admin_ai_chat_error({ message: 'not found' }) });

		const historyRows = await db
			.select({
				role: aiAgentMessages.role,
				content: aiAgentMessages.content,
				seq: aiAgentMessages.seq
			})
			.from(aiAgentMessages)
			.where(
				and(
					eq(aiAgentMessages.conversationId, conversationId),
					sql`${aiAgentMessages.role} in ('user', 'assistant')`
				)
			)
			.orderBy(desc(aiAgentMessages.seq))
			.limit(20);
		const history = historyRows
			.reverse()
			.map((row) => ({
				role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
				text: messageText(row.content)
			}))
			.filter((row) => row.text.length > 0);

		const [maxRow] = await db
			.select({ n: sql<number>`coalesce(max(${aiAgentMessages.seq}), 0)`.mapWith(Number) })
			.from(aiAgentMessages)
			.where(eq(aiAgentMessages.conversationId, conversationId));
		let seq = (maxRow?.n ?? 0) + 1;
		await db.insert(aiAgentMessages).values({
			conversationId,
			seq,
			role: 'user',
			content: { text }
		});

		const role = adminContextFor(locals.user)?.role === 'owner' ? 'owner' : 'admin';
		try {
			const result = await runAgentChat({
				db: db as never,
				getEnv: (name) => env[name],
				resolveKey: (provider) =>
					resolveProviderKey(db as unknown as SecretDb, provider, {
						getEnv: (name) => env[name]
					}),
				conversationId,
				actorId: userId,
				actorRole: role,
				history,
				userText: text
			});
			seq += 1;
			await db.insert(aiAgentMessages).values({
				conversationId,
				seq,
				role: 'assistant',
				content: { text: result.text, trace: result.trace },
				model: result.model
			});
			// One audit row per tool call; message content stays out of the
			// audit plane, and a webhook fan-out failure must not lose the reply.
			try {
				for (const step of result.trace) {
					await recordActivity(db, {
						event: 'agent.tool_call',
						actorId: userId,
						payload: {
							conversationId,
							tool: step.title,
							status: step.status
						}
					});
				}
			} catch (caught) {
				console.warn(
					'[agent] tool audit failed',
					caught instanceof Error ? caught.message : caught
				);
			}
			await db
				.update(aiAgentConversations)
				.set({
					updatedAt: new Date(),
					...(conversation.title === null || conversation.title === m.admin_ai_untitled_session()
						? { title: text.slice(0, 80) }
						: {})
				})
				.where(eq(aiAgentConversations.id, conversationId));
			return { ok: true };
		} catch (caught) {
			const message = chatErrorMessage(caught);
			seq += 1;
			await db.insert(aiAgentMessages).values({
				conversationId,
				seq,
				role: 'assistant',
				content: { text: message }
			});
			return fail(502, { message });
		}
	},

	archive: async ({ request, locals }) => {
		await requireAdminRole();
		const userId = locals.user?.id;
		if (!userId) return fail(401, { message: m.admin_ai_chat_error({ message: 'no session' }) });
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_ai_chat_error({ message: 'missing id' }) });
		const updated = await db
			.update(aiAgentConversations)
			.set({ archivedAt: new Date(), updatedAt: new Date() })
			.where(and(eq(aiAgentConversations.id, id), eq(aiAgentConversations.userId, userId)))
			.returning({ id: aiAgentConversations.id });
		if (updated.length === 0) {
			return fail(404, { message: m.admin_ai_chat_error({ message: 'not found' }) });
		}
		redirect(303, '/admin/ai/chat');
	},

	confirmProposal: async ({ request, locals }) => {
		await requireAdminRole();
		const userId = locals.user?.id;
		if (!userId) return fail(401, { message: m.admin_ai_chat_error({ message: 'no session' }) });
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_ai_chat_error({ message: 'missing id' }) });
		const [proposal] = await db
			.select()
			.from(aiAgentProposals)
			.where(
				and(
					eq(aiAgentProposals.id, id),
					eq(aiAgentProposals.actorId, userId),
					eq(aiAgentProposals.status, 'pending')
				)
			)
			.limit(1);
		if (!proposal) return fail(404, { message: m.admin_ai_chat_error({ message: 'not found' }) });
		if (proposal.expiresAt.getTime() < Date.now()) {
			await db
				.update(aiAgentProposals)
				.set({ status: 'expired', resolvedAt: new Date() })
				.where(eq(aiAgentProposals.id, id));
			return fail(410, { message: m.admin_ai_chat_error({ message: 'expired' }) });
		}
		// Read-tier keys (site.languages / site.default_lang) never get new
		// proposals; a stale pending row from before that tier change is
		// refused here too instead of being half-applied (W5.4).
		if (agentSettingTier(proposal.settingKey) === 'read') {
			return fail(400, {
				message: m.admin_ai_chat_error({ message: 'read-only setting' })
			});
		}
		const hash = createHash('sha256')
			.update(
				JSON.stringify({
					key: proposal.settingKey,
					before: proposal.before,
					after: proposal.after
				})
			)
			.digest('hex');
		if (hash !== proposal.argsHash) {
			return fail(409, { message: m.admin_ai_chat_error({ message: 'tampered' }) });
		}
		try {
			await setOption(proposal.settingKey as never, proposal.after as never);
		} catch (caught) {
			return fail(400, {
				message: m.admin_ai_chat_error({
					message: caught instanceof Error ? caught.message : String(caught)
				})
			});
		}
		await db
			.update(aiAgentProposals)
			.set({ status: 'confirmed', resolvedAt: new Date() })
			.where(eq(aiAgentProposals.id, id));
		try {
			await recordActivity(db, {
				event: 'agent.setting_confirmed',
				actorId: userId,
				payload: { key: proposal.settingKey }
			});
		} catch (caught) {
			console.warn(
				'[agent] proposal audit failed',
				caught instanceof Error ? caught.message : caught
			);
		}
		return { ok: true };
	},

	rejectProposal: async ({ request, locals }) => {
		await requireAdminRole();
		const userId = locals.user?.id;
		if (!userId) return fail(401, { message: m.admin_ai_chat_error({ message: 'no session' }) });
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_ai_chat_error({ message: 'missing id' }) });
		const updated = await db
			.update(aiAgentProposals)
			.set({ status: 'rejected', resolvedAt: new Date() })
			.where(
				and(
					eq(aiAgentProposals.id, id),
					eq(aiAgentProposals.actorId, userId),
					eq(aiAgentProposals.status, 'pending')
				)
			)
			.returning({ id: aiAgentProposals.id });
		if (updated.length === 0) {
			return fail(404, { message: m.admin_ai_chat_error({ message: 'not found' }) });
		}
		return { ok: true };
	},

	delete: async ({ request, locals }) => {
		await requireAdminRole();
		const userId = locals.user?.id;
		if (!userId) return fail(401, { message: m.admin_ai_chat_error({ message: 'no session' }) });
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: m.admin_ai_chat_error({ message: 'missing id' }) });
		await db
			.delete(aiAgentConversations)
			.where(and(eq(aiAgentConversations.id, id), eq(aiAgentConversations.userId, userId)));
		try {
			await recordActivity(db, {
				event: 'agent.conversation_deleted',
				actorId: userId,
				payload: { conversationId: id }
			});
		} catch (caught) {
			console.warn(
				'[agent] delete audit failed',
				caught instanceof Error ? caught.message : caught
			);
		}
		redirect(303, '/admin/ai/chat');
	}
};
