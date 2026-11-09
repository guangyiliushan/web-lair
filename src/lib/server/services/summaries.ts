import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { posts, summaries } from '$lib/server/db/content';
import { generateSummary } from '$lib/server/ai/summarize';
import { webAiDeps } from '$lib/server/ai';

import { SUMMARY_KEEP_UNADOPTED } from '$lib/server/ai/summary-retention';

export { SUMMARY_KEEP_UNADOPTED };

function contentHash(title: string, content: string | null): string {
	return createHash('sha256')
		.update(JSON.stringify([title, content ?? '']))
		.digest('hex');
}

export type GenerateSummaryResult =
	| { kind: 'created'; id: string }
	| { kind: 'existing'; id: string }
	| { kind: 'not-found' }
	| { kind: 'too-short' }
	| { kind: 'error'; message: string };

/** Manual editor action: generate one candidate and store it. */
export async function generateAndStoreSummary(
	postId: string,
	manual = true,
	actorId: string | null = null
): Promise<GenerateSummaryResult> {
	const [post] = await db
		.select({ id: posts.id, title: posts.title, content: posts.content, lang: posts.lang })
		.from(posts)
		.where(eq(posts.id, postId))
		.limit(1);
	if (!post) return { kind: 'not-found' };
	const hash = contentHash(post.title, post.content);
	const [existing] = await db
		.select({ id: summaries.id })
		.from(summaries)
		.where(
			and(
				eq(summaries.postId, postId),
				eq(summaries.lang, post.lang),
				eq(summaries.sourceHash, hash)
			)
		)
		.limit(1);
	if (existing) return { kind: 'existing', id: existing.id };
	try {
		const candidate = await generateSummary(
			{ postId, manual, actorId, trigger: manual ? 'manual' : 'job' },
			webAiDeps()
		);
		const [created] = await db
			.insert(summaries)
			.values({
				postId,
				lang: candidate.lang,
				sourceHash: candidate.sourceHash,
				summary: candidate.summary,
				model: candidate.model
			})
			.returning({ id: summaries.id });
		await pruneSummaries(postId, candidate.lang);
		return { kind: 'created', id: created.id };
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		if (message.includes('shorter than the summary threshold')) return { kind: 'too-short' };
		if (message.includes('duplicate key')) {
			const [row] = await db
				.select({ id: summaries.id })
				.from(summaries)
				.where(
					and(
						eq(summaries.postId, postId),
						eq(summaries.lang, post.lang),
						eq(summaries.sourceHash, hash)
					)
				)
				.limit(1);
			if (row) return { kind: 'existing', id: row.id };
		}
		return { kind: 'error', message };
	}
}

export async function listSummaries(postId: string) {
	return db
		.select({
			id: summaries.id,
			lang: summaries.lang,
			sourceHash: summaries.sourceHash,
			summary: summaries.summary,
			model: summaries.model,
			adoptedAt: summaries.adoptedAt,
			createdAt: summaries.createdAt
		})
		.from(summaries)
		.where(eq(summaries.postId, postId))
		.orderBy(desc(summaries.createdAt));
}

export type AdoptSummaryResult =
	{ kind: 'adopted' } | { kind: 'not-found' } | { kind: 'stale' } | { kind: 'busy' };

/**
 * Adoption writes the content source of truth (`posts.summary`) and stamps
 * the ledger row. The previous adopted candidate for the same (post, lang)
 * is cleared first: the partial unique index allows exactly one adopted row.
 * A source-hash mismatch rejects instead of silently adopting a stale text.
 */
export async function adoptSummary(
	summaryId: string,
	reviewerId: string | null
): Promise<AdoptSummaryResult> {
	try {
		return await db.transaction(async (tx) => {
			const [row] = await tx
				.select()
				.from(summaries)
				.where(eq(summaries.id, summaryId))
				.limit(1)
				.for('update');
			if (!row) return { kind: 'not-found' as const };
			const [post] = await tx
				.select({ id: posts.id, title: posts.title, content: posts.content })
				.from(posts)
				.where(eq(posts.id, row.postId))
				.limit(1)
				.for('update');
			if (!post) return { kind: 'not-found' as const };
			const hash = contentHash(post.title, post.content);
			if (hash !== row.sourceHash) return { kind: 'stale' as const };
			await tx
				.update(summaries)
				.set({ adoptedAt: null })
				.where(
					and(
						eq(summaries.postId, row.postId),
						eq(summaries.lang, row.lang),
						sql`${summaries.adoptedAt} is not null`
					)
				);
			await tx.update(summaries).set({ adoptedAt: new Date() }).where(eq(summaries.id, summaryId));
			await tx
				.update(posts)
				.set({ summary: row.summary, updatedAt: new Date() })
				.where(eq(posts.id, row.postId));
			// reviewerId is recorded only in the run/audit log today; the
			// summaries table has no reviewed_by column. Keep the parameter so a
			// future schema window can stamp it without changing callers.
			void reviewerId;
			return { kind: 'adopted' as const };
		});
	} catch (caught) {
		const code = (caught as { code?: string }).code;
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

export async function discardSummary(summaryId: string): Promise<boolean> {
	const rows = await db
		.delete(summaries)
		.where(and(eq(summaries.id, summaryId), sql`${summaries.adoptedAt} is null`))
		.returning({ id: summaries.id });
	return rows.length > 0;
}

/**
 * Publish-time hook (best effort): enqueue the scanner when the author opted
 * into automatic summaries and the post has no summary yet. Publishing must
 * never wait for AI; a failed enqueue is logged and the job can be run from
 * the maintenance surface later.
 */
export async function enqueueSummaryAfterPublish(postId: string): Promise<void> {
	try {
		const options = await (
			await import('$lib/server/config/options-registry')
		).getOption('ai.summary');
		if (!options.auto) return;
		const [post] = await db
			.select({ id: posts.id, summary: posts.summary, content: posts.content })
			.from(posts)
			.where(eq(posts.id, postId))
			.limit(1);
		if (!post) return;
		if (post.summary?.trim()) return;
		const { plainTextLength } = await import('$lib/server/ai/protect');
		if (plainTextLength(post.content ?? '') < options.minChars) return;
		const { enqueueJob } = await import('$lib/server/jobs/queue');
		await enqueueJob(db, 'ai.summarize', 'manual');
	} catch (caught) {
		console.warn('[ai] summary enqueue failed', caught instanceof Error ? caught.message : caught);
	}
}

/** Keep the latest N unadopted candidates per (post, lang); adopted rows stay. */
export async function pruneSummaries(postId: string, lang: string): Promise<number> {
	const rows = await db
		.select({ id: summaries.id })
		.from(summaries)
		.where(
			and(
				eq(summaries.postId, postId),
				eq(summaries.lang, lang),
				sql`${summaries.adoptedAt} is null`
			)
		)
		.orderBy(desc(summaries.createdAt))
		.offset(SUMMARY_KEEP_UNADOPTED);
	if (rows.length === 0) return 0;
	const ids = rows.map((row) => row.id);
	const deleted = await db
		.delete(summaries)
		.where(and(sql`${summaries.adoptedAt} is null`, inArray(summaries.id, ids)))
		.returning({ id: summaries.id });
	return deleted.length;
}
