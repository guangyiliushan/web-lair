/**
 * Deploy lifecycle: ops commands that run in a fixed order on the host or in
 * the image.
 *
 * Lives under scripts/ rather than deploy/ because the runtime image only
 * copies `scripts/` and `bin/` (deploy/ holds ops docs and backup env files
 * and must not ship), and `bin/lair deploy ...` has to work in the container.
 *
 * Only manifest entries with runtime=node may be referenced here: the image has
 * no tsx, and scripts/check-entries.ts enforces that as a CI gate.
 *
 * Ordering:
 *   pre  - before the migration (schema changes)
 *   post - after the migration, before the app restarts (idempotent repairs and gates)
 *
 * One-shot backfills are deliberately excluded: they need a human `--apply` decision.
 */

export interface DeployHook {
	/** `<group> <name>` from the manifest */
	command: string;
	/** Why this step exists */
	note: string;
}

export const DEPLOY_HOOKS: { pre: DeployHook[]; post: DeployHook[] } = {
	pre: [
		{ command: 'db migrate-prod', note: '执行 drizzle 迁移；旧库预检失败会指向 RUNBOOK 重建节' }
	],
	post: [
		{ command: 'db verify-baseline', note: '基线与目标库 inventory 对账（只读）' },
		{ command: 'site ensure-categories', note: '确保兜底分类存在，避免新建文章撞 NOT NULL' },
		{ command: 'site ensure-schedules', note: '空 job_schedules 时 drain 每分钟空转' },
		{ command: 'db verify-suppression-version', note: '退订哈希版本闸门（合规）' }
	]
};
