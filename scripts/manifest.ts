/**
 * Ops entry manifest: the single source of truth.
 *
 * Each entry is a command that can run on the host or inside the container.
 * Any `scripts/**` file not listed here is an internal implementation detail,
 * not an entry point.
 *
 * `runtime` is a property of the import closure, not a style preference:
 *   node - relative imports carry an explicit `.ts`; the closure contains no
 *          `$lib`/`$app`, so the runtime image (which has no tsx) can run it.
 *   tsx  - the closure reaches `$lib` or uses extensionless imports; it can only
 *          run on a host that has devDependencies installed.
 *
 * `env` selects how environment variables are supplied (only when the repo root
 * has a `.env` and `DATABASE_URL` is not already set - see scripts/cli.ts):
 *   required - `--env-file=.env`
 *   optional - `--env-file-if-exists=.env`
 *   none     - do not load
 *
 * When `mutates` is true the runner prints the target database (credentials
 * stripped) before spawning. `dryRun` marks scripts that default to a dry run
 * and need `--apply` to write; the runner never changes script semantics.
 */

export type Runtime = 'node' | 'tsx';
export type EnvMode = 'required' | 'optional' | 'none';

export interface Entry {
	/** Group; the first segment of `lair <group> <name>` */
	group: string;
	/** Command name, unique within the group */
	name: string;
	/** Repo-relative POSIX path */
	file: string;
	runtime: Runtime;
	env: EnvMode;
	/** One line for --list */
	summary: string;
	/** Writes to the database or object storage */
	mutates: boolean;
	/** Defaults to a dry run; needs --apply */
	dryRun?: boolean;
	/** Destructive: deletes data or revokes credentials */
	danger?: boolean;
}

export const GROUPS: { id: string; title: string }[] = [
	{ id: 'db', title: '数据库：迁移、基线闸门、一次性回填' },
	{ id: 'site', title: '站点：初始化、修复、身份恢复' },
	{ id: 'jobs', title: '任务队列：drain、维护、验收' },
	{ id: 'media', title: '媒体：导入、审计、清理、验收' },
	{ id: 'storage', title: '对象存储：provider 迁移与冒烟' },
	{ id: 'secrets', title: '密钥：告警与轮换校验' },
	{ id: 'maps', title: '地图：PMTiles 发布' },
	{ id: 'dev', title: '开发辅助：质量门、演示数据、e2e 夹具' }
];

export const ENTRIES: Entry[] = [
	// --- db -----------------------------------------------------------------
	{
		group: 'db',
		name: 'migrate-prod',
		file: 'scripts/migrate.ts',
		runtime: 'node',
		env: 'optional',
		summary: '运行时迁移执行器（容器/宿主的生产路径；开发用 pnpm db:migrate）',
		mutates: true
	},
	{
		group: 'db',
		name: 'verify-baseline',
		file: 'scripts/verify-baseline.ts',
		runtime: 'node',
		env: 'optional',
		summary: '基线 SQL 契约 + 目标库 inventory（无 DATABASE_URL 时只查文件）',
		mutates: false
	},
	{
		group: 'db',
		name: 'verify-suppression-version',
		file: 'scripts/verify-suppression-version.ts',
		runtime: 'node',
		env: 'optional',
		summary: '退订哈希版本闸门（env 版本低于库内最大版本 → 合规风险）',
		mutates: false
	},
	{
		group: 'db',
		name: 'migrate-webhook-secrets',
		file: 'scripts/migrate-webhook-secrets.ts',
		runtime: 'node',
		env: 'required',
		summary: '明文 webhook secret 加密回填',
		mutates: true,
		dryRun: true
	},
	{
		group: 'db',
		name: 'backfill-consent',
		file: 'scripts/backfill-email-consent.ts',
		runtime: 'node',
		env: 'required',
		summary: '把 consent 列存在前的订阅行标为 legacy',
		mutates: true,
		dryRun: true
	},
	{
		group: 'db',
		name: 'backfill-suppressions',
		file: 'scripts/backfill-suppressions.ts',
		runtime: 'node',
		env: 'required',
		summary: '把已退订行物化进 email_suppressions（--apply 需 SUPPRESSION_HMAC_KEY）',
		mutates: true,
		dryRun: true
	},
	{
		group: 'db',
		name: 'backfill-refs',
		file: 'scripts/backfill-file-references.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '用 /i/ 键对账 file_references',
		mutates: true,
		dryRun: true
	},
	{
		group: 'db',
		name: 'backfill-grid',
		file: 'scripts/backfill-grid-variants.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '补画廊 720px @grid 派生档（注意：脚本本身默认执行，--dry-run 才只看）',
		mutates: true
	},
	{
		group: 'db',
		name: 'backfill-translation-slugs',
		file: 'scripts/backfill-translation-slug.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '译文 slug 收敛到源 slug，并写 slug_trackers 保 301',
		mutates: true,
		dryRun: true
	},

	// --- site ---------------------------------------------------------------
	{
		group: 'site',
		name: 'seed-owner',
		file: 'scripts/seed-owner.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '通过运行中的 dev server 注册并授予 owner（需先 pnpm dev）',
		mutates: true
	},
	{
		group: 'site',
		name: 'rebuild-owner',
		file: 'scripts/rebuild-site-owner.ts',
		runtime: 'node',
		env: 'optional',
		summary: '修 site_identity 指针并退休 site.owner 选项行',
		mutates: true,
		dryRun: true
	},
	{
		group: 'site',
		name: 'ensure-org',
		file: 'scripts/ensure-site-org.ts',
		runtime: 'node',
		env: 'required',
		summary: '建站点组织与 owner membership（幂等，双写受 advisory lock 保护）',
		mutates: true
	},
	{
		group: 'site',
		name: 'ensure-pages',
		file: 'scripts/ensure-pages.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '种两个受保护默认页，不覆盖用户编辑',
		mutates: true
	},
	{
		group: 'site',
		name: 'ensure-categories',
		file: 'scripts/ensure-default-category.ts',
		runtime: 'node',
		env: 'required',
		summary: '确保兜底分类存在（posts.category_id NOT NULL 的唯一退路）',
		mutates: true
	},
	{
		group: 'site',
		name: 'ensure-schedules',
		file: 'scripts/ensure-job-schedules.ts',
		runtime: 'node',
		env: 'required',
		summary: '种默认 job 计划（空表时 drain 每分钟空转）',
		mutates: true
	},
	{
		group: 'site',
		name: 'reset-2fa',
		file: 'scripts/reset-2fa.ts',
		runtime: 'node',
		env: 'required',
		summary: '关闭指定账号两步验证并吊销其全部会话',
		mutates: true,
		danger: true
	},
	{
		group: 'site',
		name: 'verify-pages',
		file: 'scripts/verify-pages.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '校验 pages 表列/约束与默认 slug 的路由覆盖',
		mutates: false
	},
	{
		group: 'site',
		name: 'print-subscribe-token',
		file: 'scripts/print-subscribe-token.ts',
		runtime: 'node',
		env: 'optional',
		summary: '从 nonce 重算待确认订阅的 token（只写 stdout）',
		mutates: false,
		danger: true
	},

	// --- jobs ---------------------------------------------------------------
	{
		group: 'jobs',
		name: 'drain',
		file: 'jobs/drain.ts',
		runtime: 'node',
		env: 'required',
		summary: '单次 drain tick（生产由 systemd timer 每分钟调用）',
		mutates: true
	},
	{
		group: 'jobs',
		name: 'dev',
		file: 'jobs/dev.ts',
		runtime: 'node',
		env: 'required',
		summary: '开发用循环 worker（--interval 调频率）',
		mutates: true
	},
	{
		group: 'jobs',
		name: 'enqueue',
		file: 'scripts/jobs-enqueue.ts',
		runtime: 'node',
		env: 'required',
		summary: '手动入队，trigger 记为 cli',
		mutates: true
	},
	{
		group: 'jobs',
		name: 'check-links',
		file: 'scripts/jobs/check-links.ts',
		runtime: 'node',
		env: 'required',
		summary: '手动链接检查（与调度共享 advisory lock）',
		mutates: true
	},
	{
		group: 'jobs',
		name: 'links-prune',
		file: 'scripts/jobs/links-prune.ts',
		runtime: 'node',
		env: 'required',
		summary: '删除超过宽限期的失效链接',
		mutates: true,
		dryRun: true
	},
	{
		group: 'jobs',
		name: 'revisions-prune',
		file: 'scripts/jobs/revisions-prune.ts',
		runtime: 'node',
		env: 'required',
		summary: '每篇保留最新 N 个发布版本',
		mutates: true,
		dryRun: true
	},
	{
		group: 'jobs',
		name: 'orphans-purge',
		file: 'scripts/jobs/orphans-purge.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '清悬空 file_references 与过期孤儿草稿',
		mutates: true,
		dryRun: true
	},
	{
		group: 'jobs',
		name: 'trash-purge',
		file: 'scripts/jobs/trash-purge.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '清理超过宽限期的回收站 family（全 family 均 trashed 才删）',
		mutates: true,
		dryRun: true
	},
	{
		group: 'jobs',
		name: 'sync-projects',
		file: 'scripts/jobs/sync-projects.ts',
		runtime: 'node',
		env: 'required',
		summary: '项目同步（--dry-run / --provider / --account / --refresh-ids）',
		mutates: true
	},
	{
		group: 'jobs',
		name: 'verify',
		file: 'scripts/verify-jobs-drain.ts',
		runtime: 'tsx',
		env: 'required',
		summary: 'drain 内核验收：一次性库 + 真进程 + SIGKILL 恢复（较慢）',
		mutates: true
	},

	// --- media --------------------------------------------------------------
	{
		group: 'media',
		name: 'import',
		file: 'scripts/media-import.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '批量导入：内容哈希去重、变体、目录名成 tag',
		mutates: true
	},
	{
		group: 'media',
		name: 'audit',
		file: 'scripts/media-audit.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '只读审计：孤儿 / 断链 / 缺对象（--strict 供监控）',
		mutates: false
	},
	{
		group: 'media',
		name: 'purge',
		file: 'scripts/purge-media.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '清理超过 TTL 的媒体（--yes 才删）',
		mutates: true,
		dryRun: true
	},
	{
		group: 'media',
		name: 'verify',
		file: 'scripts/verify-media.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '对 dev 栈验证上传/去重/引用守卫与三条审计用例',
		mutates: true
	},

	// --- storage ------------------------------------------------------------
	{
		group: 'storage',
		name: 'migrate',
		file: 'scripts/storage-migrate.ts',
		runtime: 'tsx',
		env: 'required',
		summary: 'provider 迁移：--dry-run/--yes/--cutover/--rollback/--status/--reset',
		mutates: true,
		danger: true
	},
	{
		group: 'storage',
		name: 'smoke',
		file: 'scripts/storage-smoke.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '对 RustFS 做 PUT/GET/HEAD/DELETE 冒烟',
		mutates: true
	},

	// --- secrets ------------------------------------------------------------
	{
		group: 'secrets',
		name: 'alerts',
		file: 'scripts/secret-alerts.ts',
		runtime: 'node',
		env: 'optional',
		summary: '把密钥失败审计行按规则推送到告警 webhook（带去重状态）',
		mutates: true
	},
	{
		group: 'secrets',
		name: 'verify-keys',
		file: 'scripts/verify-secret-key-versions.ts',
		runtime: 'node',
		env: 'optional',
		summary: 'keyring 覆盖与解密校验（--retire N 判断能否退休旧版本）',
		mutates: false
	},
	{
		group: 'secrets',
		name: 'verify-oauth-tokens',
		file: 'scripts/verify-oauth-token-storage.ts',
		runtime: 'node',
		env: 'optional',
		summary: 'OAuth token 加密覆盖率（不打印 token）',
		mutates: false
	},

	// --- maps ---------------------------------------------------------------
	{
		group: 'maps',
		name: 'publish',
		file: 'scripts/maps-publish.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '把本地 PMTiles 发布到 maps/ 前缀（大小写敏感）',
		mutates: true
	},

	// --- dev ----------------------------------------------------------------
	{
		group: 'dev',
		name: 'auth-check',
		file: 'scripts/auth-schema-guard.ts',
		runtime: 'node',
		env: 'none',
		summary: 'auth schema 漂移守卫（--migrations-only 只扫 SQL）',
		mutates: false
	},
	{
		group: 'dev',
		name: 'lint-tw',
		file: 'scripts/tailwind-canonical.ts',
		runtime: 'node',
		env: 'none',
		summary: 'Tailwind canonical class 检查（--fix 改写）',
		mutates: false
	},
	{
		group: 'dev',
		name: 'e2e-fixtures',
		file: 'scripts/e2e-overlay-fixtures.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '向 RustFS 发布 overlay e2e 所需的 3 个 GIF',
		mutates: true
	},
	{
		group: 'dev',
		name: 'seed-demo',
		file: 'scripts/seed-demo.ts',
		runtime: 'tsx',
		env: 'required',
		summary: '演示数据（--force 重写正文）',
		mutates: true
	}
];

export function findEntry(group: string, name: string): Entry | undefined {
	return ENTRIES.find((e) => e.group === group && e.name === name);
}

export function entryId(e: Entry): string {
	return `${e.group} ${e.name}`;
}
