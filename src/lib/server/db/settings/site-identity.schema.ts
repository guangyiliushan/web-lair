import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';

/**
 * One-row pointer to the site owner.
 *
 * `user_profiles` stays the single source for the public persona; this table
 * only answers "which user is the owner" for the hot header read, because the
 * generated better-auth `user` table must not carry a custom `role` index.
 * The application layer keeps the row at `id = 1` and re-checks `role='owner'`
 * on every read/write; `site rebuild-owner` repairs the pointer.
 */
export const siteIdentity = pgTable(
	'site_identity',
	{
		id: integer('id').primaryKey().default(1),
		ownerUserId: text('owner_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'restrict' }),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		/** Audit actor; nullable because a deleted admin must not block repair. */
		updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		check('site_identity_singleton_check', sql`${table.id} = 1`),
		index('site_identity_owner_user_id_idx').on(table.ownerUserId)
	]
);
