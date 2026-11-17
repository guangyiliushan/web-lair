import { sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	check,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp
} from 'drizzle-orm/pg-core';
import { user } from '../auth.schema.ts';

/** `{ [locale]: copy }`; an empty map (or an empty string) falls back to messages. */
export type LocalizedCopy = Record<string, string>;

const localizedCopy = (name: string) =>
	jsonb(name)
		.$type<LocalizedCopy>()
		.default(sql`'{}'::jsonb`)
		.notNull();

function localizedCheck(name: string, column: AnyPgColumn) {
	return check(`home_hero_${name}_object_check`, sql`jsonb_typeof(${column}) = 'object'`);
}

/**
 * One-row homepage hero copy.
 *
 * Only the homepage reads it; it is deliberately separate from `options`
 * (no timestamps, whole-object rewrites) and from messages (deploy-coupled).
 * Each field is a per-locale map; resolution order is requested locale →
 * `site.default_lang` → messages → empty.
 */
export const homeHero = pgTable(
	'home_hero',
	{
		id: integer('id').primaryKey().default(1),
		title: localizedCopy('title'),
		subtitlePrefix: localizedCopy('subtitle_prefix'),
		subtitleHighlight: localizedCopy('subtitle_highlight'),
		description: localizedCopy('description'),
		welcome: localizedCopy('welcome'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		updatedBy: text('updated_by').references(() => user.id, { onDelete: 'set null' })
	},
	(table) => [
		check('home_hero_singleton_check', sql`${table.id} = 1`),
		localizedCheck('title', table.title),
		localizedCheck('subtitle_prefix', table.subtitlePrefix),
		localizedCheck('subtitle_highlight', table.subtitleHighlight),
		localizedCheck('description', table.description),
		localizedCheck('welcome', table.welcome)
	]
);
