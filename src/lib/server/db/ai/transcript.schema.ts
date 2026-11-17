import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
// Explicit .ts specifier: the jobs drain loads this schema graph under plain
// Node (type stripping); extensionless resolution does not exist there.
import { user } from '../auth.schema.ts';

/**
 * Finished speech-to-text results. The audio itself is deliberately not
 * stored: Whisper receives the upload, returns text + segments, and the
 * temporary file is discarded. Keeping the transcript (not the recording)
 * is the privacy boundary.
 */
export const transcripts = pgTable(
	'transcripts',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
		sourceName: text('source_name').notNull(),
		mimeType: text('mime_type').notNull(),
		language: text('language').notNull(),
		text: text('text').notNull(),
		vtt: text('vtt').notNull(),
		durationSeconds: integer('duration_seconds'),
		provider: text('provider').notNull(),
		model: text('model').notNull()
	},
	(table) => [
		index('transcripts_created_idx').on(table.createdAt),
		// Leading index for the SET NULL FK check: without it the
		// referential check scans the whole table on every user delete.
		index('transcripts_actor_idx')
			.on(table.actorId)
			.where(sql`${table.actorId} is not null`)
	]
);
