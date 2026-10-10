import { fail } from '@sveltejs/kit';
import { and, desc, eq, like, or } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activities, jobRuns } from '$lib/server/db/system';
import { requireAdminRole } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { getOption } from '$lib/server/config/options-registry';
import { isUuid } from '$lib/utils/uuid';
import { formatDateTime } from '$lib/utils/i18n';
import { resolveDataDir } from '$lib/server/jobs/data-dir';
import { listScripts } from '$lib/server/jobs/job-scripts';
import {
	createSchedule,
	deleteSchedule,
	listSchedules,
	toggleSchedule,
	updateSchedule
} from '$lib/server/jobs/job-schedules';
import { enqueueJob } from '$lib/server/jobs/queue';
import { sanitizeErrorText } from '$lib/server/jobs/error-text';
import { resolveJobDefinition } from '$lib/server/jobs/user-layer';
import { RUN_STATUSES } from './maintenance-form-utils';
import type { PageServerLoad, Actions } from './$types';

/**
 * /admin/maintenance (J-3, plan §5.7): the jobs platform surface. Loads the
 * three regions - scripts (registry ∪ user layer), the run ledger, and the
 * job/schedule audit trail - plus the latest jobs.typecheck summary. Actions
 * cover manual runs ("立即执行" / "运行类型检查") and the schedule CRUD; the
 * editor/fork/revert/save actions live on the [name] route (§5.6 lazy import).
 */

const RUN_PAGE_SIZE = 100;
const AUDIT_PAGE_SIZE = 40;

/** Shape `jobs.typecheck` stores into `job_runs.result` (bounded issues). */
interface TypecheckSummaryResult {
	ok?: boolean;
	files?: number;
	errors?: number;
	issues?: { file: string; line: number | null; column: number | null; message: string }[];
	timedOut?: boolean;
	runnerError?: string | null;
}

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const dataDir = resolveDataDir();
	const siteTz = await getOption('site.timezone');
	const jobFilter = (url.searchParams.get('job') ?? '').trim();
	const statusFilter = (url.searchParams.get('status') ?? '').trim();
	const statusIsValid = (RUN_STATUSES as readonly string[]).includes(statusFilter);

	const [scripts, schedules, runs, typecheckRows, activityRows] = await Promise.all([
		listScripts(dataDir),
		listSchedules(db),
		db
			.select({
				id: jobRuns.id,
				job: jobRuns.job,
				trigger: jobRuns.trigger,
				status: jobRuns.status,
				createdAt: jobRuns.createdAt,
				startedAt: jobRuns.startedAt,
				finishedAt: jobRuns.finishedAt,
				sourceHash: jobRuns.sourceHash,
				result: jobRuns.result,
				error: jobRuns.error
			})
			.from(jobRuns)
			.where(
				and(
					jobFilter ? eq(jobRuns.job, jobFilter) : undefined,
					statusIsValid ? eq(jobRuns.status, statusFilter) : undefined
				)
			)
			.orderBy(desc(jobRuns.createdAt))
			.limit(RUN_PAGE_SIZE + 1),
		db
			.select({
				id: jobRuns.id,
				status: jobRuns.status,
				createdAt: jobRuns.createdAt,
				error: jobRuns.error,
				result: jobRuns.result
			})
			.from(jobRuns)
			.where(eq(jobRuns.job, 'jobs.typecheck'))
			.orderBy(desc(jobRuns.createdAt))
			.limit(1),
		db
			.select({
				id: activities.id,
				createdAt: activities.createdAt,
				event: activities.event,
				payload: activities.payload
			})
			.from(activities)
			.where(or(like(activities.event, 'job.%'), like(activities.event, 'schedule.%')))
			.orderBy(desc(activities.createdAt))
			.limit(AUDIT_PAGE_SIZE + 1)
	]);

	// N+1 probe surfaces truncation without a count query (J-3 review P2-2).
	const runsTruncated = runs.length > RUN_PAGE_SIZE;
	const auditTruncated = activityRows.length > AUDIT_PAGE_SIZE;
	const visibleRuns = runsTruncated ? runs.slice(0, RUN_PAGE_SIZE) : runs;
	const visibleActivities = auditTruncated ? activityRows.slice(0, AUDIT_PAGE_SIZE) : activityRows;

	const typecheckRow = typecheckRows[0];
	return {
		headerTitle: '维护',
		siteTz,
		runsTruncated,
		auditTruncated,
		runPageSize: RUN_PAGE_SIZE,
		auditPageSize: AUDIT_PAGE_SIZE,
		filters: { job: jobFilter, status: statusIsValid ? statusFilter : '' },
		scripts,
		schedules: schedules.map((row) => ({
			...row,
			lastDueLabel: row.lastDueAt ? formatDateTime(row.lastDueAt, { timeZone: siteTz }) : null
		})),
		runs: visibleRuns.map((row) => ({
			...row,
			createdLabel: formatDateTime(row.createdAt, { timeZone: siteTz })
		})),
		typecheck: typecheckRow
			? {
					id: typecheckRow.id,
					status: typecheckRow.status,
					createdLabel: formatDateTime(typecheckRow.createdAt, { timeZone: siteTz }),
					summary: (typecheckRow.result ?? null) as TypecheckSummaryResult | null,
					error: typecheckRow.error
				}
			: null,
		activities: visibleActivities.map((row) => ({
			...row,
			createdLabel: formatDateTime(row.createdAt, { timeZone: siteTz })
		}))
	};
};

export const actions: Actions = {
	/** 手动排队一次（plan §4.4，试运行同路径；唯一索引去重）。 */
	run: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: '缺少任务名' });
		const dataDir = resolveDataDir();
		const definition = await resolveJobDefinition(name, dataDir);
		if (!definition) return fail(404, { error: `未知的任务：${name}` });
		if (!definition.manual) return fail(400, { error: '该任务不允许手动执行' });
		let queued;
		try {
			queued = await enqueueJob(db, name, 'manual', definition);
		} catch (error) {
			// manual=false and 23505 storms throw - answer 400 with a
			// sanitized message and keep the platform log entry (J-3 review
			// R4-2: an unlogged echo left failures invisible everywhere).
			console.error('[jobs] manual enqueue failed', error);
			return fail(400, { error: sanitizeErrorText(error) });
		}
		// Audit after the enqueue (same call path, not same transaction - the
		// F-4 window the J-2 review registered; a retry dedupes via 23505).
		await recordActivity(db, {
			event: 'job.run',
			actorId: locals.user?.id ?? null,
			payload: { name, trigger: 'manual', deduplicated: queued.deduplicated }
		});
		return { queued: true, name, deduplicated: queued.deduplicated };
	},

	/** 运行类型检查（enqueue `jobs.typecheck`）。 */
	typecheck: async ({ locals }) => {
		await requireAdminRole();
		let queued;
		try {
			queued = await enqueueJob(db, 'jobs.typecheck', 'manual');
		} catch (error) {
			// manual=false throws and a 23505 storm throws lastError - both
			// must answer 400, not a 500 form page (J-3 review J3-3);
			// sanitized + logged (J-3 review R4-2).
			console.error('[jobs] manual enqueue failed', error);
			return fail(400, { error: sanitizeErrorText(error) });
		}
		await recordActivity(db, {
			event: 'job.run',
			actorId: locals.user?.id ?? null,
			payload: { name: 'jobs.typecheck', trigger: 'manual', deduplicated: queued.deduplicated }
		});
		return { queued: true, name: 'jobs.typecheck', deduplicated: queued.deduplicated };
	},

	scheduleCreate: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const job = (form.get('job') ?? '').toString().trim();
		if (!job) return fail(400, { error: '缺少任务名' });
		const cronExpr = (form.get('cron_expr') ?? '').toString();
		const tz = (form.get('tz') ?? '').toString().trim() || (await getOption('site.timezone'));
		const result = await createSchedule({
			db,
			dataDir: resolveDataDir(),
			job,
			cronExpr,
			tz,
			actorId: locals.user?.id ?? null
		});
		if (result.kind === 'invalid') return fail(400, { error: result.message });
		if (result.kind === 'unknown-job') return fail(404, { error: result.message });
		if (result.kind === 'duplicate') return fail(409, { error: '该任务已有一条相同 cron 的调度' });
		return { scheduleChanged: true, scheduleAction: 'create' as const };
	},

	scheduleUpdate: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少有效的调度 ID' });
		const cronExpr = (form.get('cron_expr') ?? '').toString();
		const tz = (form.get('tz') ?? '').toString().trim() || (await getOption('site.timezone'));
		const result = await updateSchedule({ db, id, cronExpr, tz, actorId: locals.user?.id ?? null });
		if (result.kind === 'invalid') return fail(400, { error: result.message });
		if (result.kind === 'duplicate') return fail(409, { error: '该任务已有一条相同 cron 的调度' });
		if (result.kind === 'not-found') return fail(404, { error: '调度不存在' });
		return {
			scheduleChanged: true,
			scheduleAction: 'update' as const,
			watermarkReset: result.watermarkReset
		};
	},

	scheduleToggle: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少有效的调度 ID' });
		const enabledRaw = (form.get('enabled') ?? '').toString();
		if (enabledRaw !== 'true' && enabledRaw !== 'false')
			return fail(400, { error: '缺少有效的调度状态' });
		const result = await toggleSchedule({
			db,
			id,
			enabled: enabledRaw === 'true',
			actorId: locals.user?.id ?? null
		});
		if (result.kind === 'not-found') return fail(404, { error: '调度不存在' });
		if (result.kind === 'stale') return fail(409, { error: '调度状态已变化，请刷新页面后重试' });
		return { scheduleChanged: true, scheduleAction: 'toggle' as const, enabled: result.enabled };
	},

	scheduleDelete: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!id || !isUuid(id)) return fail(400, { error: '缺少有效的调度 ID' });
		const result = await deleteSchedule({ db, id, actorId: locals.user?.id ?? null });
		if (result.kind === 'not-found') return fail(404, { error: '调度不存在' });
		return { scheduleChanged: true, scheduleAction: 'delete' as const };
	}
};
