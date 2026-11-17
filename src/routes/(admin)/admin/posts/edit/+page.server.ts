import { error, fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { aiProviders } from '$lib/server/db/ai';
import { jobRuns } from '$lib/server/db/system';
import { categories, drafts, postTags, posts, tags } from '$lib/server/db/content';
import {
	normalizeProvenance,
	postProvenanceFromPayload
} from '$lib/server/db/content/post-provenance';
import { requireAdminRole } from '$lib/server/authz';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { syncFileReferences } from '$lib/server/services/file-references';
import { aiReadiness as computeReadiness } from '$lib/server/services/ai-readiness';
import { resolveWriterLang } from '$lib/server/services/writer-lang';
import { readBudgetState } from '$lib/server/ai/budget';
import { isValidTaxonomySlug, TAXONOMY_LOCALES } from '$lib/server/services/taxonomy';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import {
	createTranslationDraft,
	discardDraft,
	isPlaceholderSlug,
	loadDraftByPostId,
	publishDraft,
	saveDraftWork,
	type DraftPayload
} from '$lib/server/services/post-drafts';
import { isUuid } from '$lib/utils/uuid';
import {
	acceptTranslation,
	discardTranslation,
	enqueueTranslationsAfterPublish,
	listCandidatesForGroup,
	requestTranslation,
	requestRetranslation,
	resyncTranslation,
	retryTranslation,
	TRANSLATION_JOB,
	type GroupCandidate
} from '$lib/server/services/translations';
import { acceptMessage, requestMessage } from '$lib/server/services/translation-error-messages';
import {
	translationPresenceForGroup,
	type TranslationPresenceEntry
} from '$lib/server/services/translation-presence';
import {
	enqueueSummaryAfterPublish,
	listSummaries,
	generateAndStoreSummary,
	adoptSummary,
	discardSummary
} from '$lib/server/services/summaries';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * Editor: the post row is the published version and is only written by the publish
 * transaction; all editing goes through a single `drafts` row per target. Autosave
 * and the manual save share one action - the client only differs in the throttle
 * flag.
 */

type SwitchLangOutcome =
	{ kind: 'not-found' } | { kind: 'not-source' } | { kind: 'ok'; id: string };

/** What the drawer may say about the queue, without a per-row claim column yet. */
export interface TranslationJobState {
	/** Age of the oldest queued `ai.translate` run, or null when none is queued. */
	queuedAgeSec: number | null;
	/** How long the drain has been executing this job, or null when idle. */
	runningSinceSec: number | null;
	lastStatus: string | null;
}

/**
 * `job_runs` is the only honest source of liveness today: a queued row older
 * than a tick means no worker has claimed the work (no drain in dev, a dead
 * timer in prod). Once per-row `started_at`/`heartbeat_at` land, this stays as
 * the job-level view the drawer shows above the row-level one.
 */
async function translationJobState(now = Date.now()): Promise<TranslationJobState> {
	try {
		const rows = await db
			.select({
				status: jobRuns.status,
				createdAt: jobRuns.createdAt,
				startedAt: jobRuns.startedAt
			})
			.from(jobRuns)
			.where(eq(jobRuns.job, TRANSLATION_JOB))
			.orderBy(desc(jobRuns.createdAt))
			.limit(10);
		const queued = rows.find((row) => row.status === 'queued');
		const running = rows.find((row) => row.status === 'running');
		const age = (from: Date | null): number | null =>
			from === null ? null : Math.max(0, Math.round((now - from.getTime()) / 1000));
		return {
			queuedAgeSec: queued ? age(queued.createdAt) : null,
			runningSinceSec: running ? age(running.startedAt) : null,
			lastStatus: rows[0]?.status ?? null
		};
	} catch {
		// Liveness is an enhancement: a job_runs read failure must never take
		// the drawer's status endpoint down with it.
		return { queuedAgeSec: null, runningSinceSec: null, lastStatus: null };
	}
}

async function loadTagNames(postId: string): Promise<string[]> {
	const rows = await db
		.select({ name: tags.name })
		.from(postTags)
		.innerJoin(tags, eq(postTags.tagId, tags.id))
		.where(eq(postTags.postId, postId))
		.orderBy(tags.name);
	return rows.map((r) => r.name);
}

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

type DraftFormRead =
	| { error: string }
	| {
			postId: string | null;
			draftId: string | null;
			expectedVersion: number | null;
			lang: string | null;
			payload: DraftPayload;
	  };

/**
 * Shared reader for `save` and `publish`. Both carry the same payload because
 * publish is save→publish inside ONE request: a client-side save followed by a
 * `requestSubmit()` of a hidden form races the two requests, so a first-time
 * publish (no draft row yet) only ever saved.
 */
function readDraftForm(form: FormData): DraftFormRead {
	const rawId = str(form, 'id').trim();
	const draftId = str(form, 'draftId').trim();
	const versionRaw = str(form, 'draftVersion').trim();
	const langRaw = str(form, 'lang').trim();
	if (rawId && !isUuid(rawId)) return { error: m.admin_posts_edit_err_bad_post_id() };
	if (draftId && !isUuid(draftId)) return { error: m.admin_posts_edit_err_bad_draft_id() };
	// Malformed category ids must never reach the uuid column (22P02 -> 500).
	const categoryIdRaw = str(form, 'categoryId').trim();
	if (categoryIdRaw && !isUuid(categoryIdRaw))
		return { error: m.admin_posts_edit_err_bad_category_id() };
	return {
		postId: rawId || null,
		draftId: draftId || null,
		// A non-numeric version is treated as "not provided" (Number('abc') is
		// NaN, which used to make every save a permanent 409; review finding).
		expectedVersion: /^\d+$/.test(versionRaw) ? Number(versionRaw) : null,
		lang: (OPTION_LANGS as readonly string[]).includes(langRaw) ? langRaw : null,
		payload: {
			title: str(form, 'title'),
			slug: str(form, 'slug').trim().toLowerCase(),
			categoryId: categoryIdRaw,
			summary: str(form, 'summary'),
			tags: str(form, 'tags'),
			content: str(form, 'content'),
			provenance: normalizeProvenance({
				writingOrigin: str(form, 'writingOrigin') || null,
				aiHelp: str(form, 'aiHelp')
			})
		}
	};
}

export const load: PageServerLoad = async ({ url, locals }) => {
	await requireAdminRole();

	const [allCategories, defaultCategoryRows, defaultLang] = await Promise.all([
		db
			.select({ id: categories.id, name: categories.name, slug: categories.slug })
			.from(categories)
			.orderBy(categories.name),
		// The fallback category: the editor pre-selects it so a first save can
		// proceed, and links to the categories page when there is none.
		db
			.select({ id: categories.id })
			.from(categories)
			.where(eq(categories.isDefault, true))
			.limit(1),
		// A new article starts in the author's language; existing posts keep
		// reading their own `post.lang` in the editor.
		resolveWriterLang(locals.user?.id ?? null)
	]);
	const langs: string[] = [...OPTION_LANGS];

	// ?id= loads an existing post; without it this page creates a new article.
	const id = url.searchParams.get('id');
	if (id && !isUuid(id)) error(404, m.admin_posts_edit_err_not_found());

	let post = null;
	let draft = null;
	let source = null;
	let siblings: { id: string; lang: string; status: string }[] = [];
	// The drawer's state rides on this load so opening it costs no request; a
	// brand-new article has no group yet.
	let translationGroup: string | null = null;
	let translationCandidates: GroupCandidate[] = [];
	let translationPresence: Record<string, TranslationPresenceEntry> = {};
	let sourcePostId: string | null = null;

	if (id) {
		const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
		if (!row) error(404, m.admin_posts_edit_err_not_found());
		const tagNames = await loadTagNames(row.id);
		post = {
			id: row.id,
			title: row.title,
			slug: row.slug,
			categoryId: row.categoryId,
			summary: row.summary,
			content: row.content,
			status: row.status,
			lang: row.lang,
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			tags: tagNames.join(','),
			placeholder: isPlaceholderSlug(row.slug),
			translatedFromPostId: row.translatedFromPostId,
			provenance: {
				writingOrigin: row.writingOrigin,
				aiHelp: row.aiHelp ?? []
			}
		};

		const draftRow = await loadDraftByPostId(row.id);
		if (draftRow) {
			draft = {
				id: draftRow.id,
				version: draftRow.version,
				title: draftRow.title,
				slug: draftRow.slug,
				categoryId: draftRow.categoryId,
				summary: draftRow.summary,
				content: draftRow.content,
				tags: (draftRow.tags ?? []).join(','),
				updatedAt: draftRow.updatedAt,
				provenance: postProvenanceFromPayload(draftRow.payload)
			};
		}

		if (row.translatedFromPostId) {
			const [sourceRow] = await db
				.select({
					id: posts.id,
					title: posts.title,
					slug: posts.slug,
					lang: posts.lang,
					content: posts.content,
					summary: posts.summary,
					writingOrigin: posts.writingOrigin,
					aiHelp: posts.aiHelp
				})
				.from(posts)
				.where(eq(posts.id, row.translatedFromPostId))
				.limit(1);
			source = sourceRow ?? null;
			if (sourceRow && post) {
				// The disabled controls should show what the public page will
				// inherit, not the translation row's empty columns.
				post.provenance = {
					writingOrigin: post.provenance.writingOrigin ?? sourceRow.writingOrigin,
					aiHelp: post.provenance.aiHelp.length ? post.provenance.aiHelp : (sourceRow.aiHelp ?? [])
				};
			}
		}

		siblings = await db
			.select({ id: posts.id, lang: posts.lang, status: posts.status })
			.from(posts)
			.where(and(eq(posts.translationGroup, row.translationGroup), ne(posts.id, row.id)));

		// A translation row's own id is never the group source: the drawer keys
		// its chips off the row the group was created from.
		translationGroup = row.translationGroup;
		sourcePostId = source?.id ?? row.id;
		[translationCandidates, translationPresence] = await Promise.all([
			listCandidatesForGroup('post', row.translationGroup),
			translationPresenceForGroup('post', row.translationGroup)
		]);
	}

	const [summaryCandidates, aiAssignments, providerRows] = await Promise.all([
		post?.id ? listSummaries(post.id) : Promise.resolve([]),
		getOption('ai.assignments'),
		db
			.select({
				name: aiProviders.name,
				enabled: aiProviders.enabled,
				apiKeyEnv: aiProviders.apiKeyEnv,
				models: aiProviders.models
			})
			.from(aiProviders)
	]);

	// Readiness, not "is a provider named": the button has to be able to say
	// *why* it is disabled (provider turned off, key missing, no model) and the
	// badge must match what the runtime will actually do.
	const readiness = computeReadiness({
		providers: providerRows,
		assignments: aiAssignments,
		hasEnv: (name) => Boolean(env[name])
	});

	return {
		headerTitle: m.admin_nav_posts(),
		headerActions: [
			{
				label: m.admin_common_back(),
				iconName: 'arrow-left',
				variant: 'outline',
				href: '/admin/posts'
			},
			// Translation and summary calls record `related_id = sourceId`, so a
			// translation must link to its source or the ledger looks empty.
			// Only existing content has history; a brand-new draft has none.
			...(sourcePostId
				? [
						{
							label: m.admin_ai_usage_action(),
							iconName: 'chart-bar',
							variant: 'outline' as const,
							href: `/admin/ai?relatedType=post&relatedId=${sourcePostId}`
						}
					]
				: []),
			{
				label: m.admin_posts_edit_save_draft(),
				iconName: 'device-floppy',
				variant: 'outline',
				actionId: 'posts:edit:save'
			},
			{
				label: m.admin_posts_edit_publish(),
				iconName: 'cloud-upload',
				variant: 'default',
				actionId: 'posts:edit:publish'
			}
		],
		categories: allCategories,
		defaultCategoryId: defaultCategoryRows[0]?.id ?? null,
		langs,
		defaultLang,
		post,
		draft,
		source,
		siblings,
		translationGroup,
		translationCandidates,
		translationPresence,
		sourcePostId,
		summaryCandidates,
		readiness
	};
};

export const actions: Actions = {
	/**
	 * Autosave (`autosave=1`) and the manual "Save draft" share this action.
	 * Returns `{ saved }` payloads; conflicts answer 409 so the client can
	 * refuse to overwrite.
	 */
	save: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const read = readDraftForm(form);
		if ('error' in read) return fail(400, { message: read.error });

		const result = await saveDraftWork({
			draftId: read.draftId,
			postId: read.postId,
			expectedVersion: read.expectedVersion,
			// A payload without a language still means "the author's language".
			lang: read.lang ?? (await resolveWriterLang(locals.user?.id ?? null)),
			payload: read.payload,
			author: locals.admin?.userId ?? locals.user?.id ?? null,
			autosave: form.get('autosave') === '1'
		});

		switch (result.kind) {
			case 'saved':
				return {
					saved: true,
					draftId: result.draftId,
					draftVersion: result.version,
					postId: result.postId || null,
					updatedAt: result.updatedAt
				};
			case 'unchanged':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					postId: result.postId || null
				};
			case 'throttled':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					postId: result.postId || null,
					// The client schedules its retry from this hint.
					retryAfterMs: result.retryAfterMs
				};
			case 'needs-category':
				return fail(400, { message: m.admin_posts_edit_pick_category_hint(), needsCategory: true });
			case 'needs-default-category':
				return fail(400, {
					message: m.admin_posts_edit_err_no_default_category(),
					defaultCategoryMissing: true
				});
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_not_found() });
			case 'conflict':
				return fail(409, {
					conflict: true,
					server: result.server,
					message: m.admin_posts_edit_err_conflict_long()
				});
		}
	},

	/**
	 * Publish in ONE request: persist the working copy and publish
	 * it in the same action. The save is manual, so it bypasses the autosave
	 * throttle and the publish always sees exactly what was posted.
	 */
	publish: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const read = readDraftForm(form);
		if ('error' in read) return fail(400, { message: read.error });
		const author = locals.admin?.userId ?? locals.user?.id ?? null;

		const saved = await saveDraftWork({
			draftId: read.draftId,
			postId: read.postId,
			expectedVersion: read.expectedVersion,
			lang: read.lang ?? (await resolveWriterLang(locals.user?.id ?? null)),
			payload: read.payload,
			author,
			autosave: false
		});
		switch (saved.kind) {
			case 'needs-category':
				return fail(400, { message: m.admin_posts_edit_pick_category_hint(), needsCategory: true });
			case 'needs-default-category':
				return fail(400, {
					message: m.admin_posts_edit_err_no_default_category(),
					defaultCategoryMissing: true
				});
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_not_found() });
			case 'conflict':
				return fail(409, {
					conflict: true,
					server: saved.server,
					message: m.admin_posts_edit_err_conflict_long()
				});
			// A manual save must never be throttled; if the window is still closed
			// the publish would ship a stale body, so refuse rather than guess.
			case 'throttled':
				return fail(409, { message: m.admin_posts_edit_err_busy() });
			case 'saved':
			case 'unchanged':
				break;
		}

		const result = await publishDraft(saved.draftId, author);
		switch (result.kind) {
			case 'published':
				await enqueueTranslationsAfterPublish('post', result.postId);
				await enqueueSummaryAfterPublish(result.postId);
				throw redirect(303, `/admin/posts/edit?id=${result.postId}&published=1`);
			case 'invalid':
				return fail(400, {
					errors: result.errors,
					message: m.admin_posts_edit_err_publish_validation()
				});
			case 'conflict':
				return fail(409, {
					conflict: true,
					message: m.admin_posts_edit_err_base_updated(),
					server: result.server
				});
			case 'slug-taken':
				return fail(400, { errors: { slug: m.admin_posts_edit_err_slug_taken() } });
			case 'busy':
				return fail(409, { message: m.admin_posts_edit_err_busy() });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_draft_not_found() });
		}
	},

	/**
	 * Explicit discard: drop the working copy; a never-published
	 * placeholder posts row goes with it.
	 */
	discard: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });

		const result = await discardDraft(draftId);
		if (result.kind === 'not-found')
			return fail(404, { message: m.admin_posts_edit_err_draft_not_found() });
		if (result.kind === 'busy') return fail(409, { message: m.admin_posts_edit_err_busy() });
		if (result.removedPlaceholder) throw redirect(303, '/admin/posts?discarded=1');
		if (result.postId) throw redirect(303, `/admin/posts/edit?id=${result.postId}&discarded=1`);
		throw redirect(303, '/admin/posts?discarded=1');
	},

	/** Manual copy-prefill path for translations. */
	createTranslation: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const sourceId = str(form, 'id').trim();
		const lang = str(form, 'lang').trim();
		if (!sourceId || !isUuid(sourceId))
			return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		if (!(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, { message: m.admin_posts_edit_target_lang() });
		}

		const result = await createTranslationDraft(
			sourceId,
			lang,
			locals.admin?.userId ?? locals.user?.id ?? null
		);
		switch (result.kind) {
			case 'created':
				throw redirect(303, `/admin/posts/edit?id=${result.postId}&translation=1`);
			case 'same-lang':
				return fail(400, { message: m.admin_posts_edit_err_same_lang() });
			case 'lang-exists':
				return fail(400, { message: m.admin_posts_edit_err_lang_exists() });
			case 'not-source':
				return fail(400, { message: m.admin_posts_edit_err_from_source() });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_not_found() });
		}
	},

	/**
	 * Switch the article's source language. Translations are deliberately not
	 * re-linked (the family stays flat):
	 *  - `existing`: the version already in the target language becomes the
	 *    source; the current article and every other language version go away.
	 *  - `current` (default): the current article keeps its content and takes
	 *    the new language; the conflicting version in that language is deleted.
	 * Untouched translations keep pointing at the surviving source row.
	 */
	switchLang: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		const lang = str(form, 'lang').trim();
		const mode = str(form, 'mode').trim() === 'existing' ? 'existing' : 'current';
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		if (!(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, { message: m.admin_posts_edit_target_lang() });
		}

		let outcome: SwitchLangOutcome;
		try {
			outcome = await db.transaction(async (tx) => {
				const [row] = await tx
					.select({
						id: posts.id,
						lang: posts.lang,
						translationGroup: posts.translationGroup,
						translatedFromPostId: posts.translatedFromPostId
					})
					.from(posts)
					.where(eq(posts.id, id))
					.limit(1)
					.for('update');
				if (!row) return { kind: 'not-found' as const };
				// Only the group source owns the source language; a translation is
				// switched by promoting it through this same dialog instead.
				if (row.translatedFromPostId) return { kind: 'not-source' as const };
				if (row.lang === lang) return { kind: 'ok' as const, id: row.id };

				const family = await tx
					.select({
						id: posts.id,
						lang: posts.lang,
						translatedFromPostId: posts.translatedFromPostId
					})
					.from(posts)
					.where(eq(posts.translationGroup, row.translationGroup))
					.for('update');
				const target = family.find((member) => member.lang === lang && member.id !== row.id);

				if (target && mode === 'existing') {
					// Keep the target version only. Translations go first so the
					// source's SET NULL never leaves two NULL sources in the group.
					const doomed = family.filter((member) => member.id !== target.id);
					const draftRows = await tx
						.delete(drafts)
						.where(
							and(
								eq(drafts.refType, 'post'),
								inArray(
									drafts.refId,
									doomed.map((member) => member.id)
								)
							)
						)
						.returning({ id: drafts.id });
					const translations = doomed.filter((member) => member.translatedFromPostId);
					for (const member of translations) {
						await tx.delete(posts).where(eq(posts.id, member.id));
					}
					await tx.delete(posts).where(eq(posts.id, row.id));
					await tx
						.update(posts)
						.set({
							translatedFromPostId: null,
							translationOrigin: null,
							updatedAt: new Date()
						})
						.where(eq(posts.id, target.id));
					for (const draft of draftRows) {
						await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
					}
					for (const member of doomed) {
						await syncFileReferences(tx, { type: 'post', id: member.id }, []);
					}
					return { kind: 'ok' as const, id: target.id };
				}

				if (target) {
					// Keep the current article: only the conflicting version goes.
					const draftRows = await tx
						.delete(drafts)
						.where(and(eq(drafts.refType, 'post'), eq(drafts.refId, target.id)))
						.returning({ id: drafts.id });
					await tx.delete(posts).where(eq(posts.id, target.id));
					for (const draft of draftRows) {
						await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
					}
					await syncFileReferences(tx, { type: 'post', id: target.id }, []);
				}

				const [updated] = await tx
					.update(posts)
					.set({ lang, updatedAt: new Date() })
					.where(eq(posts.id, row.id))
					.returning({ id: posts.id });
				return updated ? { kind: 'ok' as const, id: updated.id } : { kind: 'not-found' as const };
			});
		} catch (caught) {
			if (pgErrorCode(caught) !== '23505') throw caught;
			return fail(409, { message: m.admin_posts_edit_switch_lang_conflict() });
		}

		if (outcome.kind === 'not-found')
			return fail(404, { message: m.admin_posts_edit_err_not_found() });
		if (outcome.kind === 'not-source')
			return fail(400, { message: m.admin_posts_edit_err_from_source() });
		throw redirect(303, `/admin/posts/edit?id=${outcome.id}`);
	},

	/**
	 * The drawer's refresh: the group's candidates plus its language presence.
	 * Takes the row the editor is on, not the group it loaded with: a post
	 * created in this page session has no group in `data` yet.
	 *
	 * `lang` names the language the drawer is painting; its draft row's
	 * `stage`/`waitingReason` ride the payload so a parked run can say why it
	 * is waiting instead of looking like a slow generation.
	 */
	translationStatus: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const postId = str(form, 'postId').trim();
		const lang = str(form, 'lang').trim();
		if (!postId || !isUuid(postId))
			return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		const [row] = await db
			.select({ translationGroup: posts.translationGroup })
			.from(posts)
			.where(eq(posts.id, postId))
			.limit(1);
		if (!row) return fail(404, { message: m.admin_posts_edit_err_not_found() });
		const [candidates, presence, job, budget] = await Promise.all([
			listCandidatesForGroup('post', row.translationGroup),
			translationPresenceForGroup('post', row.translationGroup),
			translationJobState(),
			// The budget is a display concern here: a paused budget is why a
			// queued row is not moving, and it must not fail the refresh.
			readBudgetState(db as never).catch(() => null)
		]);
		const current = (OPTION_LANGS as readonly string[]).includes(lang)
			? candidates.find(
					(candidate) => candidate.targetLang === lang && candidate.status === 'draft'
				)
			: undefined;
		return {
			candidates,
			presence,
			job,
			stage: current?.stage ?? null,
			waitingReason: current?.waitingReason ?? null,
			budget: budget
				? {
						paused: budget.paused,
						monthly: budget.monthly,
						spent: budget.spent,
						currency: budget.currency
					}
				: null
		};
	},

	/** Queue a candidate and answer with its id instead of redirecting. */
	requestTranslation: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		const lang = str(form, 'lang').trim();
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		if (!(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, { message: m.admin_posts_edit_target_lang() });
		}
		const result = await requestTranslation({
			sourceType: 'post',
			sourceId: id,
			targetLang: lang,
			manual: true,
			// Attribution for the ledger: the job runs later, in another
			// process, so the only place that knows who asked is right here.
			requestedBy: locals.admin?.userId ?? locals.user?.id ?? null
		});
		switch (result.kind) {
			case 'queued':
			case 'exists':
				return { candidateId: result.id };
			default:
				return fail(400, {
					message: requestMessage(result.kind, 'reason' in result ? result.reason : undefined)
				});
		}
	},

	/**
	 * Retranslate an existing draft target. The drawer asks for the operator's
	 * confirmation before sending this, because the new body replaces the text
	 * the draft already holds.
	 */
	retranslateDraft: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		const lang = str(form, 'lang').trim();
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		if (!(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, { message: m.admin_posts_edit_target_lang() });
		}
		const result = await requestRetranslation({
			sourceType: 'post',
			sourceId: id,
			targetLang: lang
		});
		switch (result.kind) {
			case 'queued':
				return { candidateId: result.id };
			case 'target-published':
				return fail(409, { message: m.admin_translations_err_resync_published() });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_not_found() });
			case 'same-lang':
				return fail(400, { message: m.admin_posts_edit_err_same_lang() });
			default:
				return fail(400, { message: requestMessage('skipped', result.reason) });
		}
	},

	/** Accept never redirects: the drawer decides what to do with the target. */
	acceptTranslation: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		const postId = str(form, 'postId').trim();
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const reviewer = locals.admin?.userId ?? locals.user?.id ?? null;
		const result = await acceptTranslation(id, reviewer);
		if (result.kind !== 'accepted') {
			return fail(result.kind === 'busy' ? 409 : 400, { message: acceptMessage(result.kind) });
		}
		return {
			targetId: result.targetId,
			targetType: result.targetType,
			isCurrent: result.targetType === 'post' && result.targetId === postId
		};
	},

	retryTranslation: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const result = await retryTranslation(id);
		if (result.kind === 'queued') return { ok: true };
		return fail(404, { message: m.admin_translations_err_candidate_missing() });
	},

	discardTranslation: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const result = await discardTranslation(id);
		if (result.kind === 'discarded') return { ok: true };
		return fail(404, { message: m.admin_translations_err_candidate_missing() });
	},

	resyncTranslation: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_translations_err_bad_id() });
		const result = await resyncTranslation(id);
		if (result.kind === 'queued') return { ok: true };
		if (result.kind === 'target-published') {
			return fail(409, { message: m.admin_translations_err_resync_published() });
		}
		return fail(404, { message: m.admin_translations_err_candidate_missing() });
	},

	generateSummary: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		const result = await generateAndStoreSummary(id, true, locals.user?.id ?? null);
		const candidates = await listSummaries(id);
		switch (result.kind) {
			case 'created':
			case 'existing':
				return { message: m.admin_posts_edit_summary_generated(), candidates };
			case 'too-short':
				return fail(400, { message: m.admin_posts_edit_summary_too_short() });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_not_found() });
			case 'error':
				console.warn('[ai] summary generation failed', result.message);
				return fail(502, { message: m.admin_posts_edit_summary_failed() });
		}
	},

	adoptSummary: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		const postId = str(form, 'postId').trim();
		if (!id || !isUuid(id) || !postId || !isUuid(postId))
			return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		const result = await adoptSummary(id, locals.admin?.userId ?? locals.user?.id ?? null);
		const candidates = await listSummaries(postId);
		if (result.kind === 'adopted')
			return { message: m.admin_posts_edit_summary_adopted(), candidates };
		if (result.kind === 'stale') return fail(409, { message: m.admin_posts_edit_summary_stale() });
		if (result.kind === 'busy') return fail(409, { message: m.admin_posts_edit_err_busy() });
		return fail(404, { message: m.admin_posts_edit_err_not_found() });
	},

	discardSummary: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		const postId = str(form, 'postId').trim();
		if (!id || !isUuid(id) || !postId || !isUuid(postId))
			return fail(400, { message: m.admin_posts_edit_err_bad_post_id() });
		const removed = await discardSummary(id);
		const candidates = await listSummaries(postId);
		return removed
			? { message: m.admin_posts_edit_summary_discarded(), candidates }
			: fail(404, { message: m.admin_posts_edit_err_not_found() });
	},

	/**
	 * Inline category creation for the editor. Same validation as
	 * the categories route's create action, but it ANSWERS with the new row
	 * instead of redirecting: the client appends it to its local option list and
	 * selects it at once. Never invalidates from here - that would re-run load
	 * and replay the server copy over the unsaved working copy.
	 */
	createCategory: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const name = str(form, 'name').trim();
		const slug = str(form, 'slug').trim().toLowerCase();
		const sourceLangRaw = str(form, 'sourceLang').trim();
		const sourceLang = (TAXONOMY_LOCALES as readonly string[]).includes(sourceLangRaw)
			? sourceLangRaw
			: 'zh-cn';

		if (!name) return fail(400, { error: m.admin_categories_err_name_required() });
		if (!slug) return fail(400, { error: m.admin_categories_err_slug_required() });
		if (!isValidTaxonomySlug(slug)) return fail(400, { error: m.admin_taxonomy_err_slug_shape() });

		try {
			const [created] = await db
				.insert(categories)
				.values({ name, slug, sourceLang })
				.returning({ id: categories.id, name: categories.name, slug: categories.slug });
			return { created };
		} catch (error) {
			if (pgErrorCode(error) !== '23505') throw error;
			return fail(409, { error: m.admin_categories_err_duplicate() });
		}
	}
} satisfies Actions;
