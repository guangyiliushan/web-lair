import { sql } from 'drizzle-orm';
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

export interface EnrichmentImagePalette {
	dominant: string;
	swatches?: string[];
}

/** Enrichment capture blobs (storage line §3.5): decoupled from cache, LRU. */
export const enrichmentCaptures = pgTable(
	'enrichment_captures',
	{
		id: uuid('id')
			.primaryKey()
			.default(sql`uuidv7()`)
			.notNull(),
		provider: text('provider').notNull(),
		sourceUrl: text('source_url').notNull(),
		objectKey: text('object_key').notNull(),
		byteSize: integer('byte_size').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		thumbhash: text('thumbhash'),
		palette: jsonb('palette').$type<EnrichmentImagePalette>(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('enrichment_captures_lru_idx').on(table.lastAccessedAt.asc()),
		uniqueIndex('enrichment_captures_source_uniq').on(table.provider, table.sourceUrl)
	]
);
