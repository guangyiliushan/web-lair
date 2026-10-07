/**
 * Projects-line shared metadata (projects line plan §2.7 / §18): the
 * UI-facing copy of the provider / status enumerations plus the i18n label
 * key maps. Batches P / A add the messages; the key names are pinned by
 * `project-meta.test.ts` so the admin surface and the public grid cannot
 * diverge on them.
 *
 * The DB copy lives in `$lib/server/db/content/project.schema.ts`;
 * `enum-drift.test.ts` pins BOTH copies against the baseline CHECK literals,
 * so neither can drift from the single baseline.
 *
 * Dependency-free and Node-loadable by design (links-line precedent): the
 * jobs side imports it with a relative `.ts` specifier - `$lib` aliases do
 * not resolve under plain Node type stripping.
 */
export const PROJECT_PROVIDERS = [
	'github',
	'gitlab',
	'gitee',
	'bitbucket',
	'site',
	'other'
] as const;
export type ProjectProvider = (typeof PROJECT_PROVIDERS)[number];

/** The four platforms the sync job can pull public repositories from (§18.3). */
export const PROJECT_SYNC_PROVIDERS = ['github', 'gitlab', 'gitee', 'bitbucket'] as const;
export type ProjectSyncProvider = (typeof PROJECT_SYNC_PROVIDERS)[number];

/** Four-value review state machine (§2.4): `pending` is the sync default. */
export const PROJECT_STATUSES = ['pending', 'published', 'hidden', 'rejected'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Admin status labels (messages `admin_projects_status_*`, added with batch A). */
export const PROJECT_STATUS_LABEL_KEYS: Record<ProjectStatus, string> = {
	pending: 'admin_projects_status_pending',
	published: 'admin_projects_status_published',
	hidden: 'admin_projects_status_hidden',
	rejected: 'admin_projects_status_rejected'
};

/**
 * Provider labels: the four platform brands are proper nouns rendered
 * literally (`null` = no message key); `site` / `other` resolve through i18n
 * keys (messages land with batches P / A).
 */
export const PROJECT_PROVIDER_LABEL_KEYS: Record<ProjectProvider, string | null> = {
	github: null,
	gitlab: null,
	gitee: null,
	bitbucket: null,
	site: 'projects_badge_site',
	other: 'projects_badge_other'
};

export function isProjectProvider(value: string): value is ProjectProvider {
	return (PROJECT_PROVIDERS as readonly string[]).includes(value);
}

export function isProjectSyncProvider(value: string): value is ProjectSyncProvider {
	return (PROJECT_SYNC_PROVIDERS as readonly string[]).includes(value);
}

export function isProjectStatus(value: string): value is ProjectStatus {
	return (PROJECT_STATUSES as readonly string[]).includes(value);
}
