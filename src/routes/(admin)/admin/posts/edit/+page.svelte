<script lang="ts">
	import { untrack } from 'svelte';
	import { deserialize, enhance } from '$app/forms';
	import {
		afterNavigate,
		beforeNavigate,
		goto,
		invalidateAll,
		replaceState
	} from '$app/navigation';
	import { page } from '$app/state';
	import type { ActionResult } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { readinessTitle } from '$lib/utils/readiness-copy';
	import * as Select from '$lib/components/ui/select';
	import * as Field from '$lib/components/ui/field';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Button } from '$lib/components/ui/button';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as Alert from '$lib/components/ui/alert';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import TranslationDrawer, {
		type DrawerAction
	} from '$lib/components/admin/translation-drawer.svelte';
	import { drawerStateFor } from '$lib/utils/translation-drawer-state';
	import { MarkdownEditor } from '$lib/components/markdown';
	import { formatDateTime } from '$lib/utils/i18n';
	import { editorPayload } from '$lib/utils/editor-payload';
	import { normalizeSlug } from '$lib/utils/slug';
	import IconCategory from '@tabler/icons-svelte-runes/icons/category';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconFileDescription from '@tabler/icons-svelte-runes/icons/file-description';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconChevronUp from '@tabler/icons-svelte-runes/icons/chevron-up';
	import IconInfoCircle from '@tabler/icons-svelte-runes/icons/info-circle';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const AUTOSAVE_DEBOUNCE_MS = 2500;
	const THROTTLE_RETRY_MS = 12_000;

	// ── Editor state ─────────────────────────────────────────────────────
	let title = $state('');
	let slug = $state('');
	let slugTouched = $state(false);
	let categoryId = $state('');
	let summary = $state('');
	let summaryCandidates = $state<PageData['summaryCandidates']>(
		untrack(() => data.summaryCandidates ?? [])
	);
	let summaryBusy = $state(false);
	let summaryError = $state<string | null>(null);
	let tags = $state('');
	let writingOrigin = $state('');
	let aiHelp = $state('');
	let contentMarkdown = $state('');
	let lang = $state<string>(untrack(() => data.defaultLang));
	const isTranslation = $derived(Boolean(data.post?.translatedFromPostId));

	let postId = $state<string | null>(null);
	let draftId = $state<string | null>(null);
	let draftVersion = $state<number | null>(null);

	// One rule for what an AI control says about itself: readiness first, then
	// the other reasons it may be blocked, and only once it is usable does the
	// title describe what it would do. `readinessTitle` owns that rule.
	const summaryReady = $derived(data.readiness.summary.status === 'ready');

	const summaryTitle = $derived(
		!summaryReady
			? readinessTitle(data.readiness.summary, m.admin_posts_edit_summary_generate_hint())
			: !postId
				? m.admin_posts_edit_ai_save_first()
				: summaryBusy
					? m.admin_posts_edit_ai_busy()
					: isTranslation
						? m.admin_posts_edit_ai_not_source()
						: m.admin_posts_edit_summary_generate_hint()
	);

	// `savedSnapshot` mirrors the last payload the server acknowledged; the
	// dirty test and the publish flush both compare against it.
	let savedSnapshot = $state('');
	let lastSeen = $state('');
	let lastSavedAt = $state<Date | null>(null);
	type SaveState =
		| 'idle'
		| 'saved'
		| 'saving'
		| 'dirty'
		| 'throttled'
		| 'conflict'
		| 'error'
		| 'needs-category'
		| 'needs-default-category';
	let saveState = $state<SaveState>('idle');
	let saveError = $state<string | null>(null);
	let conflictMessage = $state<string | null>(null);
	let inFlight = false;
	let pendingResave = false;
	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

	let slugDialogOpen = $state(false);
	let discardOpen = $state(false);
	let publishing = $state(false);
	let publishErrors = $state<Record<string, string>>({});
	let flash = $state<string | null>(null);
	/** Set when an action answers with a redirect instead of data (session). */
	let reauthUrl = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;
	/** Set while we navigate on purpose (publish / discard / language switch). */
	let leavingIntentionally = false;

	// ── Metadata bar (horizontal, collapsible - never a Sheet) ────────────
	// Collapsed by default: the title and the body are the document, and the
	// bar's own summary line still names category, tags and AI provenance.
	let metaOpen = $state(false);

	// ── Inline category creation (no dialog, no invalidateAll) ────────────
	let categoryFormOpen = $state(false);
	let newCategoryName = $state('');
	let newCategorySlug = $state('');
	let newCategoryLang = $state<string>(untrack(() => data.defaultLang));
	let creatingCategory = $state(false);
	let categoryError = $state<string | null>(null);
	let localCategories = $state<{ id: string; name: string; slug: string }[]>([]);
	const categoryOptions = $derived([...data.categories, ...localCategories]);

	// ── Translation drawer ───────────────────────────────────────────────
	let drawerOpen = $state(false);
	let drawerLang = $state('');
	let drawerBusy = $state(false);
	let drawerError = $state<string | null>(null);
	let drawerNotice = $state<{ text: string; href: string } | null>(null);
	// Seeded from the load and re-seeded by `applyAll()`: the drawer refreshes
	// through `?/translationStatus`, never by invalidating the page.
	let translationCandidates = $state(untrack(() => data.translationCandidates ?? []));
	let translationPresence = $state(untrack(() => data.translationPresence ?? {}));
	/** Job-level liveness from `job_runs`; filled by the status action. */
	let translationJob = $state<{
		queuedAgeSec: number | null;
		runningSinceSec: number | null;
		lastStatus: string | null;
	} | null>(null);
	/** Budget pause is a display state: it explains why a queued row is idle. */
	let translationBudget = $state<{
		paused: boolean;
		monthly: number;
		spent: number;
		currency: string;
	} | null>(null);
	/** The drawn language's row state: `waiting` means parked, not generating. */
	let translationStage = $state<string | null>(null);
	let translationWaitingReason = $state<string | null>(null);

	const drawerCandidate = $derived(
		translationCandidates.find((c) => c.targetLang === drawerLang && c.status === 'draft') ?? null
	);
	const drawerState = $derived(
		drawerStateFor({
			lang: drawerLang,
			presence: translationPresence,
			candidates: translationCandidates
		})
	);
	// The row the drawer can open: presence is the only place that knows it, and
	// an accept into a new language shows up there on the next refresh.
	const drawerTargetId = $derived(translationPresence[drawerLang]?.postId ?? null);
	// Only a real draft can be retranslated: a `private`/`trash` target and a
	// published one are refused by the service, so the button must not appear.
	const canRetranslate = $derived(translationPresence[drawerLang]?.status === 'draft');
	// Translation reads the published body: a post that was never published has
	// none, so Generate must be explained rather than offered.
	const publishedBody = $derived(data.source?.content ?? data.post?.content ?? '');
	const canGenerate = $derived(Boolean(publishedBody.trim()));
	const drawerSource = $derived({
		lang: data.source?.lang ?? data.post?.lang ?? lang,
		content: publishedBody || contentMarkdown || null
	});

	// ── Source-language switch (translations are never re-linked) ────────
	let switchLangOpen = $state(false);
	let switchLangValue = $state('');
	let switchLangMode = $state('existing');
	let switchLangError = $state<string | null>(null);
	const canSwitchSource = $derived(Boolean(postId) && !isTranslation);
	const switchLangSibling = $derived(
		data.siblings?.find((sibling) => sibling.lang === switchLangValue) ?? null
	);

	/**
	 * Shared handler for the discard form: on failure the messages surface in
	 * the editor banners; on success/redirect the default update() runs.
	 */
	type FormResultInput = {
		result: ActionResult;
		update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void>;
	};
	const formResultHandler =
		() =>
		async ({ result, update }: FormResultInput) => {
			if (result.type === 'failure') {
				const d = (result.data ?? {}) as { message?: string; errors?: Record<string, string> };
				publishErrors = { ...(d.errors ?? {}) };
				if (d.message) publishErrors = { ...publishErrors, form: d.message };
				if (result.status === 409) conflictMessage = d.message ?? conflictMessage;
			} else {
				leavingIntentionally = true;
				await update();
			}
		};

	/** One place that speaks the JSON action protocol. */
	async function postAction(action: string, fd: FormData): Promise<ActionResult> {
		const response = await fetch(`?/${action}`, {
			method: 'POST',
			body: fd,
			// The JSON action protocol is selected by Accept negotiation; the
			// x-sveltekit-action header is only a bypass switch (probe finding).
			headers: { 'x-sveltekit-action': 'true', accept: 'application/json' }
		});
		return deserialize(await response.text());
	}

	function currentPayload(): string {
		return editorPayload({
			title,
			slug,
			categoryId,
			summary,
			tags,
			writingOrigin,
			aiHelp,
			contentMarkdown,
			lang
		});
	}

	function isDirty(): boolean {
		return currentPayload() !== savedSnapshot;
	}

	/** Narrowing-proof state readers ($state writes elsewhere confuse tsc). */
	function isSettledState(state: SaveState): boolean {
		return state === 'saved' || state === 'idle';
	}

	function applyAll() {
		const draft = data.draft;
		const post = data.post;
		title = draft?.title ?? post?.title ?? '';
		// Translations share one slug with the source: the editor shows the source address
		// (legacy drafts may still be empty).
		const loadedSlug =
			(draft ? (draft.slug ?? '') : post && !post.placeholder ? post.slug : '') ||
			data.source?.slug ||
			'';
		slug = loadedSlug;
		slugTouched = !!loadedSlug;
		categoryId = draft?.categoryId ?? post?.categoryId ?? data.defaultCategoryId ?? '';
		summary = draft?.summary ?? post?.summary ?? '';
		tags = draft?.tags ?? post?.tags ?? '';
		const provenance = draft?.provenance ?? post?.provenance;
		writingOrigin = provenance?.writingOrigin ?? '';
		aiHelp = (provenance?.aiHelp ?? []).join(', ');
		contentMarkdown = draft?.content ?? post?.content ?? '';
		lang = post?.lang ?? data.defaultLang;
		postId = post?.id ?? null;
		draftId = draft?.id ?? null;
		draftVersion = draft?.version ?? null;
		saveState = 'idle';
		saveError = null;
		conflictMessage = null;
		publishErrors = {};
		reauthUrl = null;
		lastSavedAt = null;
		translationCandidates = data.translationCandidates ?? [];
		translationPresence = data.translationPresence ?? {};
		const snapshot = currentPayload();
		savedSnapshot = snapshot;
		lastSeen = snapshot;
	}

	// Initialize from the load data (intentional first apply).
	applyAll();

	const dataKey = $derived(
		`${data.post?.id ?? 'new'}@${data.post?.version ?? 0}@${data.draft?.id ?? ''}@${data.draft?.version ?? 0}`
	);
	let loadedKey = $state(untrack(() => dataKey));
	$effect(() => {
		if (dataKey === loadedKey) return;
		loadedKey = dataKey;
		applyAll();
	});

	// ── Dirty tracking + autosave scheduling ─────────────────────────────
	$effect(() => {
		const current = currentPayload();
		if (current === lastSeen) return;
		lastSeen = current;
		onFieldsChanged();
	});

	function onFieldsChanged() {
		// Frozen after a conflict until the editor reloads the server state.
		if (saveState === 'conflict') return;
		if (publishErrors && Object.keys(publishErrors).length > 0) publishErrors = {};
		saveState = 'dirty';
		scheduleSave(AUTOSAVE_DEBOUNCE_MS);
	}

	/** One scheduler for both the debounce and the throttle/error retry. */
	function scheduleSave(delayMs: number) {
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => {
			autosaveTimer = null;
			if (saveState === 'conflict') return;
			void runSave(true);
		}, delayMs);
	}

	// ── Local stash: the last resort when a new article's save fails ──────
	const STASH_PREFIX = 'lair:posts:editor-stash';
	const STASH_MAX_BYTES = 4 * 1024 * 1024;
	const STASH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
	let stashTimer: ReturnType<typeof setTimeout> | null = null;

	function stashKey(): string {
		return `${STASH_PREFIX}:${data.post?.id ?? 'new'}`;
	}

	function clearStash() {
		try {
			sessionStorage.removeItem(stashKey());
		} catch {
			/* private mode / quota: the stash is best-effort */
		}
	}

	function writeStash() {
		// Only a brand-new article with nothing server-side to fall back on.
		if (postId || draftId) {
			clearStash();
			return;
		}
		try {
			const payload = currentPayload();
			if (payload.length > STASH_MAX_BYTES) return;
			sessionStorage.setItem(stashKey(), JSON.stringify({ at: Date.now(), payload }));
		} catch {
			/* quota exceeded or storage disabled: never break the editor */
		}
	}

	function scheduleStash() {
		if (stashTimer) clearTimeout(stashTimer);
		stashTimer = setTimeout(writeStash, 1000);
	}

	function applyStash(json: string) {
		try {
			const d = JSON.parse(json) as Record<string, string>;
			title = d.title ?? '';
			slug = d.slug ?? '';
			slugTouched = !!d.slug;
			categoryId = d.categoryId ?? '';
			summary = d.summary ?? '';
			tags = d.tags ?? '';
			writingOrigin = d.writingOrigin ?? '';
			aiHelp = d.aiHelp ?? '';
			contentMarkdown = d.contentMarkdown ?? '';
			if (d.lang) lang = d.lang;
		} catch {
			/* an unparsable stash is not worth restoring */
		}
	}

	function readStash(): string | null {
		try {
			const raw = sessionStorage.getItem(stashKey());
			if (!raw) return null;
			const parsed = JSON.parse(raw) as { at?: number; payload?: string };
			if (!parsed?.payload) return null;
			if (Date.now() - (parsed.at ?? 0) > STASH_MAX_AGE_MS) {
				clearStash();
				return null;
			}
			return parsed.payload;
		} catch {
			return null;
		}
	}

	// Restore before anything else can overwrite the working copy. `untrack`:
	// this reads the load result ONCE on purpose and must not become reactive.
	{
		const stashed = untrack(() => (!data.post && !data.draft ? readStash() : null));
		if (stashed) {
			applyStash(stashed);
			flash = m.admin_posts_edit_stash_restored();
			flashTimer = setTimeout(() => (flash = null), 3500);
		}
	}

	/** Working copy as form fields - shared by `save` and the single `publish`. */
	function draftForm(): FormData {
		const fd = new FormData();
		fd.set('title', title);
		fd.set('slug', slug);
		fd.set('categoryId', categoryId);
		fd.set('summary', summary);
		fd.set('tags', tags);
		fd.set('writingOrigin', writingOrigin);
		fd.set('aiHelp', aiHelp);
		fd.set('content', contentMarkdown);
		if (postId) fd.set('id', postId);
		if (draftId) fd.set('draftId', draftId);
		if (draftVersion != null) fd.set('draftVersion', String(draftVersion));
		if (!postId) fd.set('lang', lang);
		return fd;
	}

	async function runSave(autosave: boolean): Promise<boolean> {
		if (inFlight) {
			pendingResave = true;
			return false;
		}
		inFlight = true;
		saveState = 'saving';
		const snapshotAtSubmit = currentPayload();
		try {
			const fd = draftForm();
			fd.set('autosave', autosave ? '1' : '0');
			const result = await postAction('save', fd);
			if (result.type === 'redirect') {
				// A guard bounced us (session expired): stop the retry loop and
				// offer a re-login instead of blaming the network forever.
				saveState = 'error';
				saveError = m.admin_posts_edit_err_session_expired();
				reauthUrl = result.location ?? null;
			} else if (result.type === 'success') {
				const d = result.data as {
					saved: boolean;
					reason?: 'unchanged' | 'throttled';
					draftId: string;
					draftVersion: number;
					postId: string | null;
					retryAfterMs?: number;
					updatedAt?: Date | string | null;
				};
				reauthUrl = null;
				draftId = d.draftId;
				draftVersion = d.draftVersion;
				if (d.postId && d.postId !== postId) {
					postId = d.postId;
					// First save of a new article: anchor the URL to the row.
					replaceState(`/admin/posts/edit?id=${d.postId}${page.url.search}`, {});
				}
				if (d.saved || d.reason === 'unchanged') {
					savedSnapshot = snapshotAtSubmit;
					lastSavedAt = new Date();
					saveState = currentPayload() === savedSnapshot ? 'saved' : 'dirty';
					clearStash();
				} else if (d.reason === 'throttled') {
					saveState = 'throttled';
					// Retry when the server window has actually elapsed.
					const wait =
						typeof d.retryAfterMs === 'number' && d.retryAfterMs > 0
							? d.retryAfterMs + 1500
							: THROTTLE_RETRY_MS;
					scheduleSave(wait);
				}
			} else if (result.type === 'failure') {
				const d = (result.data ?? {}) as {
					message?: string;
					needsCategory?: boolean;
					defaultCategoryMissing?: boolean;
				};
				if (result.status === 409) {
					saveState = 'conflict';
					conflictMessage = d.message ?? m.admin_posts_edit_conflict_short();
				} else if (result.status === 400 && d.defaultCategoryMissing) {
					// Nothing to retry: the server has no fallback category and the
					// owner has to create one, so the banner takes over from the
					// stash/retry loop.
					saveState = 'needs-default-category';
					saveError = d.message ?? m.admin_posts_edit_err_no_default_category();
					scheduleStash();
				} else if (result.status === 400 && d.needsCategory) {
					saveState = 'needs-category';
					scheduleStash();
				} else {
					saveState = 'error';
					saveError = d.message ?? m.admin_posts_edit_err_save_failed();
					scheduleStash();
				}
			} else {
				saveState = 'error';
				saveError = m.admin_posts_edit_err_network();
				scheduleStash();
				scheduleSave(THROTTLE_RETRY_MS);
			}
		} catch {
			saveState = 'error';
			saveError = m.admin_posts_edit_err_network();
			scheduleStash();
			scheduleSave(THROTTLE_RETRY_MS);
		} finally {
			inFlight = false;
			if (pendingResave) {
				pendingResave = false;
				if (saveState !== 'conflict') scheduleSave(AUTOSAVE_DEBOUNCE_MS);
			} else if (saveState === 'saved' && currentPayload() !== savedSnapshot) {
				scheduleSave(AUTOSAVE_DEBOUNCE_MS);
			}
		}
		return isSettledState(saveState);
	}

	async function reloadFromServer() {
		leavingIntentionally = true;
		await invalidateAll();
		leavingIntentionally = false;
		applyAll();
	}

	/**
	 * Publish in ONE request (UX-1020-04): the action saves the working copy
	 * and publishes it together, so a first-time publish (no draft row yet) can
	 * no longer lose the race between the old two client-side requests.
	 */
	async function runPublish(): Promise<void> {
		if (inFlight) {
			for (let waited = 0; waited < 100 && inFlight; waited += 1) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (inFlight) return;
		}
		inFlight = true;
		saveState = 'saving';
		const snapshotAtSubmit = currentPayload();
		try {
			const result = await postAction('publish', draftForm());
			if (result.type === 'redirect') {
				leavingIntentionally = true;
				clearStash();
				savedSnapshot = snapshotAtSubmit;
				await goto(result.location);
				return;
			}
			if (result.type === 'success') {
				savedSnapshot = snapshotAtSubmit;
				clearStash();
				saveState = 'saved';
				return;
			}
			if (result.type === 'failure') {
				const d = (result.data ?? {}) as {
					message?: string;
					errors?: Record<string, string>;
					needsCategory?: boolean;
					defaultCategoryMissing?: boolean;
				};
				if (result.status === 409) {
					saveState = 'conflict';
					conflictMessage = d.message ?? m.admin_posts_edit_conflict_short();
					return;
				}
				if (result.status === 400 && d.defaultCategoryMissing) {
					// Same dead end as `runSave`: no fallback category exists, so the
					// banner takes over and the working copy still needs the stash.
					saveState = 'needs-default-category';
					saveError = d.message ?? m.admin_posts_edit_err_no_default_category();
					scheduleStash();
					return;
				}
				if (result.status === 400 && d.needsCategory) {
					saveState = 'needs-category';
					scheduleStash();
					return;
				}
				const graded = Object.values(d.errors ?? {}).filter(Boolean);
				publishErrors = { ...(d.errors ?? {}) };
				saveState = 'error';
				saveError =
					graded.length > 0
						? graded.join(m.admin_posts_edit_error_join())
						: (d.message ?? m.admin_posts_edit_err_publish_validation());
				scheduleStash();
				return;
			}
			saveState = 'error';
			saveError = m.admin_posts_edit_err_network();
			scheduleStash();
		} catch {
			saveState = 'error';
			saveError = m.admin_posts_edit_err_network();
			scheduleStash();
		} finally {
			inFlight = false;
		}
	}

	async function onPublish() {
		if (saveState === 'conflict' || publishing) return;
		publishing = true;
		try {
			await runPublish();
		} finally {
			publishing = false;
		}
	}

	/**
	 * Inline category creation (UX-1020-03): the result is appended to the
	 * LOCAL option list and selected at once - never `invalidateAll()`, which
	 * would re-run load and replay the server copy over unsaved edits.
	 */
	async function onCreateCategory() {
		const name = newCategoryName.trim();
		if (!name || creatingCategory) return;
		creatingCategory = true;
		categoryError = null;
		try {
			const fd = new FormData();
			fd.set('name', name);
			fd.set('slug', (newCategorySlug.trim() || name).toLowerCase());
			fd.set('sourceLang', newCategoryLang);
			const result = await postAction('createCategory', fd);
			if (result.type === 'success') {
				const created = (result.data as { created?: { id: string; name: string; slug: string } })
					.created;
				if (created) {
					localCategories = [
						...localCategories.filter((c) => c.id !== created.id),
						{ id: created.id, name: created.name, slug: created.slug }
					];
					categoryId = created.id;
					newCategoryName = '';
					newCategorySlug = '';
					categoryFormOpen = false;
				}
				return;
			}
			// Only a `failure` carries `data`; a redirect/error has none.
			const d = (result.type === 'failure' ? (result.data ?? {}) : {}) as {
				message?: string;
				error?: string;
			};
			categoryError = d.error ?? d.message ?? m.admin_posts_edit_create_category_failed();
		} catch {
			categoryError = m.admin_posts_edit_create_category_failed();
		} finally {
			creatingCategory = false;
		}
	}

	/**
	 * A language chip opens the drawer for that language. The chip is a state
	 * read-out; the drawer owns every verb.
	 */
	function openDrawerFor(target: string) {
		drawerLang = target;
		// Seed the row state from the copy the load already read so a parked
		// row explains itself on the first frame, before the first refresh.
		const seeded = translationCandidates.find(
			(candidate) => candidate.targetLang === target && candidate.status === 'draft'
		);
		translationStage = seeded?.stage ?? null;
		translationWaitingReason = seeded?.waitingReason ?? null;
		drawerError = null;
		drawerNotice = null;
		drawerOpen = true;
	}

	/** Re-read the row's candidates and presence without re-running the load. */
	async function refreshTranslationState(postId: string, lang: string) {
		const fd = new FormData();
		fd.set('postId', postId);
		fd.set('lang', lang);
		const result = await postAction('translationStatus', fd);
		if (result.type === 'success') {
			const d = result.data as {
				candidates: typeof translationCandidates;
				presence: typeof translationPresence;
				job?: typeof translationJob;
				stage?: string | null;
				waitingReason?: string | null;
				budget?: typeof translationBudget;
			};
			translationCandidates = d.candidates;
			translationPresence = d.presence;
			translationJob = d.job ?? null;
			translationStage = d.stage ?? null;
			translationWaitingReason = d.waitingReason ?? null;
			translationBudget = d.budget ?? null;
		}
	}

	/** The drawer asks for a verb; the editor speaks the action protocol. */
	async function runDrawerAction(action: DrawerAction) {
		if (drawerBusy) return;
		if (!postId) {
			// A brand-new article has no row to translate yet.
			drawerError = m.admin_posts_edit_ai_save_first();
			return;
		}
		drawerBusy = true;
		drawerError = null;
		drawerNotice = null;
		try {
			const fd = new FormData();
			if (action === 'generate') {
				fd.set('id', data.sourcePostId ?? postId);
				fd.set('lang', drawerLang);
				const r = await postAction('requestTranslation', fd);
				if (r.type === 'failure') drawerError = (r.data as { message?: string })?.message ?? null;
			} else if (action === 'accept' && drawerCandidate) {
				fd.set('id', drawerCandidate.id);
				fd.set('postId', postId);
				const r = await postAction('acceptTranslation', fd);
				if (r.type === 'failure') {
					drawerError = (r.data as { message?: string })?.message ?? null;
				} else if (r.type === 'success' && (r.data as { isCurrent?: boolean }).isCurrent) {
					// Accepted into the post being edited: only a full reload can
					// show it, and it must stay the author's own click.
					drawerNotice = {
						text: m.admin_posts_edit_translation_reload(),
						href: page.url.pathname + page.url.search
					};
				}
			} else if (action === 'retry' || action === 'discard') {
				if (drawerCandidate) fd.set('id', drawerCandidate.id);
				const r = await postAction(`${action}Translation`, fd);
				if (r.type === 'failure') drawerError = (r.data as { message?: string })?.message ?? null;
			} else if (action === 'retranslate') {
				fd.set('id', data.sourcePostId ?? postId);
				fd.set('lang', drawerLang);
				const r = await postAction('retranslateDraft', fd);
				if (r.type === 'failure') drawerError = (r.data as { message?: string })?.message ?? null;
			} else if (action === 'copy-source') {
				fd.set('id', data.sourcePostId ?? postId);
				fd.set('lang', drawerLang);
				leavingIntentionally = true;
				const r = await postAction('createTranslation', fd);
				if (r.type === 'redirect' && r.location) {
					await goto(r.location);
					return;
				}
				leavingIntentionally = false;
				if (r.type === 'failure') drawerError = (r.data as { message?: string })?.message ?? null;
			} else if (action === 'open-target' && drawerTargetId) {
				leavingIntentionally = true;
				await goto(`/admin/posts/edit?id=${drawerTargetId}`);
				return;
			}
			if (postId) await refreshTranslationState(postId, drawerLang);
		} catch {
			// A thrown transport failure must not pass for success: the copy-source
			// path arms the leave guard, and leaving it armed here would stop the
			// unsaved-changes prompt from protecting the editor for the session.
			drawerError = m.admin_translations_err_generic();
			leavingIntentionally = false;
		} finally {
			drawerBusy = false;
		}
	}

	// A queued candidate is the only state that changes without the drawer.
	// Poll while it is on screen and keep going: a multi-minute generation is
	// normal, so the old fixed 60s cap left the drawer claiming "generating"
	// with no way to ever learn otherwise. 2s while a run is likely streaming,
	// 5s after the first minute; stops on close, unmount, or the first
	// non-queued state.
	//
	// The effect keys on the BOOLEAN "is the drawer queued", not on
	// `drawerState` itself: a poll replaces the candidate array (progress,
	// partial body) while the state stays `queued`, and reacting to that would
	// cancel and restart the timer on every tick. The boolean flips exactly
	// twice per generation - and the false -> true flip is what starts the
	// loop after the operator clicks Generate on an already-open drawer.
	const drawerQueued = $derived(drawerState === 'queued');
	let queuedPolls = 0;
	$effect(() => {
		if (!drawerOpen || !drawerQueued) {
			queuedPolls = 0;
			return;
		}
		const id = postId;
		const lang = drawerLang;
		if (!id) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async (): Promise<void> => {
			queuedPolls += 1;
			try {
				await refreshTranslationState(id, lang);
			} catch {
				// A transport failure must not end the wait; the next tick retries.
			}
			if (cancelled) return;
			if (untrack(() => drawerState) !== 'queued') return;
			timer = setTimeout(() => void tick(), queuedPolls < 90 ? 2000 : 5000);
		};
		void tick();
		return () => {
			cancelled = true;
			if (timer !== null) clearTimeout(timer);
		};
	});

	/** Generate a summary candidate for the current post. */
	async function runGenerateSummary(): Promise<void> {
		if (!postId || summaryBusy) return;
		summaryBusy = true;
		summaryError = null;
		try {
			const fd = new FormData();
			fd.set('id', postId);
			const result = await postAction('generateSummary', fd);
			if (result.type === 'success') {
				const data = result.data as {
					message?: string;
					candidates?: PageData['summaryCandidates'];
				};
				summaryCandidates = data.candidates ?? summaryCandidates;
				flash = data.message ?? m.admin_posts_edit_summary_generated();
			} else if (result.type === 'failure') {
				summaryError =
					(result.data as { message?: string } | undefined)?.message ??
					m.admin_posts_edit_summary_failed();
			}
		} catch {
			summaryError = m.admin_posts_edit_summary_failed();
		} finally {
			summaryBusy = false;
		}
	}

	/** Adopt a candidate: writes posts.summary and mirrors the text into the draft. */
	async function runAdoptSummary(candidate: PageData['summaryCandidates'][number]): Promise<void> {
		if (!postId || summaryBusy) return;
		summaryBusy = true;
		summaryError = null;
		try {
			const fd = new FormData();
			fd.set('id', candidate.id);
			fd.set('postId', postId);
			const result = await postAction('adoptSummary', fd);
			if (result.type === 'success') {
				const data = result.data as {
					message?: string;
					candidates?: PageData['summaryCandidates'];
				};
				summaryCandidates = data.candidates ?? summaryCandidates;
				summary = candidate.summary;
				onFieldsChanged();
				flash = data.message ?? m.admin_posts_edit_summary_adopted();
			} else if (result.type === 'failure') {
				summaryError =
					(result.data as { message?: string } | undefined)?.message ??
					m.admin_posts_edit_summary_failed();
			}
		} catch {
			summaryError = m.admin_posts_edit_summary_failed();
		} finally {
			summaryBusy = false;
		}
	}

	async function runDiscardSummary(id: string): Promise<void> {
		if (!postId || summaryBusy) return;
		summaryBusy = true;
		summaryError = null;
		try {
			const fd = new FormData();
			fd.set('id', id);
			fd.set('postId', postId);
			const result = await postAction('discardSummary', fd);
			if (result.type === 'success') {
				const data = result.data as {
					message?: string;
					candidates?: PageData['summaryCandidates'];
				};
				summaryCandidates = data.candidates ?? summaryCandidates;
				flash = data.message ?? m.admin_posts_edit_summary_discarded();
			} else if (result.type === 'failure') {
				summaryError =
					(result.data as { message?: string } | undefined)?.message ??
					m.admin_posts_edit_summary_failed();
			}
		} catch {
			summaryError = m.admin_posts_edit_summary_failed();
		} finally {
			summaryBusy = false;
		}
	}

	/** Open the source-language switcher (the source chip is the entry point). */
	function openSwitchLang() {
		switchLangValue = lang;
		switchLangMode = 'existing';
		switchLangError = null;
		switchLangOpen = true;
	}

	const switchLangResult =
		() =>
		async ({ result, update }: FormResultInput) => {
			if (result.type === 'failure') {
				const d = (result.data ?? {}) as { message?: string };
				switchLangError = d.message ?? m.admin_posts_edit_switch_lang_failed();
				return;
			}
			switchLangOpen = false;
			switchLangError = null;
			await update();
		};

	// Slugs accept lowercase letters, digits and hyphens only.
	function onTitleInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		title = input.value;
		// A translation never mints its own slug: the address is decided by the source post.
		if (!slugTouched && !isTranslation) slug = normalizeSlug(title.replace(/[^a-z0-9]+/g, '-'));
	}

	function onSlugInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		slugTouched = true;
		slug = normalizeSlug(input.value);
	}

	// Transient banners for ?published=1 / ?discarded=1 / ?translation=1.
	// afterNavigate (not $effect) - replaceState throws before the router is
	// initialized, which a hard load of such a URL used to hit (dev probe).
	afterNavigate(() => {
		const params = page.url.searchParams;
		let message: string | null = null;
		if (params.get('published') === '1') message = m.admin_posts_status_published();
		else if (params.get('discarded') === '1') message = m.admin_posts_edit_flash_discarded();
		else if (params.get('translation') === '1')
			message = m.admin_posts_edit_flash_translation_created();
		if (!message) return;
		flash = message;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flash = null), 3500);
		const url = new URL(page.url);
		for (const key of ['published', 'discarded', 'translation']) url.searchParams.delete(key);
		replaceState(url.pathname + url.search, {});
	});

	// ── Leave guard (UX-1020-03): `beforeunload` alone never sees in-app nav ──
	beforeNavigate(({ cancel }) => {
		if (leavingIntentionally) return;
		if (saveState === 'conflict') return;
		if (!isDirty()) return;
		if (!window.confirm(m.admin_posts_edit_leave_confirm())) cancel();
	});

	const formErrorMessages = $derived(
		form?.errors ? (Object.values(form.errors).filter(Boolean) as string[]) : []
	);
	const publishErrorMessages = $derived(Object.values(publishErrors).filter(Boolean));
	const activeErrors = $derived(
		publishErrorMessages.length > 0 ? publishErrorMessages : formErrorMessages
	);

	/**
	 * No flagged fallback category means a first save can only fail, so the
	 * banner points at the page that creates one. A picked category wins: the
	 * hint disappears as soon as the owner selects one.
	 */
	const formDefaultCategoryMissing = $derived(
		// `fail(...)` payloads type as a union; only this branch carries the flag.
		Boolean((form as { defaultCategoryMissing?: boolean } | null)?.defaultCategoryMissing)
	);
	const showDefaultCategoryHint = $derived(
		!categoryId && (formDefaultCategoryMissing || !data.defaultCategoryId)
	);

	const saveLabel = $derived.by(() => {
		switch (saveState) {
			case 'saving':
				return m.admin_posts_edit_saving();
			case 'saved':
				return lastSavedAt
					? m.admin_posts_edit_saved_at({
							time: formatDateTime(lastSavedAt, { timeStyle: 'medium' })
						})
					: m.admin_posts_edit_saved();
			case 'dirty':
				return m.admin_posts_edit_unsaved();
			case 'throttled':
				return m.admin_posts_edit_autosave_throttled();
			case 'needs-category':
				return m.admin_posts_edit_pick_category_hint();
			case 'needs-default-category':
				return saveError ?? m.admin_posts_edit_err_no_default_category();
			case 'conflict':
				return m.admin_posts_edit_conflict_detected();
			case 'error':
				return saveError ?? m.admin_posts_edit_err_save_failed();
			default:
				return null;
		}
	});

	const statusText = $derived.by(() => {
		if (!data.post) return m.admin_posts_edit_new();
		if (data.source) {
			const pending = data.post.status === 'draft' && data.post.version === 0;
			return m.admin_posts_edit_translation_of({
				pending: pending ? m.admin_posts_edit_translation_pending() : '',
				source: data.source.title
			});
		}
		if (data.post.status === 'published') return m.admin_posts_status_published();
		if (data.post.status === 'scheduled') return m.admin_posts_status_scheduled();
		if (data.post.status === 'trash') return m.admin_posts_status_trash();
		return m.admin_posts_status_draft();
	});

	// ── Header actions (declared in +page.server.ts, bound here) ──────────
	const headerActions = useAdminHeaderActionRegistry();
	$effect(() => {
		if (!headerActions) return;
		const cleanups = [
			headerActions.register('posts:edit:save', () => {
				if (saveState === 'conflict') return;
				void runSave(false);
			}),
			headerActions.register('posts:edit:publish', () => void onPublish())
		];
		return () => cleanups.forEach((cleanup) => cleanup());
	});

	/** Language of the group source - the one that owns the shared slug. */
	const sourceLang = $derived(data.source?.lang ?? data.post?.lang ?? lang);

	type LangCell = {
		lang: string;
		kind: 'current' | 'sibling' | 'missing';
		id: string | null;
		status: string | null;
	};

	/**
	 * One chip per supported language. The family source always leads; the
	 * remaining languages follow alphabetically so the bar never reorders itself
	 * as translations are added.
	 */
	const langCells = $derived.by<LangCell[]>(() => {
		const currentLang = data.post?.lang ?? lang;
		const order = [...data.langs];
		// A legacy row outside the option list still gets its own chip.
		if (!order.includes(currentLang)) order.push(currentLang);
		if (!order.includes(sourceLang)) order.push(sourceLang);
		order.sort((a, b) => {
			if (a === sourceLang) return -1;
			if (b === sourceLang) return 1;
			return a.localeCompare(b, 'en');
		});
		return order.map<LangCell>((l) => {
			if (l === currentLang) {
				return {
					lang: l,
					kind: 'current',
					id: data.post?.id ?? null,
					status: data.post?.status ?? null
				};
			}
			const presence = translationPresence[l];
			return presence
				? { lang: l, kind: 'sibling', id: presence.postId, status: presence.status }
				: { lang: l, kind: 'missing', id: null, status: null };
		});
	});

	function langCellLabel(cell: LangCell): string {
		if (cell.kind === 'missing') return `${cell.lang}·${m.admin_posts_edit_lang_missing()}`;
		const status =
			cell.status === 'published'
				? m.admin_posts_status_published()
				: cell.status === 'scheduled'
					? m.admin_posts_status_scheduled()
					: cell.status === 'trash'
						? m.admin_posts_status_trash()
						: m.admin_posts_status_draft();
		// The source keeps its role marker on every language version's page.
		// Showing only the status there made the same chip change width the
		// moment another language was opened, shifting the rest of the bar.
		const role = cell.lang === sourceLang ? `·${m.admin_posts_edit_lang_source()}` : '';
		return `${cell.lang}${role}·${status}`;
	}

	/** The ruler's dot reads the same state the drawer will open on. */
	function chipDotClass(cell: LangCell): string {
		const state = drawerStateFor({
			lang: cell.lang,
			presence: translationPresence,
			candidates: translationCandidates
		});
		if (state === 'failed') return 'bg-destructive';
		if (state === 'candidate' || state === 'published') return 'bg-primary-text';
		if (state === 'queued' || state === 'draft') return 'bg-muted-foreground/50';
		return '';
	}

	// Writing-provenance choices - one source for the Select items and the
	// trigger label (the native `<select>` rendered raw options before).
	const writingOriginOptions = $derived([
		{ value: '', label: m.admin_posts_edit_ai_undisclosed() },
		{ value: 'none', label: m.admin_posts_edit_ai_none() },
		{ value: 'assist', label: m.admin_posts_edit_ai_assist() },
		{ value: 'mostly_ai', label: m.admin_posts_edit_ai_mostly() },
		{ value: 'ai_full', label: m.admin_posts_edit_ai_full() }
	]);
	const writingOriginLabel = $derived(
		writingOriginOptions.find((option) => option.value === writingOrigin)?.label ??
			m.admin_posts_edit_ai_undisclosed()
	);

	/** "AI helped with" only exists for the AI-assisted provenance values. */
	const aiHelpEnabled = $derived(
		writingOrigin === 'assist' || writingOrigin === 'mostly_ai' || writingOrigin === 'ai_full'
	);
	$effect(() => {
		// Server normalization drops help text for "undisclosed"/"none"; clear the
		// local copy as soon as the option makes that field unfillable.
		if (!isTranslation && !aiHelpEnabled && aiHelp !== '') aiHelp = '';
	});

	/** Collapsed bar: category / tags / AI provenance on one scannable line. */
	const metaSummary = $derived.by(() => {
		const parts: string[] = [];
		const cat = categoryOptions.find((c) => c.id === categoryId)?.name;
		if (cat) parts.push(cat);
		if (tags.trim()) parts.push(tags.trim());
		if (writingOrigin) parts.push(`AI: ${aiHelp.trim() || writingOriginLabel}`);
		return parts.join(' · ');
	});

	let beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
	$effect(() => {
		beforeUnloadHandler = (e: BeforeUnloadEvent) => {
			if (isDirty() && saveState !== 'conflict') {
				e.preventDefault();
				e.returnValue = '';
			}
		};
		window.addEventListener('beforeunload', beforeUnloadHandler);
		return () => {
			if (beforeUnloadHandler) window.removeEventListener('beforeunload', beforeUnloadHandler);
			if (autosaveTimer) clearTimeout(autosaveTimer);
			if (flashTimer) clearTimeout(flashTimer);
			if (stashTimer) clearTimeout(stashTimer);
		};
	});
</script>

<svelte:head>
	<title>{title ? `${title} - Lair Admin` : `${m.admin_posts_new()} - Lair Admin`}</title>
</svelte:head>

{#snippet hintTip(text: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<button
					type="button"
					class="shrink-0 text-muted-foreground/70 transition-colors hover:text-foreground"
					{...props}
					aria-label={text}
				>
					<IconInfoCircle class="size-3" />
				</button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content class="max-w-64 text-xs">{text}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<div class="flex h-full min-h-0 min-w-0 flex-col">
	<!-- ── A: language family + shared slug ───────────────────────────── -->
	<div
		class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1.5"
	>
		{#each langCells as cell (cell.lang)}
			{@const dotClass = chipDotClass(cell)}
			<Button
				type="button"
				variant={cell.kind === 'current'
					? 'secondary'
					: cell.kind === 'missing'
						? 'ghost'
						: 'outline'}
				size="sm"
				class="h-7 gap-1 px-2 text-xs {cell.kind === 'missing'
					? 'border border-dashed text-muted-foreground'
					: ''}"
				title={cell.kind === 'missing'
					? m.admin_posts_edit_create_translation()
					: cell.kind === 'current'
						? canSwitchSource
							? m.admin_posts_edit_switch_lang()
							: m.admin_posts_edit_lang_locked()
						: undefined}
				onclick={() =>
					cell.kind === 'current' ? canSwitchSource && openSwitchLang() : openDrawerFor(cell.lang)}
				disabled={cell.kind === 'current' && !canSwitchSource}
				aria-current={cell.kind === 'current' ? 'true' : undefined}
				aria-haspopup={canSwitchSource && cell.kind === 'current' ? 'dialog' : undefined}
			>
				{#if cell.kind !== 'missing' && dotClass}
					<span class="size-1.5 shrink-0 rounded-full {dotClass}" aria-hidden="true"></span>
				{/if}
				{langCellLabel(cell)}
			</Button>
		{/each}

		<div class="ml-auto flex min-w-0 items-center gap-1.5">
			{#if isTranslation}
				<span class="truncate text-xs text-muted-foreground">
					{m.admin_posts_edit_slug_shared()}
				</span>
			{/if}
			<button
				type="button"
				class="inline-flex max-w-56 items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-accent/15 disabled:pointer-events-none disabled:opacity-50"
				onclick={() => (slugDialogOpen = true)}
				aria-label={m.admin_posts_edit_add_slug()}
			>
				<span class="truncate">{slug ? `/${slug}` : m.admin_posts_edit_add_slug_label()}</span>
				<IconPencil class="size-3 shrink-0" />
			</button>
		</div>

		{#if showDefaultCategoryHint}
			<p role="alert" class="flex w-full flex-wrap items-center gap-1 text-xs text-destructive">
				<span>{m.admin_posts_edit_err_no_default_category()}</span>
				<a
					class="underline underline-offset-2 transition-colors hover:text-foreground"
					href="/admin/posts/categories"
				>
					{m.admin_posts_edit_no_default_category_action()}
				</a>
			</p>
		{/if}
	</div>

	<!-- ── B: document column ─────────────────────────────────────────── -->
	<div class="mx-auto w-full max-w-5xl flex-1 shrink-0 px-3 pb-16">
		<!-- Status line: save state, flash and overflow actions - the old sticky
		     bar minus the save/publish buttons, which live in the admin header. -->
		<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-3">
			<div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
				<span
					aria-hidden="true"
					class="inline-block size-1.5 shrink-0 rounded-full {saveState === 'conflict'
						? 'bg-destructive'
						: 'bg-emerald-500'}"
				></span>
				<span class="truncate">
					{statusText}
					{#if data.post}
						·
						{formatDateTime(new Date(data.post.updatedAt ?? data.post.createdAt), {
							dateStyle: 'short',
							timeStyle: 'short'
						})}
					{/if}
				</span>
				{#if flash}
					<span class="shrink-0 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">
						{flash}
					</span>
				{/if}
			</div>
			<div class="flex shrink-0 items-center gap-2">
				{#if saveLabel}
					<span
						class="max-w-56 truncate text-xs {saveState === 'conflict'
							? 'text-destructive'
							: 'text-muted-foreground'}"
					>
						{saveLabel}
					</span>
				{/if}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								variant="ghost"
								size="icon-sm"
								{...props}
								aria-label={m.admin_common_actions()}
							>
								<IconDots class="size-4" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-48">
						<DropdownMenu.Item onclick={() => (slugDialogOpen = true)}>
							<IconPencil class="size-4" />
							{m.admin_posts_edit_add_slug()}
						</DropdownMenu.Item>
						{#if draftId}
							<DropdownMenu.Item onclick={() => (discardOpen = true)} variant="destructive">
								<IconTrash class="size-4" />
								{m.admin_posts_edit_discard_draft()}
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		</div>

		{#if saveState === 'conflict'}
			<Alert.Root variant="destructive" class="mt-3">
				<Alert.Description>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span
							>{conflictMessage ??
								m.admin_posts_edit_conflict_short()}{m.admin_posts_edit_conflict_frozen_suffix()}</span
						>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onclick={() => void reloadFromServer()}
						>
							{m.admin_posts_edit_load_latest()}
						</Button>
					</div>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if saveState === 'error' && reauthUrl}
			<Alert.Root variant="destructive" class="mt-3">
				<Alert.Description>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span>{saveError ?? m.admin_posts_edit_err_session_invalid()}</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onclick={() => window.location.assign(reauthUrl ?? '/')}
						>
							{m.admin_posts_edit_relogin()}
						</Button>
					</div>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if activeErrors.length > 0}
			<div
				role="alert"
				class="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			>
				<span class="shrink-0 font-medium">{m.admin_posts_edit_validation_failed()}</span>
				<span class="min-w-0">{activeErrors.join(m.admin_posts_edit_error_join())}</span>
			</div>
		{/if}

		<!-- Title -->
		<div class="pt-6">
			<input
				name="title"
				class="w-full border-0 bg-transparent px-0 py-0 text-3xl font-semibold tracking-tight text-neutral-950 outline-none placeholder:font-medium placeholder:text-neutral-300 dark:text-neutral-50 dark:placeholder:text-neutral-700"
				placeholder={m.admin_posts_edit_title_placeholder()}
				bind:value={title}
				oninput={onTitleInput}
			/>
			{#if title && !slug}
				<p class="mt-1 text-xs text-destructive">{m.admin_posts_edit_slug_required_hint()}</p>
			{/if}
		</div>

		<!-- Metadata bar: horizontal, collapsible, always in the page -->
		<div class="mt-4 rounded-lg border border-border/60 bg-muted/20">
			<Collapsible.Root open={metaOpen} onOpenChange={(v) => (metaOpen = v)}>
				<Collapsible.Trigger>
					{#snippet child({ props })}
						<button
							type="button"
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
							{...props}
							aria-label={metaOpen
								? m.admin_posts_edit_meta_collapse()
								: m.admin_posts_edit_meta_expand()}
						>
							{#if metaOpen}
								<IconChevronUp class="size-3.5" />
							{:else}
								<IconChevronDown class="size-3.5" />
							{/if}
							<span class="truncate">
								{metaOpen
									? m.admin_posts_edit_settings()
									: metaSummary || m.admin_posts_edit_settings()}
							</span>
						</button>
					{/snippet}
				</Collapsible.Trigger>

				<Collapsible.Content>
					<div class="px-3 pb-3">
						<!-- Compact field grid: four controls share one row on lg, two on
						     sm. Labels stay with their control; secondary hints move into
						     tooltips so the panel stays as shallow as possible. -->
						<div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
							<!-- Category -->
							<Field.Field data-invalid={publishErrors.categoryId ? true : undefined}>
								<Field.Label for="post-category" class="text-xs text-muted-foreground">
									<IconCategory class="size-3.5" />
									{m.nav_posts_categories()}
								</Field.Label>
								<div class="flex items-center gap-1.5">
									<Select.Root type="single" bind:value={categoryId as never}>
										<Select.Trigger id="post-category" class="h-8 w-full">
											<span class="min-w-0 flex-1 truncate">
												{categoryId
													? (categoryOptions.find((c) => c.id === categoryId)?.name ??
														m.admin_categories_select())
													: m.admin_categories_select()}
											</span>
										</Select.Trigger>
										<Select.Content>
											{#each categoryOptions as cat (cat.id)}
												<Select.Item value={cat.id}>{cat.name}</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
									<Tooltip.Root>
										<Tooltip.Trigger>
											{#snippet child({ props })}
												<Button
													type="button"
													variant="outline"
													size="icon"
													class="shrink-0"
													{...props}
													aria-label={categoryFormOpen
														? m.admin_common_cancel()
														: m.admin_posts_edit_new_category()}
													aria-expanded={categoryFormOpen}
													onclick={() => (categoryFormOpen = !categoryFormOpen)}
												>
													{#if categoryFormOpen}
														<IconX class="size-3.5" />
													{:else}
														<IconPlus class="size-3.5" />
													{/if}
												</Button>
											{/snippet}
										</Tooltip.Trigger>
										<Tooltip.Content>
											{categoryFormOpen
												? m.admin_common_cancel()
												: m.admin_posts_edit_new_category()}
										</Tooltip.Content>
									</Tooltip.Root>
								</div>
								{#if publishErrors.categoryId}
									<Field.Error class="text-xs">{publishErrors.categoryId}</Field.Error>
								{/if}
							</Field.Field>

							<!-- Tags -->
							<Field.Field>
								<div class="flex items-center gap-1.5">
									<Field.Label for="post-tags" class="text-xs text-muted-foreground">
										<IconTag class="size-3.5" />
										{m.admin_tags_nav()}
									</Field.Label>
									{@render hintTip(m.admin_posts_edit_tags_hint())}
								</div>
								<Input
									id="post-tags"
									class="h-8"
									placeholder="svelte, typescript, tutorial"
									bind:value={tags}
								/>
							</Field.Field>

							<!-- AI provenance -->
							<Field.Field>
								<div class="flex items-center gap-1.5">
									<Field.Label for="post-writing-origin" class="text-xs text-muted-foreground">
										<IconSparkles class="size-3.5" />
										{m.admin_posts_edit_ai_title()}
									</Field.Label>
									{@render hintTip(
										isTranslation ? m.admin_posts_edit_ai_inherited() : m.admin_posts_edit_ai_desc()
									)}
								</div>
								<Select.Root type="single" bind:value={writingOrigin as never}>
									<Select.Trigger
										id="post-writing-origin"
										class="h-8 w-full"
										disabled={isTranslation}
									>
										{writingOriginLabel}
									</Select.Trigger>
									<Select.Content>
										{#each writingOriginOptions as option (option.value)}
											<Select.Item value={option.value}>{option.label}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</Field.Field>

							<!-- AI help -->
							<Field.Field>
								<div class="flex items-center gap-1.5">
									<Field.Label for="post-ai-help" class="text-xs text-muted-foreground">
										<IconSparkles class="size-3.5" />
										{m.admin_posts_edit_ai_help()}
									</Field.Label>
									{@render hintTip(m.admin_posts_edit_ai_help_hint())}
								</div>
								<Input
									id="post-ai-help"
									class="h-8"
									placeholder="ideas, wording"
									bind:value={aiHelp}
									disabled={isTranslation || !aiHelpEnabled}
								/>
							</Field.Field>
						</div>

						<!-- Summary: language-specific copy, folds away with the settings.
						     One auto-growing row keeps the panel shallow. -->
						<Field.Field class="mt-3">
							<Field.Label for="post-summary" class="text-xs text-muted-foreground">
								<IconFileDescription class="size-3.5" />
								{m.admin_posts_edit_summary_label()}
							</Field.Label>
							<div class="relative">
								<Textarea
									id="post-summary"
									class="min-h-9 pr-9"
									placeholder={m.admin_posts_edit_summary_placeholder()}
									bind:value={summary}
									rows={1}
								/>
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									class="absolute top-1 right-1 text-muted-foreground hover:text-foreground"
									disabled={!summaryReady || !postId || summaryBusy || isTranslation}
									onclick={runGenerateSummary}
									title={summaryTitle}
									aria-label={m.admin_posts_edit_summary_generate()}
								>
									<IconSparkles class="size-3.5" />
								</Button>
							</div>
							{#if summaryError}
								<span role="alert" class="mt-1.5 text-xs text-destructive">{summaryError}</span>
							{/if}
							{#if summaryCandidates.length > 0}
								<div class="mt-2 flex flex-col gap-1.5">
									{#each summaryCandidates.slice(0, 5) as candidate (candidate.id)}
										<div class="rounded-md border border-border/70 bg-background/40 p-2">
											<p class="line-clamp-2 text-xs text-muted-foreground">{candidate.summary}</p>
											<div class="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
												<span>{candidate.lang}</span>
												{#if candidate.model}<span class="truncate">{candidate.model}</span>{/if}
												{#if candidate.adoptedAt}
													<span class="text-emerald-600 dark:text-emerald-400">
														{m.admin_posts_edit_summary_adopted_badge()}
													</span>
												{/if}
												<div class="ml-auto flex items-center gap-1">
													<Button
														type="button"
														size="sm"
														variant="ghost"
														class="h-6 px-1.5 text-[11px]"
														disabled={summaryBusy || Boolean(candidate.adoptedAt)}
														onclick={() => runAdoptSummary(candidate)}
													>
														{m.admin_posts_edit_summary_adopt()}
													</Button>
													{#if !candidate.adoptedAt}
														<Button
															type="button"
															size="sm"
															variant="ghost"
															class="h-6 px-1.5 text-[11px] text-destructive"
															disabled={summaryBusy}
															onclick={() => runDiscardSummary(candidate.id)}
														>
															<IconTrash class="size-3" />
														</Button>
													{/if}
												</div>
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</Field.Field>

						<!-- Inline category creation -->
						{#if categoryFormOpen}
							<div class="mt-3 rounded-lg border border-dashed bg-background/40 p-3">
								<Field.Group class="gap-3">
									<div class="grid gap-3 sm:grid-cols-3">
										<Field.Field>
											<Field.Label for="new-category-name" class="text-xs text-muted-foreground">
												{m.admin_posts_edit_category_name()}
											</Field.Label>
											<Input
												id="new-category-name"
												class="h-8"
												bind:value={newCategoryName}
												oninput={() => (newCategorySlug = '')}
											/>
										</Field.Field>
										<Field.Field>
											<Field.Label for="new-category-slug" class="text-xs text-muted-foreground">
												slug
											</Field.Label>
											<Input
												id="new-category-slug"
												class="h-8 font-mono"
												bind:value={newCategorySlug}
											/>
										</Field.Field>
										<Field.Field>
											<Field.Label for="new-category-lang" class="text-xs text-muted-foreground">
												{m.admin_posts_edit_lang_label()}
											</Field.Label>
											<Select.Root type="single" bind:value={newCategoryLang as never}>
												<Select.Trigger id="new-category-lang" class="h-8 w-full">
													{newCategoryLang}
												</Select.Trigger>
												<Select.Content>
													{#each data.langs as l (l)}
														<Select.Item value={l}>{l}</Select.Item>
													{/each}
												</Select.Content>
											</Select.Root>
										</Field.Field>
									</div>
									{#if categoryError}
										<Field.Error class="text-xs">{categoryError}</Field.Error>
									{/if}
									<div class="flex items-center justify-end gap-2">
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onclick={() => (categoryFormOpen = false)}
										>
											<IconX class="size-3.5" />
											{m.admin_common_cancel()}
										</Button>
										<Button
											type="button"
											size="sm"
											disabled={creatingCategory || !newCategoryName.trim()}
											onclick={() => void onCreateCategory()}
										>
											{m.admin_common_create()}
										</Button>
									</div>
								</Field.Group>
							</div>
						{/if}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>

		<!-- Editor -->
		<div class="mt-4 flex min-h-0 flex-1 flex-col">
			{#key loadedKey}
				<MarkdownEditor
					initialMarkdown={contentMarkdown}
					placeholder={m.admin_posts_edit_body_placeholder()}
					stickyToolbar={true}
					borderless={true}
					class="min-h-0 flex-1"
					onChange={(detail) => {
						contentMarkdown = detail.markdown;
					}}
				/>
			{/key}
		</div>
	</div>
</div>

<!-- Slug dialog -->
<AlertDialog.Root open={slugDialogOpen} onOpenChange={(v) => (slugDialogOpen = v)}>
	<AlertDialog.Content class="sm:max-w-md">
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_posts_edit_slug_dialog_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{isTranslation ? m.admin_posts_edit_slug_shared() : m.admin_posts_edit_slug_dialog_desc()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<div class="px-6 pb-2">
			<Input
				name="slug-input"
				placeholder="my-post-slug"
				class="font-mono"
				value={slug}
				disabled={isTranslation}
				oninput={onSlugInput}
			/>
			<p class="mt-1.5 text-xs text-muted-foreground">{m.admin_posts_edit_slug_rule()}</p>
			{#if slug}
				<p class="mt-1.5 font-mono text-xs text-muted-foreground">
					{m.admin_posts_edit_slug_preview()}{slug}
				</p>
			{/if}
		</div>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={() => (slugDialogOpen = false)}>
				{m.admin_common_confirm()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Source-language switch -->
<Dialog.Root bind:open={switchLangOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.admin_posts_edit_switch_lang()}</Dialog.Title>
			<Dialog.Description>{m.admin_posts_edit_switch_lang_desc()}</Dialog.Description>
		</Dialog.Header>
		<form
			method="POST"
			action="?/switchLang"
			use:enhance={switchLangResult}
			class="flex flex-col gap-3 px-6 pb-2"
		>
			<input type="hidden" name="id" value={postId ?? ''} />
			<input type="hidden" name="lang" value={switchLangValue} />
			<input type="hidden" name="mode" value={switchLangMode} />
			<Field.Field>
				<Field.Label for="switch-lang-select" class="text-xs text-muted-foreground">
					{m.admin_posts_edit_lang_label()}
				</Field.Label>
				<Select.Root type="single" bind:value={switchLangValue as never}>
					<Select.Trigger id="switch-lang-select" class="w-full">
						{switchLangValue}
					</Select.Trigger>
					<Select.Content>
						{#each data.langs as l (l)}
							<Select.Item value={l}>{l}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</Field.Field>

			{#if switchLangSibling}
				<RadioGroup.Root bind:value={switchLangMode} class="gap-2">
					<label
						class="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 [@media(hover:hover)]:hover:bg-muted/50"
					>
						<RadioGroup.Item value="existing" class="mt-0.5" />
						<span class="flex min-w-0 flex-col gap-0.5">
							<span class="text-sm font-medium">
								{m.admin_posts_edit_switch_use_existing({ lang: switchLangValue })}
							</span>
							<span class="text-xs text-muted-foreground">
								{m.admin_posts_edit_switch_existing_hint()}
							</span>
						</span>
					</label>
					<label
						class="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 [@media(hover:hover)]:hover:bg-muted/50"
					>
						<RadioGroup.Item value="current" class="mt-0.5" />
						<span class="flex min-w-0 flex-col gap-0.5">
							<span class="text-sm font-medium">
								{m.admin_posts_edit_switch_keep_current()}
							</span>
							<span class="text-xs text-muted-foreground">
								{m.admin_posts_edit_switch_current_hint({ lang: switchLangValue })}
							</span>
						</span>
					</label>
				</RadioGroup.Root>
			{/if}

			{#if switchLangError}
				<p role="alert" class="text-xs text-destructive">{switchLangError}</p>
			{/if}

			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (switchLangOpen = false)}>
					{m.admin_common_cancel()}
				</Button>
				<Button type="submit" disabled={!switchLangValue || switchLangValue === lang}>
					{m.admin_common_confirm()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Discard confirmation -->
<AlertDialog.Root open={discardOpen} onOpenChange={(v) => (discardOpen = v)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_posts_edit_discard_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{draftId ? m.admin_posts_edit_discard_desc() : ''}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() => {
					leavingIntentionally = true;
					clearStash();
					const f = document.getElementById('discard-form');
					if (f instanceof HTMLFormElement) f.requestSubmit();
				}}
			>
				{m.admin_posts_edit_discard_confirm()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<form
	id="discard-form"
	method="POST"
	action="?/discard"
	use:enhance={formResultHandler}
	class="hidden"
>
	<input type="hidden" name="draftId" value={draftId ?? ''} />
</form>

<!-- Translation drawer: the proof sheet for one target language -->
<TranslationDrawer
	bind:open={drawerOpen}
	lang={drawerLang}
	state={drawerState}
	candidate={drawerCandidate}
	source={drawerSource}
	targetId={drawerTargetId}
	{canRetranslate}
	{canGenerate}
	busy={drawerBusy}
	error={drawerCandidate?.error ?? drawerError}
	notice={drawerNotice}
	job={translationJob}
	stage={translationStage}
	waitingReason={translationWaitingReason}
	budget={translationBudget}
	readiness={data.readiness.translation}
	glossaryMisses={drawerCandidate?.glossaryMisses ?? null}
	onAction={runDrawerAction}
/>
