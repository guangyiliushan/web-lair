import { and, desc, eq, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { aiAgentConversations, aiAgentMessages } from '$lib/server/db/ai';
import { adminContextFor, requireAiUse } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { streamAgentChat } from '$lib/server/ai/agent/run';
import { chatErrorMessage } from '$lib/server/ai/chat-error';
import { resolveProviderKey, type SecretDb } from '$lib/server/secrets/resolver';
import { getCache } from '$lib/server/cache';
import { rateLimitStrict } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { clientAddressKey } from '$lib/utils/cidr';
import type { RequestHandler } from './$types';

const MAX_USER_CHARS = 4000;

/** Cost-bearing endpoint: 30 turns/hour per account, 60 per IP. */
const AI_RATE_LIMIT = { limit: 30, windowSeconds: 60 * 60 } as const;
const AI_IP_RATE_LIMIT = { limit: 60, windowSeconds: 60 * 60 } as const;

function messageText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (content && typeof content === 'object') {
		const text = (content as { text?: unknown }).text;
		if (typeof text === 'string') return text;
	}
	return '';
}

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	await requireAiUse();
	const userId = locals.user?.id;
	if (!userId) return new Response('unauthorized', { status: 401 });

	// Fail-closed budget before any provider work happens.
	const address = clientAddressKey(requestAddress(getClientAddress));
	const [accountRate, addressRate] = await Promise.all([
		rateLimitStrict(
			getCache(),
			`limits:ai-chat:${userId}`,
			AI_RATE_LIMIT.limit,
			AI_RATE_LIMIT.windowSeconds
		),
		rateLimitStrict(
			getCache(),
			`limits:ai-chat-ip:${address}`,
			AI_IP_RATE_LIMIT.limit,
			AI_IP_RATE_LIMIT.windowSeconds
		)
	]);
	if (!accountRate.allowed || !addressRate.allowed) {
		const unavailable = accountRate.unavailable || addressRate.unavailable;
		return new Response(unavailable ? 'unavailable' : 'throttled', {
			status: unavailable ? 503 : 429,
			headers: {
				'retry-after': String(Math.max(AI_RATE_LIMIT.windowSeconds, AI_IP_RATE_LIMIT.windowSeconds))
			}
		});
	}

	let body: { conversationId?: unknown; text?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return new Response('invalid json', { status: 400 });
	}
	const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!conversationId || !text) return new Response('missing fields', { status: 400 });
	if (text.length > MAX_USER_CHARS) return new Response('too long', { status: 400 });

	const [conversation] = await db
		.select({ id: aiAgentConversations.id, title: aiAgentConversations.title })
		.from(aiAgentConversations)
		.where(
			and(eq(aiAgentConversations.id, conversationId), eq(aiAgentConversations.userId, userId))
		)
		.limit(1);
	if (!conversation) return new Response('not found', { status: 404 });

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

	const encoder = new TextEncoder();
	const role = adminContextFor(locals.user)?.role === 'owner' ? 'owner' : 'admin';

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};
			const close = () => {
				if (closed) return;
				closed = true;
				controller.close();
			};

			try {
				const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
				const result = await streamAgentChat({
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
					userText: text,
					signal,
					onEvent: (event) => {
						if (event.type === 'delta') send('delta', { text: event.text });
						else if (event.type === 'tool') {
							send('tool', {
								title: event.title,
								description: event.description,
								status: event.status
							});
						}
					}
				});

				seq += 1;
				await db.insert(aiAgentMessages).values({
					conversationId,
					seq,
					role: 'assistant',
					content: { text: result.text, trace: result.trace },
					model: result.model
				});
				await db
					.update(aiAgentConversations)
					.set({
						updatedAt: new Date(),
						...(conversation.title === null ? { title: text.slice(0, 80) } : {})
					})
					.where(eq(aiAgentConversations.id, conversationId));

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

				send('done', { text: result.text, trace: result.trace, model: result.model });
				close();
			} catch (caught) {
				const message = chatErrorMessage(caught);
				seq += 1;
				await db
					.insert(aiAgentMessages)
					.values({
						conversationId,
						seq,
						role: 'assistant',
						content: { text: message }
					})
					.catch(() => {});
				send('error', { message });
				close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
