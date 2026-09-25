import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { enrichmentCache } from './enrichment-cache.schema';

export interface EnrichmentImagePalette {
	dominant: string;
	swatches?: string[];
}

export const enrichmentCaptures = pgTable(
	'enrichment_captures',
	{
		enrichmentId: uuid('enrichment_id')
			.primaryKey()
			.notNull()
			.references(() => enrichmentCache.id, { onDelete: 'cascade' }),
		objectKey: text('object_key').notNull(),
		bytes: integer('bytes').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		thumbhash: text('thumbhash'),
		palette: jsonb('palette').$type<EnrichmentImagePalette>(),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('enrichment_captures_lru_idx').on(table.lastAccessedAt.asc())]
);
