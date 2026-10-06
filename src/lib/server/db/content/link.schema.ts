import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';
import type { LinkCheck } from '../../../utils/link-meta.ts';

// Shared status / error-kind enums moved to `$lib/utils/link-meta.ts`
// (2026-10-06, links L1 remainder): the checker side (plain-Node jobs)
// imports that module relatively, and the enum-drift test pins
// LINK_STATUSES against the baseline CHECK literals.

/**
 * Friend-link registry (links line §2): single table with health state,
 * backlink tracking, and a bounded evidence ring.
 */
export const links = pgTable(
	'links',
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
		url: text('url').notNull(),
		host: text('host').notNull(),
		avatar: text('avatar'),
		description: text('description'),
		email: text('email'),
		backlinkUrl: text('backlink_url'),
		backlinkOk: boolean('backlink_ok'),
		backlinkCheckedAt: timestamp('backlink_checked_at', { withTimezone: true }),
		backlinkMissingStreak: integer('backlink_missing_streak').notNull().default(0),
		status: text('status').notNull().default('pending'),
		reason: text('reason'),
		reviewedBy: text('reviewed_by').references(() => user.id, { onDelete: 'set null' }),
		reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
		lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
		lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
		failStreak: integer('fail_streak').notNull().default(0),
		lastErrorKind: text('last_error_kind'),
		lostSince: timestamp('lost_since', { withTimezone: true }),
		checkEnabled: boolean('check_enabled').notNull().default(true),
		recentChecks: jsonb('recent_checks').$type<LinkCheck[]>(),
		sortOrder: integer('sort_order').notNull().default(0)
	},
	(table) => [
		uniqueIndex('links_name_uniq').on(table.name),
		uniqueIndex('links_url_uniq').on(table.url),
		index('links_host_idx').on(table.host),
		index('links_status_idx').on(table.status, table.sortOrder),
		index('links_review_idx')
			.on(table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		index('links_due_idx')
			.on(table.lastCheckedAt)
			.where(sql`${table.status} in ('approved', 'outdated')`),
		index('links_reviewed_by_idx')
			.on(table.reviewedBy)
			.where(sql`${table.reviewedBy} is not null`),
		check(
			'links_status_check',
			sql`${table.status} in ('pending', 'approved', 'outdated', 'rejected', 'banned')`
		),
		check(
			'links_banned_reason_check',
			sql`${table.status} <> 'banned' or ${table.reason} is not null`
		),
		check(
			'links_https_check',
			sql`${table.url} like 'https://%' and (${table.backlinkUrl} is null or ${table.backlinkUrl} like 'https://%')`
		),
		check(
			'links_lost_since_check',
			sql`(${table.status} = 'outdated') = (${table.lostSince} is not null)`
		),
		check(
			'links_backlink_required_check',
			sql`${table.status} in ('rejected', 'banned') or ${table.backlinkUrl} is not null`
		),
		check(
			'links_ring_check',
			sql`${table.recentChecks} is null or (case when jsonb_typeof(${table.recentChecks}) = 'array' then jsonb_array_length(${table.recentChecks}) <= 10 else false end)`
		),
		check(
			'links_streak_check',
			sql`${table.failStreak} >= 0 and ${table.backlinkMissingStreak} >= 0`
		)
	]
);
