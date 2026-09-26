import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { aiProviders } from '$lib/server/db/ai';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { requireAdminRole } from '$lib/server/authz';
import { AI_FUNCTIONS, getOption, setOption } from '$lib/server/config/options-registry';
import {
	parseProviderForm,
	providerFieldErrors,
	providerInputSchema,
	testProviderConnection
} from '$lib/server/services/ai-providers';
import type { AiProviderKind } from '$lib/utils/ai-meta';
import type { PageServerLoad, Actions } from './$types';

function firstIssueMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	const key = issue.path.join('.');
	return key ? `${key}：${issue.message}` : issue.message;
}

/**
 * AI settings (ai-line plan §5.2): providers CRUD, feature assignments and
 * the switches/thresholds block. All three sections persist through the
 * options registry (validated writes) except providers, which live in
 * `ai_providers`; keys are only ever shown by NAME (env var), never stored.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	const [providers, assignments, moderation, budget, styleGuide] = await Promise.all([
		db.select().from(aiProviders).orderBy(aiProviders.name),
		getOption('ai.assignments'),
		getOption('comments.moderation'),
		getOption('ai.budget'),
		getOption('ai.styleGuide')
	]);
	return {
		headerTitle: 'AI 设定',
		providers,
		assignments,
		moderation,
		budget,
		styleGuide,
		// Presence of the env var, not the secret - the UI only shows the name.
		envSet: Object.fromEntries(
			providers.map((p) => [p.id, p.apiKeyEnv ? Boolean(env[p.apiKeyEnv]) : null])
		)
	};
};

export const actions: Actions = {
	saveProvider: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString().trim();
		const parsed = providerInputSchema.safeParse(parseProviderForm(form));
		if (!parsed.success) {
			return fail(400, {
				message: '请检查表单',
				providerErrors: providerFieldErrors(parsed.error)
			});
		}
		try {
			if (id) {
				const updated = await db
					.update(aiProviders)
					.set(parsed.data)
					.where(eq(aiProviders.id, id))
					.returning({ id: aiProviders.id });
				if (updated.length === 0) return fail(404, { message: '服务商不存在' });
				return { message: '服务商已更新' };
			}
			await db.insert(aiProviders).values(parsed.data);
			return { message: '服务商已创建' };
		} catch (caught) {
			if (pgErrorCode(caught) === '23505') {
				return fail(400, { message: '名称已存在', providerErrors: { name: '名称已存在' } });
			}
			throw caught;
		}
	},

	deleteProvider: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id) return fail(400, { message: '缺少服务商' });
		const deleted = await db
			.delete(aiProviders)
			.where(eq(aiProviders.id, id))
			.returning({ name: aiProviders.name });
		if (deleted.length === 0) return fail(404, { message: '服务商不存在' });
		// Drop the provider from assignments so nothing points at a ghost.
		const assignments = await getOption('ai.assignments');
		const next = Object.fromEntries(
			Object.entries(assignments).filter(([, value]) => value?.provider !== deleted[0].name)
		);
		if (Object.keys(next).length !== Object.keys(assignments).length) {
			await setOption('ai.assignments', next);
			return { message: `已删除 ${deleted[0].name}（并移除相关功能位分配）` };
		}
		return { message: `已删除 ${deleted[0].name}` };
	},

	testProvider: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		const [provider] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
		if (!provider) return fail(404, { message: '服务商不存在' });
		// Drizzle types the text column as string; the CHECK pins the enum.
		const result = await testProviderConnection(
			{
				kind: provider.kind as AiProviderKind,
				baseUrl: provider.baseUrl,
				apiKeyEnv: provider.apiKeyEnv
			},
			(name) => env[name]
		);
		// A failed check is a normal payload (it is a report, not an error).
		return { providerTest: { id, name: provider.name, ...result } };
	},

	saveAssignments: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const providers = await db.select({ name: aiProviders.name }).from(aiProviders);
		const names = new Set(providers.map((p) => p.name));
		const next: Record<string, { provider?: string; model?: string }> = {};
		for (const fn of AI_FUNCTIONS) {
			const provider = (form.get(`assign_${fn}`) ?? '').toString().trim();
			const model = (form.get(`model_${fn}`) ?? '').toString().trim();
			if (!provider) continue;
			if (!names.has(provider)) return fail(400, { message: `未知服务商：${provider}` });
			next[fn] = { provider, ...(model ? { model } : {}) };
		}
		try {
			await setOption('ai.assignments', next);
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: '功能位分配已保存' };
	},

	saveModeration: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const num = (key: string) => Number((form.get(key) ?? '').toString());
		const lines = (key: string) =>
			(form.get(key) ?? '')
				.toString()
				.split('\n')
				.map((s) => s.trim())
				.filter(Boolean);
		const linkThreshold = num('linkThreshold');
		const allow = num('allow');
		const block = num('block');
		if (!Number.isInteger(linkThreshold) || linkThreshold < 0) {
			return fail(400, { message: '链接数阈值必须是不小于 0 的整数' });
		}
		if (!(Number.isFinite(allow) && allow >= 0 && allow <= 1)) {
			return fail(400, { message: '放行阈值必须在 0–1 之间' });
		}
		if (!(Number.isFinite(block) && block >= 0 && block <= 1)) {
			return fail(400, { message: '拦截阈值必须在 0–1 之间' });
		}
		const regexes = lines('regexes');
		for (const pattern of regexes) {
			try {
				new RegExp(pattern);
			} catch {
				return fail(400, { message: `正则无效：${pattern}` });
			}
		}
		try {
			await setOption('comments.moderation', {
				enabled: form.get('enabled') !== null,
				shadowMode: form.get('shadowMode') !== null,
				keywords: lines('keywords'),
				regexes,
				linkThreshold,
				firstCommentHold: form.get('firstCommentHold') !== null,
				trustedUsers: lines('trustedUsers'),
				thresholds: { allow, block }
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: '审核设置已保存' };
	},

	saveBudget: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const monthly = Number((form.get('monthly') ?? '0').toString());
		if (!Number.isFinite(monthly) || monthly < 0) {
			return fail(400, { message: '月度预算必须是不小于 0 的数字' });
		}
		const alertRatios = (form.get('alertRatios') ?? '')
			.toString()
			.split(',')
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isFinite(n));
		if (alertRatios.some((r) => r <= 0 || r > 10)) {
			return fail(400, { message: '告警比例应为小数（如 0.8, 0.9, 1）' });
		}
		try {
			await setOption('ai.budget', {
				monthly,
				currency: (form.get('currency') ?? '').toString().trim() || 'USD',
				alertRatios: alertRatios.length ? alertRatios : [0.8, 0.9, 1],
				pauseAutoOnExceed: form.get('pauseAutoOnExceed') !== null
			});
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: '预算设置已保存' };
	},

	saveStyleGuide: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		try {
			await setOption('ai.styleGuide', { text: (form.get('text') ?? '').toString() });
		} catch (caught) {
			if (caught instanceof z.ZodError) return fail(400, { message: firstIssueMessage(caught) });
			throw caught;
		}
		return { message: '风格指南已保存' };
	}
} satisfies Actions;
