import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { formatDate, formatDateTime } from '$lib/utils/i18n';
import { isUuid } from '$lib/utils/uuid';
import { isProjectProvider, isProjectStatus, type ProjectStatus } from '$lib/utils/project-meta';
import {
	ProjectsServiceError,
	createProject,
	deleteProjects,
	enqueueSync,
	getProject,
	getSyncTargets,
	importPrefill,
	latestSyncRun,
	listProjects,
	moveProject,
	projectCounts,
	setProjectStatus,
	setSyncTargets,
	updateProjectFields
} from '$lib/server/projects/service';
import type { PageServerLoad, Actions } from './$types';

/**
 * Admin projects surface (plan §4, batch A): the real review queue replacing
 * the mockup. Load = tabs + counts + target list + the latest sync run +
 * streamed rows; actions cover the four-value state machine (single + bulk),
 * field edits (write-side URL scheme guard in the service), transactional
 * reordering, create, delete, the URL-import prefill and the target editor.
 * Same contract as the C3 admin pages: requireAdminRole first, uuid entry
 * guards, explicit 400s, unknown ids answer 404 through the service probe.
 */
export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const statusParam = url.searchParams.get('status') ?? 'all';
	const filter: ProjectStatus | 'all' = isProjectStatus(statusParam) ? statusParam : 'all';
	const [siteTz, counts, targets, lastRun] = await Promise.all([
		getOption('site.timezone'),
		projectCounts(),
		getSyncTargets(),
		latestSyncRun()
	]);
	const rows = listProjects(filter).then((items) =>
		items.map((item) => ({
			...item,
			pushedLabel: item.pushedAt ? formatDate(item.pushedAt, { timeZone: siteTz }) : null,
			syncedLabel: item.lastSyncedAt
				? formatDateTime(item.lastSyncedAt, { timeZone: siteTz })
				: null
		}))
	);
	const focusId = url.searchParams.get('id');
	const focusRow = focusId && isUuid(focusId) ? await getProject(focusId) : null;
	return {
		headerTitle: '项目',
		filter,
		counts,
		targets,
		lastRun: lastRun
			? {
					...lastRun,
					createdLabel: formatDateTime(lastRun.createdAt, { timeZone: siteTz }),
					finishedLabel: lastRun.finishedAt
						? formatDateTime(lastRun.finishedAt, { timeZone: siteTz })
						: null
				}
			: null,
		focusRow,
		rows
	};
};

function text(form: FormData, name: string): string | null {
	const value = form.get(name);
	if (value === null) return null;
	const stringValue = value.toString();
	return stringValue.length === 0 ? null : stringValue;
}

const SERVICE_ERROR_TEXT: Record<string, string> = {
	'name-required': '名称为必填项',
	'url-required': '主链接为必填项',
	'bad-url': '链接必须是 http(s) 地址',
	'external-id-required': '仓库导入缺少平台 ID（请使用「从链接导入」）',
	'identity-mismatch': '仓库链接与所选平台不匹配',
	duplicate: '已存在相同链接或仓库',
	busy: '操作繁忙，请重试',
	missing: '项目不存在'
};

function serviceFail(err: unknown) {
	if (err instanceof ProjectsServiceError) {
		if (err.code === 'busy') return fail(409, { error: SERVICE_ERROR_TEXT.busy });
		return fail(err.code === 'not_found' ? 404 : 400, {
			error: SERVICE_ERROR_TEXT[err.message] ?? '操作失败'
		});
	}
	throw err;
}

const IMPORT_ERROR_TEXT: Record<string, string> = {
	'invalid-url': '链接无效（需要 https 地址）',
	blocked: '该地址不允许抓取',
	not_found: '未找到该页面或仓库（404）',
	rate_limited: '平台限流，请稍后再试',
	auth: '平台认证失败',
	network: '网络错误，请稍后再试',
	parse: '页面格式无法解析'
};

async function editFieldsFrom(form: FormData) {
	return {
		name: text(form, 'name') ?? '',
		description: text(form, 'description'),
		projectUrl: text(form, 'projectUrl') ?? '',
		previewUrl: text(form, 'previewUrl'),
		docUrl: text(form, 'docUrl'),
		avatar: text(form, 'avatar')
	};
}

function idsFrom(form: FormData): string[] {
	const ids = form
		.getAll('ids')
		.map((value) => value.toString())
		.filter(isUuid);
	return ids;
}

export const actions: Actions = {
	sync: async () => {
		await requireAdminRole();
		// Scenario #1 (§0.1): no targets configured -> steer the admin to the
		// target editor instead of queueing a guaranteed-empty run.
		const targets = await getSyncTargets();
		if (targets.length === 0) {
			return fail(400, { error: '请先在「同步目标」中添加至少一个账号' });
		}
		const { deduplicated } = await enqueueSync();
		return { success: true, flash: deduplicated ? 'sync-dedup' : 'sync-queued' };
	},

	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const providerRaw = (form.get('provider') ?? 'site').toString();
		if (!isProjectProvider(providerRaw)) {
			return fail(400, { error: '未知的项目类型' });
		}
		try {
			const { id } = await createProject({
				...(await editFieldsFrom(form)),
				provider: providerRaw,
				externalId: text(form, 'externalId'),
				fullName: text(form, 'fullName')
			});
			return { success: true, flash: 'created', createdId: id };
		} catch (err) {
			return serviceFail(err);
		}
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少项目 ID' });
		try {
			await updateProjectFields(id, await editFieldsFrom(form));
			return { success: true, flash: 'updated' };
		} catch (err) {
			return serviceFail(err);
		}
	},

	setStatus: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const ids = idsFrom(form);
		if (ids.length === 0) return fail(400, { error: '未选择项目' });
		const to = (form.get('to') ?? '').toString();
		if (!isProjectStatus(to)) return fail(400, { error: '未知的目标状态' });
		const { updated, skipped } = await setProjectStatus(ids, to);
		return { success: true, flash: 'status-changed', updated, skipped };
	},

	reorder: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少项目 ID' });
		const move = (form.get('move') ?? '').toString();
		if (move !== 'up' && move !== 'down' && move !== 'top') {
			return fail(400, { error: '未知的排序动作' });
		}
		try {
			await moveProject(id, move);
			return { success: true };
		} catch (err) {
			return serviceFail(err);
		}
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const single = (form.get('id') ?? '').toString();
		const ids = idsFrom(form);
		if (single && isUuid(single)) ids.push(single);
		if (ids.length === 0) return fail(400, { error: '未选择项目' });
		const deleted = await deleteProjects(ids);
		if (deleted === 0) return fail(404, { error: '项目不存在' });
		return { success: true, flash: 'deleted', deleted };
	},

	import: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const url = (form.get('url') ?? '').toString().trim();
		if (!url) return fail(400, { error: '请输入链接' });
		const result = await importPrefill(url);
		if (!result.ok) {
			return fail(400, { error: IMPORT_ERROR_TEXT[result.reason] ?? '抓取失败' });
		}
		return { success: true, importResult: result.prefill };
	},

	targets: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const targets: { provider: string; account: string }[] = [];
		for (let index = 0; ; index += 1) {
			const provider = form.get(`provider_${index}`);
			if (provider === null) break;
			targets.push({
				provider: provider.toString(),
				account: (form.get(`account_${index}`) ?? '').toString()
			});
		}
		try {
			await setSyncTargets(targets as Awaited<ReturnType<typeof getSyncTargets>>);
			return { success: true, flash: 'targets-saved' };
		} catch (err) {
			// Only registry validation failures are user-fixable; anything else
			// (db down, ...) must surface honestly (review).
			if (err instanceof ZodError) {
				return fail(400, {
					error: '同步目标校验失败：账号不能为空，同一平台账号不可重复'
				});
			}
			throw err;
		}
	}
};
