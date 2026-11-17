import { and, count, desc, eq, isNull, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { drafts, notes, postTags, posts, tags, translations } from '$lib/server/db/content';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import { enqueueJob } from '$lib/server/jobs/queue';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { keysFromContent, syncFileReferences } from './file-references';
import { isPlaceholderSlug, tempSlug } from './post-drafts';
import { plainTextLength } from '$lib/server/ai/protect';
import { sourceHash as computeSourceHash } from '$lib/server/ai/translate';
import { hasUsableTranslation } from './translation-presence.ts';

export const TRANSLATION_JOB = 'ai.translate';
const PAGE_SIZE = 20;

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TranslationRequestResult =
	| { kind: 'queued'; id: string }
	| { kind: 'exists'; id: string }
	| { kind: 'skipped'; reason: string }
	| { kind: 'not-found' }
	| { kind: 'same-lang' }
	| { kind: 'lang-exists' }
	| { kind: 'too-short' };

function metaTranslateMode(meta: unknown): string | null {
	if (!meta || typeof meta !== 'object') return null;
	const translate = (meta as { translate?: unknown }).translate;
	if (!translate || typeof translate !== 'object') return null;
	const mode = (translate as { mode?: unknown }).mode;
	return typeof mode === 'string' ? mode : null;
}

function metaTranslateTargets(meta: unknown): string[] | null {
	if (!meta || typeof meta !== 'object') return null;
	const translate = (meta as { translate?: unknown }).translate;
	if (!translate || typeof translate !== 'object') return null;
	const targets = (translate as { targets?: unknown }).targets;
	if (!Array.isArray(targets)) return null;
	return targets.filter((value): value is string => typeof value === 'string');
}

async function loadPostSource(id: string) {
	const [row] = await db
		.select({
			id: posts.id,
			title: posts.title,
			content: posts.content,
			summary: posts.summary,
			lang: posts.lang,
			contentFormat: posts.contentFormat,
			categoryId: posts.categoryId,
			translationGroup: posts.translationGroup,
			translatedFrom: posts.translatedFromPostId,
			meta: posts.meta,
			status: posts.status
		})
		.from(posts)
		.where(eq(posts.id, id))
		.limit(1);
	return row ?? null;
}

async function loadNoteSource(id: string) {
	const [row] = await db
		.select({
			id: notes.id,
			title: notes.title,
			content: notes.content,
			lang: notes.lang,
			contentFormat: notes.contentFormat,
			translationGroup: notes.translationGroup,
			translatedFrom: notes.translatedFromNoteId,
			topicId: notes.topicId,
			meta: notes.meta,
			status: notes.status
		})
		.from(notes)
		.where(eq(notes.id, id))
		.limit(1);
	return row ? { ...row, summary: null } : null;
}

async function insertRequest(input: {
	sourceType: 'post' | 'note';
	sourceId: string;
	targetLang: string;
	/** Who asked; null for the auto-translate scanner. */
	requestedBy?: string | null;
	source: {
		title: string;
		content: string | null;
		summary: string | null;
		contentFormat: string;
	};
}): Promise<{ kind: 'queued' | 'exists'; id: string }> {
	const [existing] = await db
		.select({ id: translations.id, status: translations.status, content: translations.content })
		.from(translations)
		.where(
			and(
				input.sourceType === 'post'
					? eq(translations.sourcePostId, input.sourceId)
					: eq(translations.sourceNoteId, input.sourceId),
				eq(translations.targetLang, input.targetLang),
				eq(translations.status, 'draft')
			)
		)
		.limit(1);
	if (existing) return { kind: 'exists', id: existing.id };
	const [row] = await db
		.insert(translations)
		.values({
			sourcePostId: input.sourceType === 'post' ? input.sourceId : null,
			sourceNoteId: input.sourceType === 'note' ? input.sourceId : null,
			targetLang: input.targetLang,
			title: input.source.title,
			content: null,
			summary: null,
			contentFormat: input.source.contentFormat,
			origin: 'ai',
			model: null,
			sourceHash: computeSourceHash(input.source),
			status: 'draft',
			error: null,
			requestedBy: input.requestedBy ?? null,
			updatedAt: new Date()
		})
		.returning({ id: translations.id });
	return { kind: 'queued', id: row.id };
}

/**
 * Create a work item and enqueue the scanner job. The row is the durable
 * queue entry (`content = null` = pending); `job_runs` has no payload column,
 * so the job scans these rows instead of receiving a post id.
 */
export async function requestTranslation(input: {
	sourceType: 'post' | 'note';
	sourceId: string;
	targetLang: string;
	manual?: boolean;
	/** Who asked; null/undefined for the auto-translate scanner. */
	requestedBy?: string | null;
}): Promise<TranslationRequestResult> {
	const source =
		input.sourceType === 'post'
			? await loadPostSource(input.sourceId)
			: await loadNoteSource(input.sourceId);
	if (!source) return { kind: 'not-found' };
	if (source.translatedFrom) return { kind: 'skipped', reason: 'not-source' };
	if (source.lang === input.targetLang) return { kind: 'same-lang' };
	if (!(OPTION_LANGS as readonly string[]).includes(input.targetLang)) {
		return { kind: 'skipped', reason: 'bad-lang' };
	}
	if (await hasUsableTranslation(input.sourceType, source.translationGroup, input.targetLang)) {
		return { kind: 'lang-exists' };
	}
	const minChars = (await getOption('ai.translation')).minChars;
	// Manual requests may bypass the length floor, but no mode may queue an
	// empty source: there is nothing for the model to translate.
	if (!(source.content ?? '').trim()) return { kind: 'skipped', reason: 'empty-source' };
	if (!input.manual && plainTextLength(source.content ?? '') < minChars) {
		return { kind: 'too-short' };
	}
	try {
		const created = await insertRequest({
			sourceType: input.sourceType,
			sourceId: input.sourceId,
			targetLang: input.targetLang,
			requestedBy: input.requestedBy ?? null,
			source
		});
		if (created.kind === 'queued') {
			try {
				await enqueueJob(db, TRANSLATION_JOB, 'manual');
			} catch (caught) {
				// The row remains a durable pending item; the workbench can retry.
				console.warn(
					'[ai] translation enqueue failed',
					caught instanceof Error ? caught.message : caught
				);
			}
		}
		return created;
	} catch (caught) {
		if (pgErrorCode(caught) === '23505') {
			const [row] = await db
				.select({ id: translations.id })
				.from(translations)
				.where(
					and(
						input.sourceType === 'post'
							? eq(translations.sourcePostId, input.sourceId)
							: eq(translations.sourceNoteId, input.sourceId),
						eq(translations.targetLang, input.targetLang),
						eq(translations.status, 'draft')
					)
				)
				.limit(1);
			if (row) return { kind: 'exists', id: row.id };
		}
		throw caught;
	}
}

/**
 * Auto-generation after publish. `auto` = enqueue candidates; `review` and
 * `manual` require an explicit workbench request. AI failures never block a
 * publish: this function logs and returns.
 */
export async function enqueueTranslationsAfterPublish(
	sourceType: 'post' | 'note',
	sourceId: string
): Promise<void> {
	try {
		const source =
			sourceType === 'post' ? await loadPostSource(sourceId) : await loadNoteSource(sourceId);
		if (!source || source.translatedFrom) return;
		const mode = metaTranslateMode(source.meta);
		const config = await getOption('ai.translation');
		const effectiveMode = mode ?? config.defaultMode;
		if (effectiveMode !== 'auto') return;
		if (sourceType === 'note' && !config.notesAuto) return;
		if (plainTextLength(source.content ?? '') < config.minChars) return;
		const languages = await getOption('site.languages');
		const enabled = languages.enabled.filter((lang) => lang !== source.lang);
		const requested = metaTranslateTargets(source.meta) ?? enabled;
		const targets = requested.filter(
			(lang) =>
				(OPTION_LANGS as readonly string[]).includes(lang) &&
				lang !== source.lang &&
				languages.enabled.includes(lang as (typeof OPTION_LANGS)[number])
		);
		for (const target of targets) {
			if (await hasUsableTranslation(sourceType, source.translationGroup, target)) continue;
			try {
				await insertRequest({ sourceType, sourceId, targetLang: target, source });
			} catch (caught) {
				if (pgErrorCode(caught) !== '23505') throw caught;
			}
		}
		if (targets.length > 0) {
			try {
				await enqueueJob(db, TRANSLATION_JOB, 'manual');
			} catch (caught) {
				console.warn(
					'[ai] auto translation enqueue failed',
					caught instanceof Error ? caught.message : caught
				);
			}
		}
	} catch (caught) {
		// Publishing is the main path; never turn an AI bookkeeping failure into
		// a failed publish.
		console.warn(
			'[ai] enqueueTranslationsAfterPublish failed',
			caught instanceof Error ? caught.message : caught
		);
	}
}

export type AcceptTranslationResult =
	| { kind: 'accepted'; targetId: string; targetType: 'post' | 'note' }
	| { kind: 'not-found' }
	| { kind: 'not-draft' }
	| { kind: 'empty' }
	| { kind: 'stale' }
	| { kind: 'source-missing' }
	| { kind: 'target-published' }
	| { kind: 'target-conflict' }
	| { kind: 'target-draft-exists' }
	| { kind: 'slug-conflict' }
	| { kind: 'busy' };

async function sourceTitleAndHash(
	executor: DbExecutor,
	row: typeof translations.$inferSelect
): Promise<{
	title: string;
	content: string | null;
	summary: string | null;
	contentFormat: string;
	hash: string;
} | null> {
	if (row.sourcePostId) {
		const [source] = await executor
			.select({
				title: posts.title,
				content: posts.content,
				summary: posts.summary,
				contentFormat: posts.contentFormat
			})
			.from(posts)
			.where(eq(posts.id, row.sourcePostId))
			.limit(1);
		return source ? { ...source, hash: computeSourceHash(source) } : null;
	}
	if (row.sourceNoteId) {
		const [source] = await executor
			.select({
				title: notes.title,
				content: notes.content,
				contentFormat: notes.contentFormat
			})
			.from(notes)
			.where(eq(notes.id, row.sourceNoteId))
			.limit(1);
		return source
			? { ...source, summary: null, hash: computeSourceHash({ ...source, summary: null }) }
			: null;
	}
	return null;
}

/**
 * The accept transaction: validate the group/language/
 * pointer against the candidate, create or reuse the target working copy,
 * write the candidate into its draft, stamp `translation_origin`, and mark
 * the record accepted. It never publishes.
 */
export async function acceptTranslation(
	translationId: string,
	reviewerId: string | null
): Promise<AcceptTranslationResult> {
	try {
		return await db.transaction(async (tx) => {
			const [row] = await tx
				.select()
				.from(translations)
				.where(eq(translations.id, translationId))
				.limit(1)
				.for('update');
			if (!row) return { kind: 'not-found' as const };
			// Idempotent re-accept: a double click or a second tab arriving
			// after a successful accept replays the same outcome instead of a
			// 400 that looks like a failure.
			if (row.status === 'accepted') {
				const acceptedTargetId = row.targetPostId ?? row.targetNoteId;
				if (acceptedTargetId) {
					return {
						kind: 'accepted' as const,
						targetId: acceptedTargetId,
						targetType: row.targetPostId ? ('post' as const) : ('note' as const)
					};
				}
				return { kind: 'not-draft' as const };
			}
			if (row.status !== 'draft') return { kind: 'not-draft' as const };
			if (!row.content?.trim()) return { kind: 'empty' as const };
			const source = await sourceTitleAndHash(tx, row);
			if (!source) return { kind: 'source-missing' as const };
			if (row.sourceHash && row.sourceHash !== source.hash) return { kind: 'stale' as const };
			const isPost = Boolean(row.sourcePostId);
			const group = isPost
				? (
						await tx
							.select({
								group: posts.translationGroup,
								categoryId: posts.categoryId,
								slug: posts.slug,
								topicId: posts.id
							})
							.from(posts)
							.where(eq(posts.id, row.sourcePostId!))
							.limit(1)
					)[0]
				: null;
			const noteGroup = !isPost
				? (
						await tx
							.select({ group: notes.translationGroup, slug: notes.slug, topicId: notes.topicId })
							.from(notes)
							.where(eq(notes.id, row.sourceNoteId!))
							.limit(1)
					)[0]
				: null;
			const translationGroup = isPost ? group?.group : noteGroup?.group;
			if (!translationGroup) return { kind: 'source-missing' as const };
			const existingTarget = isPost
				? (
						await tx
							.select({
								id: posts.id,
								status: posts.status,
								translatedFrom: posts.translatedFromPostId,
								lang: posts.lang,
								slug: posts.slug,
								version: posts.version,
								translationOrigin: posts.translationOrigin
							})
							.from(posts)
							.where(
								and(eq(posts.translationGroup, translationGroup), eq(posts.lang, row.targetLang))
							)
							.limit(1)
							.for('update')
					)[0]
				: (
						await tx
							.select({
								id: notes.id,
								status: notes.status,
								translatedFrom: notes.translatedFromNoteId,
								lang: notes.lang,
								slug: notes.slug,
								translationOrigin: notes.translationOrigin
							})
							.from(notes)
							.where(
								and(eq(notes.translationGroup, translationGroup), eq(notes.lang, row.targetLang))
							)
							.limit(1)
							.for('update')
					)[0];
			let targetId: string;
			// Notes carry no version column; only the post branch reads it.
			const targetBaseVersion = isPost
				? ((existingTarget as { version?: number } | undefined)?.version ?? 0)
				: 0;
			if (existingTarget) {
				const expectedSource = isPost ? row.sourcePostId : row.sourceNoteId;
				if (existingTarget.translatedFrom !== expectedSource)
					return { kind: 'target-conflict' as const };
				if (existingTarget.status !== 'draft') return { kind: 'target-published' as const };
				targetId = existingTarget.id;
			} else {
				const sourceSlug = isPost ? group?.slug : noteGroup?.slug;
				const slug = sourceSlug && !isPlaceholderSlug(sourceSlug) ? sourceSlug : tempSlug();
				if (isPost) {
					const categoryId = group?.categoryId;
					if (!categoryId) return { kind: 'source-missing' as const };
					const [created] = await tx
						.insert(posts)
						.values({
							title: row.title,
							slug,
							lang: row.targetLang,
							translationGroup,
							translatedFromPostId: row.sourcePostId,
							translationOrigin: row.origin,
							categoryId,
							status: 'draft',
							version: 0,
							updatedAt: new Date()
						})
						.returning({ id: posts.id });
					targetId = created.id;
				} else {
					const [created] = await tx
						.insert(notes)
						.values({
							title: row.title,
							slug,
							lang: row.targetLang,
							translationGroup,
							translatedFromNoteId: row.sourceNoteId,
							translationOrigin: row.origin,
							topicId: noteGroup?.topicId ?? null,
							status: 'draft',
							updatedAt: new Date()
						})
						.returning({ id: notes.id });
					targetId = created.id;
				}
			}

			// A hand-written working copy (manual translation path) must not be
			// silently overwritten by the first AI accept. After an AI accept the
			// target carries translationOrigin, so re-accepts keep working. The
			// exception is a retranslation the operator asked for by name: that
			// request already wrote `overwriteTarget` on the candidate, and the
			// draft it replaces is exactly the one it promised to replace.
			if (existingTarget && !existingTarget.translationOrigin && !row.overwriteTarget) {
				const [manualDraft] = await tx
					.select({ content: drafts.content })
					.from(drafts)
					.where(and(eq(drafts.refType, isPost ? 'post' : 'note'), eq(drafts.refId, targetId)))
					.limit(1);
				if (
					manualDraft &&
					(manualDraft.content ?? '').trim() &&
					manualDraft.content !== row.content
				) {
					return { kind: 'target-draft-exists' as const };
				}
			}
			const [existingDraft] = await tx
				.select()
				.from(drafts)
				.where(and(eq(drafts.refType, isPost ? 'post' : 'note'), eq(drafts.refId, targetId)))
				.limit(1)
				.for('update');
			const tagsForSource = isPost
				? await tx
						.select({ name: tags.name })
						.from(postTags)
						.innerJoin(tags, eq(postTags.tagId, tags.id))
						.where(eq(postTags.postId, row.sourcePostId!))
				: [];
			const draftValues = {
				title: row.title,
				slug: isPost ? (group?.slug ?? null) : (noteGroup?.slug ?? null),
				categoryId: isPost ? (group?.categoryId ?? null) : null,
				tags: tagsForSource.map((tag) => tag.name),
				content: row.content,
				contentFormat: row.contentFormat,
				summary: row.summary,
				topicId: !isPost ? (noteGroup?.topicId ?? null) : null,
				updatedAt: new Date()
			};
			let draftId: string;
			if (existingDraft) {
				await tx
					.update(drafts)
					.set({
						...draftValues,
						version: existingDraft.version + 1,
						baseVersion: targetBaseVersion
					})
					.where(eq(drafts.id, existingDraft.id));
				draftId = existingDraft.id;
			} else {
				const [createdDraft] = await tx
					.insert(drafts)
					.values({
						refType: isPost ? 'post' : 'note',
						refId: targetId,
						...draftValues,
						version: 1,
						baseVersion: 0,
						author: reviewerId
					})
					.returning({ id: drafts.id });
				draftId = createdDraft.id;
			}
			await syncFileReferences(tx, { type: 'draft', id: draftId }, keysFromContent(row.content));

			if (isPost) {
				await tx
					.update(posts)
					.set({ translationOrigin: row.origin, updatedAt: new Date() })
					.where(eq(posts.id, targetId));
			} else {
				await tx
					.update(notes)
					.set({ translationOrigin: row.origin, updatedAt: new Date() })
					.where(eq(notes.id, targetId));
			}
			await tx
				.update(translations)
				.set({
					status: 'accepted',
					targetPostId: isPost ? targetId : null,
					targetNoteId: isPost ? null : targetId,
					reviewedBy: reviewerId,
					reviewedAt: new Date(),
					error: null,
					updatedAt: new Date()
				})
				.where(eq(translations.id, translationId));
			return { kind: 'accepted' as const, targetId, targetType: isPost ? 'post' : 'note' };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		if (code === '23505') return { kind: 'slug-conflict' };
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

export async function discardTranslation(
	translationId: string
): Promise<{ kind: 'discarded' } | { kind: 'not-found' }> {
	// `cancel_requested` is the in-flight signal: the job re-checks it between
	// stages (and before writing the body) and stops without spending more.
	// A queued row is covered by the status change alone.
	const rows = await db
		.update(translations)
		.set({ status: 'discarded', error: null, cancelRequested: true, updatedAt: new Date() })
		.where(and(eq(translations.id, translationId), eq(translations.status, 'draft')))
		.returning({ id: translations.id });
	return rows.length > 0 ? { kind: 'discarded' } : { kind: 'not-found' };
}

/**
 * Permanently remove a discarded candidate. Only a discarded row may go: a
 * draft still owns a job and a lease, and an accepted row is the provenance of
 * a live target article, so both have to be discarded first. The delete is a
 * plain row delete — the target article (if any) is untouched.
 */
export async function deleteTranslation(
	translationId: string
): Promise<{ kind: 'deleted' } | { kind: 'not-found' } | { kind: 'not-discarded' }> {
	const rows = await db
		.delete(translations)
		.where(and(eq(translations.id, translationId), eq(translations.status, 'discarded')))
		.returning({ id: translations.id });
	if (rows.length > 0) return { kind: 'deleted' };
	// Distinguish "already gone" from "still not discarded" so the caller can
	// report the rule that was hit instead of a generic 404.
	const [existing] = await db
		.select({ status: translations.status })
		.from(translations)
		.where(eq(translations.id, translationId))
		.limit(1);
	return existing ? { kind: 'not-discarded' } : { kind: 'not-found' };
}

/**
 * Drop every discarded row. The per-row delete exists for "this one was
 * wrong"; this is the housekeeping sweep the workbench otherwise makes the
 * operator do by hand, one click per row.
 */
export async function purgeDiscardedTranslations(): Promise<number> {
	const rows = await db
		.delete(translations)
		.where(eq(translations.status, 'discarded'))
		.returning({ id: translations.id });
	return rows.length;
}

export async function retryTranslation(
	translationId: string
): Promise<{ kind: 'queued' } | { kind: 'not-found' }> {
	// A human retry starts a fresh run: reset the failure/claim counters and
	// chunk progress, or an abandoned row would re-abandon on its next error
	// and a crash-loop row would never be claimable again. The heartbeat is
	// left alone so a run that is still in flight keeps its lease.
	const rows = await db
		.update(translations)
		.set({
			content: null,
			error: null,
			attempt: 0,
			runs: 0,
			stage: null,
			waitingReason: null,
			cancelRequested: false,
			// The overwrite permission is for one accept, not for the row's
			// lifetime: a retried row must not silently clobber a target draft
			// that a human edited in the meantime.
			overwriteTarget: false,
			progress: null,
			updatedAt: new Date()
		})
		.where(and(eq(translations.id, translationId), eq(translations.status, 'draft')))
		.returning({ id: translations.id });
	if (rows.length === 0) return { kind: 'not-found' };
	try {
		await enqueueJob(db, TRANSLATION_JOB, 'manual');
	} catch (caught) {
		console.warn('[ai] retry enqueue failed', caught instanceof Error ? caught.message : caught);
	}
	return { kind: 'queued' };
}

/**
 * Explicit "resync from source": turn an accepted record back into a pending
 * work item. Nothing is overwritten until the operator accepts again. Resync
 * is only allowed while the target is still a draft: flipping an accepted
 * row back to draft after the target published would deadlock both sides
 * (accept refuses a published target, and the publish guard refuses any
 * non-accepted translation row).
 */
export async function resyncTranslation(
	translationId: string
): Promise<{ kind: 'queued' } | { kind: 'not-found' } | { kind: 'target-published' }> {
	const [row] = await db
		.select({
			id: translations.id,
			status: translations.status,
			targetPostId: translations.targetPostId,
			targetNoteId: translations.targetNoteId
		})
		.from(translations)
		.where(eq(translations.id, translationId))
		.limit(1);
	if (!row || row.status !== 'accepted') return { kind: 'not-found' };
	if (row.targetPostId) {
		const [target] = await db
			.select({ status: posts.status })
			.from(posts)
			.where(eq(posts.id, row.targetPostId))
			.limit(1);
		if (target && target.status !== 'draft') return { kind: 'target-published' };
	}
	if (row.targetNoteId) {
		const [target] = await db
			.select({ status: notes.status })
			.from(notes)
			.where(eq(notes.id, row.targetNoteId))
			.limit(1);
		if (target && target.status !== 'draft') return { kind: 'target-published' };
	}
	// Resync is a fresh run too: clear the previous run's lease leftovers so
	// the resynced row is claimable immediately and starts at the body phase.
	const rows = await db
		.update(translations)
		.set({
			status: 'draft',
			content: null,
			error: null,
			attempt: 0,
			runs: 0,
			stage: null,
			waitingReason: null,
			heartbeatAt: null,
			cancelRequested: false,
			progress: null,
			// Resync is asked for by hand, so the next accept may replace the
			// target body even if no AI accept wrote it yet.
			overwriteTarget: true,
			updatedAt: new Date()
		})
		.where(and(eq(translations.id, translationId), eq(translations.status, 'accepted')))
		.returning({ id: translations.id });
	if (rows.length === 0) return { kind: 'not-found' };
	try {
		await enqueueJob(db, TRANSLATION_JOB, 'manual');
	} catch (caught) {
		console.warn('[ai] resync enqueue failed', caught instanceof Error ? caught.message : caught);
	}
	return { kind: 'queued' };
}

export type RetranslateResult =
	| { kind: 'queued'; id: string }
	| { kind: 'not-found' }
	| { kind: 'same-lang' }
	| { kind: 'skipped'; reason: 'not-source' | 'empty-source' | 'bad-lang' }
	| { kind: 'target-published' };

/**
 * "Translate this draft again": request a new candidate for a language whose
 * target row already exists, because the operator agreed to replace it.
 *
 * The two neighbouring paths cannot serve this case. `requestTranslation`
 * treats an existing usable row as "already translated" and refuses, and
 * `resyncTranslation` rewrites an accepted record, which a copy-prefill draft
 * (no AI record at all) does not have. The request marks the candidate
 * `overwriteTarget`, so the following accept is allowed to replace the draft
 * that this function validated as still unpublished.
 */
export async function requestRetranslation(input: {
	sourceType: 'post' | 'note';
	sourceId: string;
	targetLang: string;
}): Promise<RetranslateResult> {
	const isPost = input.sourceType === 'post';
	const source = isPost
		? await loadPostSource(input.sourceId)
		: await loadNoteSource(input.sourceId);
	if (!source) return { kind: 'not-found' };
	if (source.translatedFrom) return { kind: 'skipped', reason: 'not-source' };
	if (source.lang === input.targetLang) return { kind: 'same-lang' };
	if (!(OPTION_LANGS as readonly string[]).includes(input.targetLang)) {
		return { kind: 'skipped', reason: 'bad-lang' };
	}
	if (!(source.content ?? '').trim()) return { kind: 'skipped', reason: 'empty-source' };

	// A published or scheduled target has a public URL and its own history;
	// rewriting it is a new translation, not a retake of this draft.
	const [target] = isPost
		? await db
				.select({ id: posts.id, status: posts.status })
				.from(posts)
				.where(
					and(eq(posts.translationGroup, source.translationGroup), eq(posts.lang, input.targetLang))
				)
				.limit(1)
		: await db
				.select({ id: notes.id, status: notes.status })
				.from(notes)
				.where(
					and(eq(notes.translationGroup, source.translationGroup), eq(notes.lang, input.targetLang))
				)
				.limit(1);
	if (!target) return { kind: 'not-found' };
	if (target.status !== 'draft') return { kind: 'target-published' };

	const sourceColumn = isPost
		? eq(translations.sourcePostId, source.id)
		: eq(translations.sourceNoteId, source.id);
	const [existing] = await db
		.select({ id: translations.id, status: translations.status })
		.from(translations)
		.where(
			and(
				sourceColumn,
				eq(translations.targetLang, input.targetLang),
				ne(translations.status, 'discarded')
			)
		)
		.orderBy(desc(translations.createdAt))
		.limit(1);

	// A fresh run: a stale lease, an old failure counter, chunk progress or a
	// previous body must not leak into it.
	const reset = {
		status: 'draft' as const,
		content: null,
		error: null,
		attempt: 0,
		runs: 0,
		stage: null,
		waitingReason: null,
		heartbeatAt: null,
		cancelRequested: false,
		progress: null,
		overwriteTarget: true,
		updatedAt: new Date()
	};

	let id: string;
	if (existing) {
		const rows = await db
			.update(translations)
			.set(reset)
			.where(and(eq(translations.id, existing.id), eq(translations.status, existing.status)))
			.returning({ id: translations.id });
		if (rows.length === 0) return { kind: 'not-found' };
		id = rows[0].id;
	} else {
		// The partial unique index arbitrates a concurrent request; losing the
		// insert means another tab already queued this language, which is the
		// same intent - reset that row instead of failing the click.
		const [created] = await db
			.insert(translations)
			.values({
				sourcePostId: isPost ? source.id : null,
				sourceNoteId: isPost ? null : source.id,
				targetLang: input.targetLang,
				title: source.title,
				content: null,
				summary: null,
				contentFormat: source.contentFormat,
				origin: 'ai',
				model: null,
				sourceHash: computeSourceHash(source),
				status: 'draft',
				error: null,
				overwriteTarget: true,
				updatedAt: new Date()
			})
			.onConflictDoNothing()
			.returning({ id: translations.id });
		if (created) {
			id = created.id;
		} else {
			const [raced] = await db
				.select({ id: translations.id })
				.from(translations)
				.where(
					and(
						sourceColumn,
						eq(translations.targetLang, input.targetLang),
						eq(translations.status, 'draft')
					)
				)
				.limit(1);
			if (!raced) return { kind: 'not-found' };
			await db.update(translations).set(reset).where(eq(translations.id, raced.id));
			id = raced.id;
		}
	}
	try {
		await enqueueJob(db, TRANSLATION_JOB, 'manual');
	} catch (caught) {
		console.warn(
			'[ai] retranslate enqueue failed',
			caught instanceof Error ? caught.message : caught
		);
	}
	return { kind: 'queued', id };
}

export interface TranslationListRow {
	id: string;
	status: string;
	targetLang: string;
	origin: string;
	title: string;
	sourceTitle: string | null;
	sourceType: 'post' | 'note';
	sourceId: string;
	targetPostId: string | null;
	targetNoteId: string | null;
	model: string | null;
	sourceHash: string | null;
	error: string | null;
	contentPreview: string | null;
	/** Live body while the row is generating; null on every idle row. */
	partial: string | null;
	createdAt: Date;
	updatedAt: Date | null;
}

export async function listTranslations(input: {
	status?: 'draft' | 'accepted' | 'discarded' | 'all';
	lang?: string;
	page?: number;
}): Promise<{
	rows: TranslationListRow[];
	total: number;
	counts: Record<string, number>;
	page: number;
}> {
	const status = input.status ?? 'draft';
	const page = Math.max(1, input.page ?? 1);
	const where = [] as ReturnType<typeof eq>[];
	if (status !== 'all') where.push(eq(translations.status, status));
	if (input.lang && (OPTION_LANGS as readonly string[]).includes(input.lang)) {
		where.push(eq(translations.targetLang, input.lang));
	}
	const whereClause = where.length > 0 ? and(...where) : undefined;
	const [rows, totalRow, countRows] = await Promise.all([
		db
			.select({
				id: translations.id,
				status: translations.status,
				targetLang: translations.targetLang,
				origin: translations.origin,
				title: translations.title,
				sourcePostId: translations.sourcePostId,
				sourceNoteId: translations.sourceNoteId,
				targetPostId: translations.targetPostId,
				targetNoteId: translations.targetNoteId,
				model: translations.model,
				sourceHash: translations.sourceHash,
				error: translations.error,
				content: translations.content,
				progress: translations.progress,
				createdAt: translations.createdAt,
				updatedAt: translations.updatedAt,
				postTitle: posts.title,
				noteTitle: notes.title
			})
			.from(translations)
			.leftJoin(posts, eq(translations.sourcePostId, posts.id))
			.leftJoin(notes, eq(translations.sourceNoteId, notes.id))
			.where(whereClause)
			.orderBy(desc(translations.createdAt))
			.limit(PAGE_SIZE)
			.offset((page - 1) * PAGE_SIZE),
		db.select({ n: count() }).from(translations).where(whereClause),
		db
			.select({ status: translations.status, n: count() })
			.from(translations)
			.groupBy(translations.status)
	]);
	const counts: Record<string, number> = {};
	for (const row of countRows) counts[row.status] = Number(row.n);
	return {
		rows: rows.map((row) => ({
			id: row.id,
			status: row.status,
			targetLang: row.targetLang,
			origin: row.origin,
			title: row.title,
			sourceTitle: row.postTitle ?? row.noteTitle ?? null,
			sourceType: row.sourcePostId ? 'post' : 'note',
			sourceId: (row.sourcePostId ?? row.sourceNoteId)!,
			targetPostId: row.targetPostId,
			targetNoteId: row.targetNoteId,
			model: row.model,
			sourceHash: row.sourceHash,
			error: row.error,
			contentPreview: row.content ? row.content.slice(0, 280) : null,
			partial: row.progress?.partial ?? null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt
		})),
		total: Number(totalRow[0]?.n ?? 0),
		counts,
		page
	};
}

export type TranslationPreviewRow = {
	id: string;
	title: string;
	targetLang: string;
	status: string;
	origin: string;
	model: string | null;
	error: string | null;
	/** The finished body; null while the row is still generating. */
	content: string | null;
	/** Body received so far when `content` is null. */
	partial: string | null;
	summary: string | null;
	sourceTitle: string | null;
	/** The body the model translated from, for a side-by-side read. */
	sourceContent: string | null;
	sourceType: 'post' | 'note';
	updatedAt: Date | null;
};

/**
 * One candidate with both bodies, for the workbench preview sheet. The list
 * read ships only a 280-character excerpt, so opening a preview fetches the
 * full row (and its source) instead of inflating every list page.
 */
export async function getTranslationPreview(id: string): Promise<TranslationPreviewRow | null> {
	const [row] = await db
		.select({
			id: translations.id,
			title: translations.title,
			targetLang: translations.targetLang,
			status: translations.status,
			origin: translations.origin,
			model: translations.model,
			error: translations.error,
			content: translations.content,
			summary: translations.summary,
			progress: translations.progress,
			sourcePostId: translations.sourcePostId,
			updatedAt: translations.updatedAt,
			postTitle: posts.title,
			postContent: posts.content,
			noteTitle: notes.title,
			noteContent: notes.content
		})
		.from(translations)
		.leftJoin(posts, eq(translations.sourcePostId, posts.id))
		.leftJoin(notes, eq(translations.sourceNoteId, notes.id))
		.where(eq(translations.id, id))
		.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		targetLang: row.targetLang,
		status: row.status,
		origin: row.origin,
		model: row.model,
		error: row.error,
		content: row.content,
		partial: row.progress?.partial ?? null,
		summary: row.summary,
		sourceTitle: row.postTitle ?? row.noteTitle ?? null,
		sourceContent: row.postContent ?? row.noteContent ?? null,
		sourceType: row.sourcePostId ? 'post' : 'note',
		updatedAt: row.updatedAt
	};
}

export type GroupCandidate = {
	id: string;
	targetLang: string;
	status: 'draft' | 'accepted' | 'discarded';
	title: string;
	content: string | null;
	summary: string | null;
	model: string | null;
	error: string | null;
	sourceHash: string | null;
	/** 'waiting' when a rate limit / network / budget pause parked the row. */
	stage: string | null;
	/** Why the row is parked; null outside `stage = 'waiting'`. */
	waitingReason: string | null;
	/**
	 * Body text received so far while the run streams. Null unless the row is
	 * generating right now, so the drawer can preview it before `content` lands.
	 */
	partial: string | null;
	/** Chunk counters from `progress`; null on a non-chunked or idle row. */
	chunksDone: number | null;
	chunksTotal: number | null;
	/**
	 * Glossary terms the prompt required but the finished body lacks. Null when
	 * the run used no glossary or every term landed.
	 */
	glossaryMisses: { term: string; expected: string }[] | null;
	updatedAt: Date;
};

/**
 * The editor drawer's narrow read: every candidate row of one translation
 * group, newest first. The group source is the one row without a
 * `translatedFrom` link; without it the group has nothing to translate.
 */
export async function listCandidatesForGroup(
	sourceType: 'post' | 'note',
	group: string
): Promise<GroupCandidate[]> {
	const [source] =
		sourceType === 'post'
			? await db
					.select({ id: posts.id })
					.from(posts)
					.where(and(eq(posts.translationGroup, group), isNull(posts.translatedFromPostId)))
					.limit(1)
			: await db
					.select({ id: notes.id })
					.from(notes)
					.where(and(eq(notes.translationGroup, group), isNull(notes.translatedFromNoteId)))
					.limit(1);
	if (!source) return [];
	const rows = await db
		.select({
			id: translations.id,
			targetLang: translations.targetLang,
			status: translations.status,
			title: translations.title,
			content: translations.content,
			summary: translations.summary,
			model: translations.model,
			error: translations.error,
			sourceHash: translations.sourceHash,
			stage: translations.stage,
			waitingReason: translations.waitingReason,
			progress: translations.progress,
			updatedAt: translations.updatedAt
		})
		.from(translations)
		.where(
			sourceType === 'post'
				? eq(translations.sourcePostId, source.id)
				: eq(translations.sourceNoteId, source.id)
		)
		.orderBy(desc(translations.createdAt));
	return rows.map((row) => ({
		id: row.id,
		targetLang: row.targetLang,
		status: row.status as GroupCandidate['status'],
		title: row.title,
		content: row.content,
		summary: row.summary,
		model: row.model,
		error: row.error,
		sourceHash: row.sourceHash,
		stage: row.stage,
		waitingReason: row.waitingReason,
		partial: row.progress?.partial ?? null,
		chunksDone: row.progress?.done ?? null,
		chunksTotal: row.progress?.total ?? null,
		glossaryMisses: row.progress?.glossaryMisses?.length ? row.progress.glossaryMisses : null,
		// Nullable in the schema; every insert path writes it.
		updatedAt: row.updatedAt as Date
	}));
}

/** Publish guard: an AI-generated target row must be accepted first. */
export async function assertTranslationAccepted(
	executor: DbExecutor,
	targetId: string,
	arc: 'post' | 'note'
) {
	const [row] = await executor
		.select({ id: translations.id, status: translations.status })
		.from(translations)
		.where(
			and(
				arc === 'post'
					? eq(translations.targetPostId, targetId)
					: eq(translations.targetNoteId, targetId),
				ne(translations.status, 'accepted')
			)
		)
		.limit(1);
	return row === undefined;
}
