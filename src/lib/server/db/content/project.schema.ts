import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';

export const PROJECT_PROVIDERS = [
	'github',
	'gitlab',
	'gitee',
	'bitbucket',
	'site',
	'other'
] as const;
export type ProjectProvider = (typeof PROJECT_PROVIDERS)[number];

export const PROJECT_STATUSES = ['pending', 'published', 'hidden', 'rejected'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Project registry (projects line §2): four-platform sync + manual entries. */
export const projects = pgTable(
	'projects',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		name: text('name').notNull(),
		description: text('description'),
		provider: varchar('provider', { length: 64 }).notNull(),
		externalId: varchar('external_id', { length: 256 }),
		fullName: text('full_name'),
		projectUrl: text('project_url').notNull(),
		previewUrl: text('preview_url'),
		docUrl: text('doc_url'),
		avatar: text('avatar'),
		language: text('language'),
		stars: integer('stars'),
		pushedAt: timestamp('pushed_at', { withTimezone: true }),
		archived: boolean('archived').notNull().default(false),
		fork: boolean('fork').notNull().default(false),
		status: text('status').notNull().default('pending'),
		sortOrder: integer('sort_order').notNull().default(0),
		lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
		lastErrorKind: text('last_error_kind')
	},
	(table) => [
		index('projects_extid_uniq')
			.on(table.provider, table.externalId)
			.where(sql`${table.externalId} is not null`),
		index('projects_url_uniq')
			.on(table.provider, table.projectUrl)
			.where(sql`${table.externalId} is null`),
		index('projects_status_sort_idx').on(table.status, table.sortOrder),
		index('projects_review_idx')
			.on(table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		check(
			'projects_provider_check',
			sql`${table.provider} in ('github', 'gitlab', 'gitee', 'bitbucket', 'site', 'other')`
		),
		check(
			'projects_status_check',
			sql`${table.status} in ('pending', 'published', 'hidden', 'rejected')`
		),
		check(
			'projects_external_id_check',
			sql`(${table.provider} in ('github', 'gitlab', 'gitee', 'bitbucket')) = (${table.externalId} is not null)`
		)
	]
);
