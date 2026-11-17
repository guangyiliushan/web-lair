import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { and, desc, eq, gte, ilike, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	categories,
	comments,
	moments,
	notes,
	posts,
	postProvenanceFromPayload
} from '$lib/server/db/content';
import { aiAgentProposals, aiModelPool, aiProviders, aiUsage } from '$lib/server/db/ai';
import { jobRuns } from '$lib/server/db/system';
import { getOption, validateOption } from '$lib/server/config/options-registry';
import { readBudgetState } from '$lib/server/ai/budget';
import { aiReadiness, type ReadinessProvider } from '$lib/server/services/ai-readiness';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { loadDraftByPostId, saveDraftWork } from '$lib/server/services/post-drafts';
import { loadNoteDraftByNoteId, saveNoteDraftWork } from '$lib/server/services/note-drafts';
import { AGENT_SETTING_KEYS, agentSettingTier, agentWriteDenial } from './setting-tiers';

/**
 * Agent v1 tool surface: read-only site inspection plus a
 * markdown validator. No publish, delete, settings write, upload, webhook,
 * email or provider configuration. Every tool returns plain JSON; the loop
 * treats it as untrusted data.
 */
export interface AgentToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface AgentToolContext {
	actorId: string;
	conversationId: string;
	role: 'owner' | 'admin';
}

export interface AgentTool {
	definition: AgentToolDefinition;
	execute: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<unknown>;
}

function text(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === 'string' ? value.trim() : '';
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
	const value = args[key];
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 100) : fallback;
}

function truncate(value: string | null, max: number): string | null {
	if (value === null) return null;
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

const SETTING_KEYS = [...AGENT_SETTING_KEYS] as const;

const getSiteOverview: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'get_site_overview',
			description: 'Counts, enabled languages, AI readiness and the current monthly budget state.',
			parameters: { type: 'object', properties: {}, additionalProperties: false }
		}
	},
	execute: async () => {
		const [postCount] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(posts);
		const [noteCount] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(notes);
		const [momentCount] = await db
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(moments);
		const [commentCount] = await db
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(comments);
		const languages = await getOption('site.languages');
		const budget = await readBudgetState(db as never);
		const providers = await db
			.select({
				name: aiProviders.name,
				enabled: aiProviders.enabled,
				apiKeyEnv: aiProviders.apiKeyEnv,
				models: aiProviders.models
			})
			.from(aiProviders);
		const assignments = await getOption('ai.assignments');
		const poolModels = await db
			.select({ model: aiModelPool.model })
			.from(aiModelPool)
			.where(eq(aiModelPool.enabled, true))
			.orderBy(aiModelPool.position);
		const readiness = aiReadiness({
			providers: providers as ReadinessProvider[],
			assignments,
			hasEnv: (name) => Boolean(env[name]),
			pool: poolModels.map((row) => row.model)
		});
		return {
			counts: {
				posts: postCount.n,
				notes: noteCount.n,
				moments: momentCount.n,
				comments: commentCount.n
			},
			languages: languages.enabled,
			budget: {
				monthly: budget.monthly,
				spent: budget.spent,
				currency: budget.currency,
				paused: budget.paused
			},
			readiness
		};
	}
};

const getSettings: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'get_settings',
			description: 'Read one or all allowlisted site settings with their write tier.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'Optional setting key; omit for all.' }
				},
				additionalProperties: false
			}
		}
	},
	execute: async (args) => {
		const requested = text(args, 'key');
		const keys = requested ? [requested] : [...SETTING_KEYS];
		const out: Record<string, unknown> = {};
		for (const key of keys) {
			if (!(SETTING_KEYS as readonly string[]).includes(key)) {
				out[key] = { error: 'not_allowlisted' };
				continue;
			}
			out[key] = {
				tier: agentSettingTier(key),
				value: await getOption(key as never)
			};
		}
		return out;
	}
};

const listContent: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'list_content',
			description: 'List posts, notes or moments with a title/body search. Returns summaries only.',
			parameters: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['post', 'note', 'moment'] },
					query: { type: 'string' },
					status: { type: 'string', enum: ['draft', 'published', 'private'] },
					limit: { type: 'number' }
				},
				required: ['type'],
				additionalProperties: false
			}
		}
	},
	execute: async (args) => {
		const type = text(args, 'type');
		const query = text(args, 'query');
		const status = text(args, 'status');
		const limit = numberArg(args, 'limit', 10);
		if (type === 'post') {
			const rows = await db
				.select({
					id: posts.id,
					title: posts.title,
					slug: posts.slug,
					status: posts.status,
					lang: posts.lang,
					updatedAt: posts.updatedAt
				})
				.from(posts)
				.where(
					and(
						query ? ilike(posts.title, `%${query}%`) : undefined,
						status ? eq(posts.status, status) : undefined
					)
				)
				.orderBy(desc(posts.updatedAt))
				.limit(limit);
			return { type, rows };
		}
		if (type === 'note') {
			const rows = await db
				.select({
					id: notes.id,
					title: notes.title,
					slug: notes.slug,
					status: notes.status,
					lang: notes.lang,
					updatedAt: notes.updatedAt
				})
				.from(notes)
				.where(
					and(
						query ? ilike(notes.title, `%${query}%`) : undefined,
						status ? eq(notes.status, status) : undefined
					)
				)
				.orderBy(desc(notes.updatedAt))
				.limit(limit);
			return { type, rows };
		}
		if (type === 'moment') {
			const rows = await db
				.select({
					id: moments.id,
					type: moments.type,
					content: sql<string>`left(${moments.content}, 200)`,
					createdAt: moments.createdAt
				})
				.from(moments)
				.where(query ? ilike(moments.content, `%${query}%`) : undefined)
				.orderBy(desc(moments.createdAt))
				.limit(limit);
			return { type, rows };
		}
		return { error: 'unknown_type' };
	}
};

const getContent: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'get_content',
			description: 'Read one post, note or moment by id; body is truncated for safety.',
			parameters: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['post', 'note', 'moment'] },
					id: { type: 'string' }
				},
				required: ['type', 'id'],
				additionalProperties: false
			}
		}
	},
	execute: async (args) => {
		const type = text(args, 'type');
		const id = text(args, 'id');
		if (!id) return { error: 'missing_id' };
		if (type === 'post') {
			const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
			if (!row) return { error: 'not_found' };
			return {
				id: row.id,
				title: row.title,
				slug: row.slug,
				status: row.status,
				lang: row.lang,
				updatedAt: row.updatedAt,
				content: truncate(row.content, 12_000)
			};
		}
		if (type === 'note') {
			const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
			if (!row) return { error: 'not_found' };
			return {
				id: row.id,
				title: row.title,
				slug: row.slug,
				status: row.status,
				lang: row.lang,
				updatedAt: row.updatedAt,
				content: truncate(row.content, 12_000)
			};
		}
		if (type === 'moment') {
			const [row] = await db.select().from(moments).where(eq(moments.id, id)).limit(1);
			if (!row) return { error: 'not_found' };
			return {
				id: row.id,
				type: row.type,
				createdAt: row.createdAt,
				content: truncate(row.content, 4_000)
			};
		}
		return { error: 'unknown_type' };
	}
};

const listAiUsage: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'list_ai_usage',
			description: 'Recent model calls with task, provider, model, status and estimated cost.',
			parameters: {
				type: 'object',
				properties: {
					days: { type: 'number', description: 'Lookback window, default 30.' },
					limit: { type: 'number', description: 'Max rows, default 20.' }
				},
				additionalProperties: false
			}
		}
	},
	execute: async (args) => {
		const days = numberArg(args, 'days', 30);
		const limit = numberArg(args, 'limit', 20);
		const since = new Date(Date.now() - days * 86_400_000);
		const rows = await db
			.select({
				createdAt: aiUsage.createdAt,
				task: aiUsage.task,
				provider: aiUsage.provider,
				model: aiUsage.model,
				status: aiUsage.status,
				trigger: aiUsage.trigger,
				actorId: aiUsage.actorId,
				costEstimate: aiUsage.costEstimate
			})
			.from(aiUsage)
			.where(gte(aiUsage.createdAt, since))
			.orderBy(desc(aiUsage.createdAt))
			.limit(limit);
		return { days, rows };
	}
};

const getJobStatus: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'get_job_status',
			description: 'Recent job runs with status, timing and the sanitized error.',
			parameters: {
				type: 'object',
				properties: { limit: { type: 'number' } },
				additionalProperties: false
			}
		}
	},
	execute: async (args) => {
		const limit = numberArg(args, 'limit', 10);
		const rows = await db
			.select({
				job: jobRuns.job,
				status: jobRuns.status,
				trigger: jobRuns.trigger,
				startedAt: jobRuns.startedAt,
				finishedAt: jobRuns.finishedAt,
				error: jobRuns.error
			})
			.from(jobRuns)
			.orderBy(desc(jobRuns.createdAt))
			.limit(limit);
		return { rows };
	}
};

const validateMarkdown: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'validate_markdown',
			description:
				'Validate markdown against the site parser. Returns ok or the parser error; never writes.',
			parameters: {
				type: 'object',
				properties: { markdown: { type: 'string' } },
				required: ['markdown'],
				additionalProperties: false
			}
		}
	},
	execute: async (args) => {
		const markdown = typeof args.markdown === 'string' ? args.markdown : '';
		if (markdown.length > 24_000) return { ok: false, error: 'too_long' };
		try {
			await renderMarkdownToHtml(markdown);
			return { ok: true };
		} catch (caught) {
			return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
		}
	}
};

const proposeSettingChange: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'propose_setting_change',
			description:
				'Propose a settings change for human confirmation. Does not write; returns a proposal id, before/after and expiry. Tier 2 keys are owner-only.',
			parameters: {
				type: 'object',
				properties: {
					key: { type: 'string', description: 'Allowlisted setting key.' },
					value: { description: 'New JSON value for that key.' }
				},
				required: ['key', 'value'],
				additionalProperties: false
			}
		}
	},
	execute: async (args, ctx) => {
		const key = text(args, 'key');
		if (!(SETTING_KEYS as readonly string[]).includes(key)) {
			return { error: 'not_allowlisted' };
		}
		const denial = agentWriteDenial(key, ctx.role);
		if (denial) return { error: denial };
		const tier = agentSettingTier(key);
		const before = await getOption(key as never);
		let after: unknown;
		try {
			after = validateOption(key as never, args.value);
		} catch (caught) {
			return {
				error: 'invalid_value',
				message: caught instanceof Error ? caught.message : String(caught)
			};
		}
		const argsHash = createHash('sha256')
			.update(JSON.stringify({ key, before, after }))
			.digest('hex');
		const expiresAt = new Date(Date.now() + 15 * 60_000);
		const [row] = await db
			.insert(aiAgentProposals)
			.values({
				conversationId: ctx.conversationId,
				actorId: ctx.actorId,
				settingKey: key,
				before,
				after,
				argsHash,
				expiresAt
			})
			.returning({ id: aiAgentProposals.id });
		return {
			proposalId: row.id,
			key,
			tier,
			before,
			after,
			expiresAt: expiresAt.toISOString(),
			status: 'pending_confirmation'
		};
	}
};

const DRAFT_TYPES = ['post', 'note', 'moment'] as const;
const LANGS = ['en', 'zh-cn', 'ja'] as const;

function draftLang(args: Record<string, unknown>): string {
	const value = text(args, 'lang');
	return (LANGS as readonly string[]).includes(value) ? value : 'en';
}

const createDraft: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'create_draft',
			description:
				'Create a draft only (post, note or moment). Never publishes. Posts use the first category unless categoryId is given.',
			parameters: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['post', 'note', 'moment'] },
					title: { type: 'string' },
					content: { type: 'string' },
					lang: { type: 'string', enum: ['en', 'zh-cn', 'ja'] },
					categoryId: { type: 'string', description: 'Post category id (optional).' },
					kind: {
						type: 'string',
						enum: ['life', 'tech', 'media', 'other'],
						description: 'Moment kind, default life.'
					}
				},
				required: ['type', 'title'],
				additionalProperties: false
			}
		}
	},
	execute: async (args, ctx) => {
		const type = text(args, 'type');
		const title = text(args, 'title');
		const content = typeof args.content === 'string' ? args.content : '';
		if (!(DRAFT_TYPES as readonly string[]).includes(type)) return { error: 'unknown_type' };
		if (type !== 'moment' && !title) return { error: 'title_required' };

		if (type === 'post') {
			let categoryId = text(args, 'categoryId');
			if (!categoryId) {
				const [first] = await db.select({ id: categories.id }).from(categories).limit(1);
				categoryId = first?.id ?? '';
			}
			if (!categoryId) return { error: 'category_required' };
			const result = await saveDraftWork({
				payload: {
					title,
					slug: '',
					categoryId,
					summary: '',
					tags: '',
					content,
					provenance: null
				},
				lang: draftLang(args),
				author: ctx.actorId,
				autosave: false
			});
			if (result.kind !== 'saved' && result.kind !== 'unchanged') {
				return { error: result.kind };
			}
			return {
				type,
				draftId: result.draftId,
				postId: result.postId,
				editHref: `/admin/posts/edit?id=${result.postId}`
			};
		}

		if (type === 'note') {
			const result = await saveNoteDraftWork({
				payload: {
					title,
					slug: '',
					topicId: '',
					mood: '',
					weatherCode: null,
					temperatureC: null,
					latitude: '',
					longitude: '',
					location: '',
					content
				},
				lang: draftLang(args),
				author: ctx.actorId,
				autosave: false
			});
			if (result.kind !== 'saved' && result.kind !== 'unchanged') {
				return { error: result.kind };
			}
			return {
				type,
				draftId: result.draftId,
				noteId: result.noteId,
				editHref: `/admin/notes/edit?id=${result.noteId}`
			};
		}

		const kind = text(args, 'kind');
		const momentType = ['life', 'tech', 'media', 'other'].includes(kind) ? kind : 'life';
		const [row] = await db
			.insert(moments)
			.values({ content, type: momentType })
			.returning({ id: moments.id });
		return { type, id: row.id, editHref: `/admin/moments/edit?id=${row.id}` };
	}
};

const updateDraft: AgentTool = {
	definition: {
		type: 'function',
		function: {
			name: 'update_draft',
			description:
				'Update an existing draft (post/note by content id, moment by id). Draft-only; published content is never touched.',
			parameters: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['post', 'note', 'moment'] },
					id: { type: 'string', description: 'Post/note/moment id.' },
					title: { type: 'string' },
					content: { type: 'string' }
				},
				required: ['type', 'id'],
				additionalProperties: false
			}
		}
	},
	execute: async (args, ctx) => {
		const type = text(args, 'type');
		const id = text(args, 'id');
		if (!id) return { error: 'missing_id' };
		if (type === 'post') {
			const row = await loadDraftByPostId(id);
			if (!row) return { error: 'no_draft' };
			const result = await saveDraftWork({
				draftId: row.id,
				payload: {
					title: text(args, 'title') || row.title,
					slug: row.slug ?? '',
					categoryId: row.categoryId ?? '',
					summary: row.summary ?? '',
					tags: (row.tags ?? []).join(','),
					content: typeof args.content === 'string' ? args.content : (row.content ?? ''),
					provenance: postProvenanceFromPayload(row.payload)
				},
				author: ctx.actorId,
				autosave: false
			});
			if (result.kind !== 'saved' && result.kind !== 'unchanged') return { error: result.kind };
			return { type, draftId: result.draftId, postId: result.postId };
		}
		if (type === 'note') {
			const row = await loadNoteDraftByNoteId(id);
			if (!row) return { error: 'no_draft' };
			const result = await saveNoteDraftWork({
				draftId: row.id,
				payload: {
					title: text(args, 'title') || row.title,
					slug: row.slug ?? '',
					topicId: row.topicId ?? '',
					mood: row.mood ?? '',
					weatherCode: row.weatherCode,
					temperatureC: row.temperatureC,
					latitude: row.coordinates?.latitude?.toString() ?? '',
					longitude: row.coordinates?.longitude?.toString() ?? '',
					location: row.location ?? '',
					content: typeof args.content === 'string' ? args.content : (row.content ?? '')
				},
				author: ctx.actorId,
				autosave: false
			});
			if (result.kind !== 'saved' && result.kind !== 'unchanged') return { error: result.kind };
			return { type, draftId: result.draftId, noteId: result.noteId };
		}
		if (type === 'moment') {
			const content = typeof args.content === 'string' ? args.content : '';
			if (!content.trim()) return { error: 'content_required' };
			const updated = await db
				.update(moments)
				.set({ content })
				.where(eq(moments.id, id))
				.returning({ id: moments.id });
			if (updated.length === 0) return { error: 'not_found' };
			return { type, id: updated[0].id };
		}
		return { error: 'unknown_type' };
	}
};

export const AGENT_TOOLS: AgentTool[] = [
	getSiteOverview,
	getSettings,
	listContent,
	getContent,
	listAiUsage,
	getJobStatus,
	validateMarkdown,
	proposeSettingChange,
	createDraft,
	updateDraft
];

export const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = AGENT_TOOLS.map(
	(tool) => tool.definition
);

export function agentTool(name: string): AgentTool | null {
	return AGENT_TOOLS.find((tool) => tool.definition.function.name === name) ?? null;
}
