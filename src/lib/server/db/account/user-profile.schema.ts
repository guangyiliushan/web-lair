import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema';

/** One outbound link on a profile (`links` jsonb array element). */
export interface ProfileLink {
	platform: string;
	href: string;
	label?: string;
}

export const userProfiles = pgTable(
	'user_profiles',
	{
		userId: text('user_id')
			.primaryKey()
			.references(() => user.id, { onDelete: 'cascade' }),
		displayName: text('display_name').notNull(),
		slug: text('slug').notNull().unique(),
		bio: text('bio'),
		avatarUrl: text('avatar_url'),
		/** Ordered outbound links; NULL when the profile has none. Shape: zod at the app layer. */
		links: jsonb('links').$type<ProfileLink[] | null>(),
		emailNotificationsEnabled: boolean('email_notifications_enabled').default(true).notNull(),
		profilePublic: boolean('profile_public').default(false).notNull(),
		onlineStatusPublic: boolean('online_status_public').default(false).notNull(),
		/** Soft delete (ledger §4.13/§4.21): `deleted_at` is kept in sync by a CHECK. */
		status: text('status', { enum: ['active', 'deleted'] })
			.default('active')
			.notNull(),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [
		check('user_profiles_status_check', sql`${table.status} in ('active', 'deleted')`),
		check(
			'user_profiles_deleted_at_check',
			sql`(${table.status} = 'deleted') = (${table.deletedAt} is not null)`
		),
		check(
			'user_profiles_links_is_array_check',
			sql`${table.links} is null or jsonb_typeof(${table.links}) = 'array'`
		)
	]
);
