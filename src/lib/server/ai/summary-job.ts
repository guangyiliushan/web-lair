import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getOption } from '../config/options-registry.ts';
import { posts } from '../db/content/post.schema.ts';
import { summaries } from '../db/content/summary.schema.ts';
import { SUMMARY_KEEP_UNADOPTED } from './summary-retention.ts';
import { sanitizeErrorText } from '../jobs/error-text.ts';
import { resolveProviderKey, type SecretDb } from '../secrets/resolver.ts';
import { generateSummary } from './summarize.ts';
import type { AiDeps } from './types.ts';
import type { JobContext } from '../jobs/types.ts';

const BATCH = 2;
// Scan window: candidates already exist for most of these;
// the loop skips them, but they must not hide the rest of the queue behind
// the generation batch size.
const SCAN_LIMIT = 50;

/**
 * `ai.summarize` scanner (opt-in via `ai.summary.auto`). Only published posts
 * with no author summary and enough plain text are considered. A generated
 * candidate is a ledger row; adoption remains a human action on the post.
 */
export async function runSummaryJob(ctx: JobContext): Promise<void> {
	const options = await getOption('ai.summary', ctx.db as unknown as AiDeps['db']);
	if (!options.auto) {
		ctx.summary({ skipped: 'auto-off' });
		return;
	}
	const rows = await ctx.db
		.select({
			id: posts.id,
			lang: posts.lang,
			content: posts.content,
			title: posts.title
		})
		.from(posts)
		.where(
			and(
				eq(posts.status, 'published'),
				or(isNull(posts.summary), sql`btrim(${posts.summary}) = ''`),
				sql`${posts.content} is not null`
			)
		)
		.orderBy(asc(posts.publishedAt))
		.limit(SCAN_LIMIT);

	let generated = 0;
	let failed = 0;
	for (const row of rows) {
		if (generated >= BATCH) break;
		const hash = createHash('sha256')
			.update(JSON.stringify([row.title, row.content ?? '']))
			.digest('hex');
		const [existing] = await ctx.db
			.select({ id: summaries.id })
			.from(summaries)
			.where(
				and(
					eq(summaries.postId, row.id),
					eq(summaries.lang, row.lang),
					eq(summaries.sourceHash, hash)
				)
			)
			.limit(1);
		if (existing) continue;
		try {
			const candidate = await generateSummary(
				{ postId: row.id },
				{
					db: ctx.db as unknown as AiDeps['db'],
					getEnv: (name) => process.env[name],
					resolveKey: (provider) =>
						resolveProviderKey(ctx.db as unknown as SecretDb, provider, {
							getEnv: (name) => process.env[name]
						}),
					log: (message) => ctx.logger.info(message)
				}
			);
			await ctx.db
				.insert(summaries)
				.values({
					postId: row.id,
					lang: candidate.lang,
					sourceHash: candidate.sourceHash,
					summary: candidate.summary,
					model: candidate.model
				})
				.onConflictDoNothing();
			// Retention: keep the latest 5 unadopted candidates per (post, lang).
			// The DELETE re-asserts adopted_at is null: an adopt landing between
			// the select and the delete would otherwise silently delete the
			// adopted ledger row (P0-3).
			const old = await ctx.db
				.select({ id: summaries.id })
				.from(summaries)
				.where(
					and(
						eq(summaries.postId, row.id),
						eq(summaries.lang, candidate.lang),
						isNull(summaries.adoptedAt)
					)
				)
				.orderBy(sql`${summaries.createdAt} desc`)
				.offset(SUMMARY_KEEP_UNADOPTED);
			if (old.length > 0) {
				await ctx.db.delete(summaries).where(
					and(
						isNull(summaries.adoptedAt),
						inArray(
							summaries.id,
							old.map((item) => item.id)
						)
					)
				);
			}
			generated += 1;
		} catch (caught) {
			const message = sanitizeErrorText(caught);
			ctx.logger.warn(`summary ${row.id} failed: ${message}`);
			failed += 1;
		}
	}
	ctx.summary({ pending: rows.length, generated, failed });
}
