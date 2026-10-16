<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance, deserialize } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { ActionResult } from '@sveltejs/kit';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { locales } from '$lib/paraglide/runtime';
	import { localeLabels } from '$lib/stores/locale.svelte';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Alert from '$lib/components/ui/alert';
	import { MarkdownEditor } from '$lib/components/markdown';
	import { formatDateTime } from '$lib/utils/i18n';
	import { normalizeSlug } from '$lib/utils/slug';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconCloudUpload from '@tabler/icons-svelte-runes/icons/cloud-upload';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconLanguage from '@tabler/icons-svelte-runes/icons/language';

	let {
		data,
		form
	}: {
		data: PageData;
		form: {
			success?: boolean;
			error?: string;
			errors?: Record<string, string>;
			message?: string;
		} | null;
	} = $props();

	/**
	 * Pages editor (P5-2). md rows run the draft editor - the md editor is the
	 * single source for title / description / content / slug, one `drafts`
	 * payload per row; code / external rows keep the P2 metadata form.
	 * Locale assembly contract (W1 Q3): the editor edits ONE locale at a time -
	 * a switch flushes the live buffer into the map and remounts via
	 * `editorEpoch`; saves merge the maps (active locale included).
	 */

	const AUTOSAVE_DEBOUNCE_MS = 2500;
	const THROTTLE_RETRY_MS = 12_000;

	/** Locale list for the draft editor's switcher (runtime order). */
	const LOCALE_CODES = locales;
	/** Locale list for the P2 metadata form (label objects). */
	const LOCALES = locales.map((code) => ({ code, label: localeLabels[code] }));

	const editMode = $derived(data.page.editorMode);

	// ── Draft-editor state ───────────────────────────────────────────────
	let titleMap = $state<Record<string, string>>({});
	let descMap = $state<Record<string, string>>({});
	/** Bodies for the locales the editor is NOT currently showing. */
	let contentMap = $state<Record<string, string>>({});
	/** The ACTIVE locale's editor buffer (MarkdownEditor onChange mirror). */
	let markdown = $state('');
	let activeLocale = $state<string>('en');
	let slug = $state('');
	let pageId = $state<string | null>(null);
	let draftId = $state<string | null>(null);
	let draftVersion = $state<number | null>(null);

	// `savedSnapshot` mirrors the last payload the server acknowledged; the
	// dirty test and the publish flush both compare against it.
	let savedSnapshot = $state('');
	let lastSeen = $state('');
	let lastSavedAt = $state<Date | null>(null);
	type SaveState = 'idle' | 'saved' | 'saving' | 'dirty' | 'throttled' | 'conflict' | 'error';
	let saveState = $state<SaveState>('idle');
	let saveError = $state<string | null>(null);
	let conflictMessage = $state<string | null>(null);
	let inFlight = false;
	let pendingResave = false;
	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

	let slugDialogOpen = $state(false);
	let settingsOpen = $state(false);
	let publishing = $state(false);
	let publishErrors = $state<Record<string, string>>({});
	let flash = $state<string | null>(null);
	/** Set when an action answers with a redirect instead of data (session). */
	let reauthUrl = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	// P2 metadata form state (code / external rows).
	let saved = $state(false);

	/**
	 * Shared handler for the publish/discard/settings forms: on failure the
	 * messages surface in the editor banners; on success/redirect the default
	 * update() runs (so navigations and redirects land).
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
				publishing = false;
				publishErrors = { ...(d.errors ?? {}) };
				if (d.message) publishErrors = { ...publishErrors, form: d.message };
				// A publish-side conflict also freezes publishes until reload.
				if (result.status === 409) conflictMessage = d.message ?? conflictMessage;
			} else {
				settingsOpen = false;
				await update();
			}
		};

	/** Row-properties (icon / external_url) save from the settings sheet. */
	const propsHandler =
		() =>
		async ({ result, update }: FormResultInput) => {
			if (result.type === 'failure') {
				const d = (result.data ?? {}) as { error?: string; message?: string };
				publishErrors = { form: d.error ?? d.message ?? m.admin_posts_edit_err_save_failed() };
			} else {
				settingsOpen = false;
				flash = m.admin_pages_saved();
				if (flashTimer) clearTimeout(flashTimer);
				flashTimer = setTimeout(() => (flash = null), 3500);
				await update();
			}
		};

	/** Seeded so every locale slot is a string (bindings stay well-typed). */
	function seedMap(map: Record<string, string> | null | undefined): Record<string, string> {
		return Object.fromEntries(LOCALE_CODES.map((locale) => [locale, map?.[locale] ?? '']));
	}

	function cleanLocaleMap(map: Record<string, string>): Record<string, string> {
		const out: Record<string, string> = {};
		for (const locale of LOCALE_CODES) {
			const value = map[locale];
			if (typeof value === 'string' && value !== '') out[locale] = value;
		}
		return out;
	}

	/** The full content map: stored bodies + the live editor buffer. */
	function fullContentMap(): Record<string, string> {
		const out = cleanLocaleMap(contentMap);
		if (markdown !== '') out[activeLocale] = markdown;
		else delete out[activeLocale];
		return out;
	}

	function currentPayload(): string {
		return JSON.stringify([
			slug,
			cleanLocaleMap(titleMap),
			cleanLocaleMap(descMap),
			fullContentMap()
		]);
	}

	function isDirty(): boolean {
		return currentPayload() !== savedSnapshot;
	}

	/** Narrowing-proof state readers ($state writes elsewhere confuse tsc). */
	function isSettledState(state: SaveState): boolean {
		return state === 'saved' || state === 'idle';
	}

	function chooseLocale(): string {
		for (const locale of LOCALE_CODES) if ((contentMap[locale] ?? '') !== '') return locale;
		return data.defaultLang ?? LOCALE_CODES[0];
	}

	function applyAll() {
		const draft = data.draft;
		const row = data.page;
		titleMap = seedMap(draft?.title ?? row.title);
		descMap = seedMap(draft?.description ?? row.description);
		// Seed the working copy from the DRAFT when one exists, else from the
		// PUBLISHED body (P5 e2e finding): an existing page opened for its
		// first edit must carry its body - seeding only from the draft left
		// the editor blank and the publish failed the content gate.
		contentMap = { ...(draft?.content ?? row.content ?? {}) };
		slug = typeof draft?.slug === 'string' ? draft.slug : row.placeholder ? '' : row.slug;
		activeLocale = chooseLocale();
		markdown = contentMap[activeLocale] ?? '';
		pageId = row.id;
		draftId = draft?.id ?? null;
		draftVersion = draft?.version ?? null;
		saveState = 'idle';
		saveError = null;
		conflictMessage = null;
		publishErrors = {};
		reauthUrl = null;
		lastSavedAt = null;
		const snapshot = currentPayload();
		savedSnapshot = snapshot;
		lastSeen = snapshot;
	}

	// Initialize from the load data (intentional first apply; code rows keep
	// the P2 form and never enter the draft state).
	if (untrack(() => editMode)) applyAll();

	// Background refreshes (row-property saves, the first-save URL anchor)
	// must never replay the server copy over unsaved edits: draft.version
	// stays OUT of the key - it advances on every autosave.
	const dataKey = $derived(`${data.page.id}@${data.draft?.id ?? ''}`);
	let loadedKey = $state(untrack(() => dataKey));
	/** Bumped to force an editor remount (MarkdownEditor reads initialMarkdown at mount only). */
	let editorEpoch = $state(0);
	$effect(() => {
		if (!editMode) return;
		if (dataKey === loadedKey) return;
		loadedKey = dataKey;
		// The draft vanished server-side (published or discarded from this or
		// another tab): drop the stale address so the dirty working copy can
		// re-save as a FRESH draft instead of 409ing against a deleted row.
		if (!data.draft && draftId !== null) {
			draftId = null;
			draftVersion = null;
			// Same stale-timer trap as onPublish (P5 e2e finding): a debounce
			// scheduled before the draft vanished must not re-attach later.
			if (autosaveTimer) {
				clearTimeout(autosaveTimer);
				autosaveTimer = null;
			}
		}
		// untrack (T16): the dirty test stringifies the whole payload - the
		// effect must not re-run on every keystroke through that read.
		if (untrack(isDirty)) return; // keep the working copy; id state already tracks the save
		applyAll();
	});

	// ── Dirty tracking + autosave scheduling ─────────────────────────────
	$effect(() => {
		if (!editMode) return;
		const current = currentPayload();
		if (current === lastSeen) return;
		lastSeen = current;
		onFieldsChanged();
	});

	function onFieldsChanged() {
		// Frozen after a conflict until the editor reloads the server state.
		if (saveState === 'conflict') return;
		if (Object.keys(publishErrors).length > 0) publishErrors = {};
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

	function buildSaveForm(autosave: boolean): FormData {
		const fd = new FormData();
		fd.set('autosave', autosave ? '1' : '0');
		fd.set('slug', slug);
		const titles = cleanLocaleMap(titleMap);
		const descriptions = cleanLocaleMap(descMap);
		const bodies = fullContentMap();
		for (const locale of LOCALE_CODES) {
			if (titles[locale]) fd.set(`title_${locale}`, titles[locale]);
			if (descriptions[locale]) fd.set(`description_${locale}`, descriptions[locale]);
			if (bodies[locale]) fd.set(`content_${locale}`, bodies[locale]);
		}
		if (pageId) fd.set('id', pageId);
		if (draftId) fd.set('draftId', draftId);
		if (draftVersion != null) fd.set('draftVersion', String(draftVersion));
		return fd;
	}

	async function runSave(autosave: boolean): Promise<boolean> {
		if (inFlight) {
			if (autosave) {
				pendingResave = true;
				return false;
			}
			// Manual saves (and the publish flush) must not be dropped by a
			// race with the autosave flight: wait it out, then save the
			// latest state below.
			for (let waited = 0; waited < 100 && inFlight; waited += 1) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (inFlight) return false;
		}
		inFlight = true;
		saveState = 'saving';
		const snapshotAtSubmit = currentPayload();
		try {
			const response = await fetch('?/saveDraft', {
				method: 'POST',
				body: buildSaveForm(autosave),
				// The JSON action protocol is selected by Accept negotiation;
				// the x-sveltekit-action header is only a bypass switch.
				headers: { 'x-sveltekit-action': 'true', accept: 'application/json' }
			});
			const result = deserialize(await response.text());
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
					pageId: string | null;
					retryAfterMs?: number;
					updatedAt?: Date | string | null;
				};
				reauthUrl = null;
				draftId = d.draftId;
				draftVersion = d.draftVersion;
				if (d.pageId && d.pageId !== pageId) {
					pageId = d.pageId;
					// First save of a new page: anchor the URL to the row.
					replaceState(`/admin/pages/edit?id=${d.pageId}${page.url.search}`, {});
				}
				if (d.saved || d.reason === 'unchanged') {
					savedSnapshot = snapshotAtSubmit;
					lastSavedAt = new Date();
					saveState = currentPayload() === savedSnapshot ? 'saved' : 'dirty';
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
					errors?: Record<string, string>;
				};
				if (result.status === 409) {
					saveState = 'conflict';
					conflictMessage = d.message ?? m.admin_posts_edit_conflict_short();
				} else {
					// Prefer the graded field errors over the generic message.
					const graded = Object.values(d.errors ?? {}).filter(Boolean);
					saveState = 'error';
					saveError =
						graded.length > 0
							? graded.join(m.admin_posts_edit_error_join())
							: (d.message ?? m.admin_posts_edit_err_save_failed());
				}
			} else {
				saveState = 'error';
				saveError = m.admin_posts_edit_err_network();
				scheduleSave(THROTTLE_RETRY_MS);
			}
		} catch {
			saveState = 'error';
			saveError = m.admin_posts_edit_err_network();
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
		await invalidateAll();
		applyAll();
		// The editor holds its own DOM: bump the epoch so it remounts with the
		// freshly applied server copy.
		editorEpoch += 1;
	}

	async function onPublish() {
		if (saveState === 'conflict' || publishing) return;
		publishing = true;
		// Kill the pending debounce (P5 e2e finding): a stale autosave that
		// fires after the publish transaction deleted the draft would
		// re-attach a fresh draft against the just-published row (phantom
		// "unpublished changes").
		if (autosaveTimer) {
			clearTimeout(autosaveTimer);
			autosaveTimer = null;
		}
		try {
			if (!draftId || isDirty()) {
				// Flush the working copy first; only real end-states
				// (conflict / error / session loss) abort here.
				const ok = await runSave(false);
				if (!ok) return;
			}
			await tick();
			const publishForm = document.getElementById('publish-form');
			if (publishForm instanceof HTMLFormElement) publishForm.requestSubmit();
		} finally {
			publishing = false;
		}
	}

	/** Locale switch contract (W1 Q3): flush the live buffer, then remount. */
	function switchLocale(next: string) {
		if (next === activeLocale) return;
		if (markdown !== '') contentMap[activeLocale] = markdown;
		else delete contentMap[activeLocale];
		activeLocale = next;
		markdown = contentMap[next] ?? '';
		editorEpoch += 1;
	}

	/** Slug input canonicalization (T15): the ruled exact replacement -
	 * lowercase, non-alphanumerics to hyphens, then the shared `normalizeSlug`
	 * (hyphen collapse + edge trim). 17/17 vector parity with the retired
	 * local implementation (E2 experiment, P5-5 rulings). */
	function onSlugInput(e: Event) {
		const raw = (e.currentTarget as HTMLInputElement).value;
		slug = normalizeSlug(raw.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
	}

	// Transient banners for ?published=1 / ?discarded=1. afterNavigate (not
	// $effect) - replaceState throws before the router is initialized, which a
	// hard load of such a URL used to hit.
	afterNavigate(() => {
		const params = page.url.searchParams;
		let message: string | null = null;
		if (params.get('published') === '1') message = m.admin_posts_status_published();
		else if (params.get('discarded') === '1') message = m.admin_posts_edit_flash_discarded();
		if (!message) return;
		flash = message;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flash = null), 3500);
		const url = new URL(page.url);
		for (const key of ['published', 'discarded']) url.searchParams.delete(key);
		replaceState(url.pathname + url.search, {});
	});

	const formErrorMessages = $derived(
		form?.errors ? (Object.values(form.errors).filter(Boolean) as string[]) : []
	);
	const publishErrorMessages = $derived(Object.values(publishErrors).filter(Boolean));
	const activeErrors = $derived(
		publishErrorMessages.length > 0 ? publishErrorMessages : formErrorMessages
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
			case 'conflict':
				return m.admin_posts_edit_conflict_detected();
			case 'error':
				return saveError ?? m.admin_posts_edit_err_save_failed();
			default:
				return null;
		}
	});

	const statusText = $derived.by(() => {
		if (data.page.placeholder) return m.admin_posts_status_draft();
		if (data.page.status === 'hidden') return m.admin_pages_hidden();
		return m.admin_pages_visible();
	});

	/** New pages carry no row yet: the modified stamp is skipped entirely. */
	const updatedLabel = $derived(
		data.page.updatedAt
			? formatDateTime(new Date(data.page.updatedAt), { dateStyle: 'short', timeStyle: 'short' })
			: null
	);

	const heading = $derived(titleMap[activeLocale] || '');

	let beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
	$effect(() => {
		beforeUnloadHandler = (e: BeforeUnloadEvent) => {
			// A conflict freezes SAVES but the typed text is still unsaved and
			// would be lost silently; guard it like any other dirty state.
			if (editMode && isDirty()) {
				e.preventDefault();
				e.returnValue = '';
			}
		};
		window.addEventListener('beforeunload', beforeUnloadHandler);
		return () => {
			if (beforeUnloadHandler) window.removeEventListener('beforeunload', beforeUnloadHandler);
			if (autosaveTimer) clearTimeout(autosaveTimer);
			if (flashTimer) clearTimeout(flashTimer);
		};
	});
</script>

<svelte:head>
	<title>{heading ? `${heading} - Lair Admin` : `${m.admin_pages_title()} - Lair Admin`}</title>
</svelte:head>

{#if editMode}
	<div class="flex h-full min-h-0 min-w-0 flex-col">
		<!-- Publish/discard live in their own forms; the visible controls
		     trigger them (publish flushes the draft first). -->
		<form
			id="publish-form"
			method="POST"
			action="?/publish"
			use:enhance={formResultHandler}
			class="hidden"
		>
			<input type="hidden" name="draftId" value={draftId ?? ''} />
		</form>
		<form
			id="discard-form"
			method="POST"
			action="?/discard"
			use:enhance={formResultHandler}
			class="hidden"
		>
			<input type="hidden" name="draftId" value={draftId ?? ''} />
		</form>

		<!-- Main content area -->
		<main class="flex min-h-full min-w-0 flex-col bg-background">
			<!-- Header area: status + locale switch + title + slug -->
			<div class="mx-auto w-full max-w-5xl shrink-0 px-3 pt-8">
				<!-- Status bar -->
				<div
					class="group mb-3 flex min-h-7 items-center justify-between gap-3 opacity-60 transition-opacity duration-200 hover:opacity-100"
				>
					<div
						class="flex min-w-0 items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400"
					>
						<span
							aria-hidden="true"
							class="inline-block size-1.5 shrink-0 rounded-full {saveState === 'conflict'
								? 'bg-destructive'
								: 'bg-emerald-500'}"
						></span>
						<span class="truncate">
							{statusText}
							{#if updatedLabel}
								{m.admin_posts_edit_modified()}
								{updatedLabel}
							{/if}
						</span>
						{#if data.draft && !data.page.placeholder}
							<Badge variant="secondary" class="shrink-0"
								>{m.admin_posts_unpublished_changes()}</Badge
							>
						{/if}
						{#if flash}
							<span
								class="shrink-0 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400"
							>
								{flash}
							</span>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-2">
						{#if saveLabel}
							<span
								class="truncate text-xs {saveState === 'conflict'
									? 'text-destructive'
									: 'text-neutral-500 dark:text-neutral-400'}"
							>
								{saveLabel}
							</span>
						{/if}
						<!-- Properties (icon / external_url) button (real rows only) -->
						{#if pageId}
							<button
								type="button"
								onclick={() => (settingsOpen = true)}
								class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
								aria-label={m.admin_pages_edit_props()}
								title={m.admin_pages_edit_props()}
							>
								<IconSettings class="size-3.5" />
							</button>
						{/if}
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="h-7 gap-1 px-2.5 text-xs"
							onclick={() => void runSave(false)}
							disabled={saveState === 'saving' || saveState === 'conflict'}
						>
							<IconDeviceFloppy class="size-3" />
							{m.admin_posts_edit_save_draft()}
						</Button>
						<Button
							type="button"
							size="sm"
							class="h-7 gap-1 px-2.5 text-xs"
							onclick={() => void onPublish()}
							disabled={publishing || saveState === 'conflict'}
						>
							<IconCloudUpload class="size-3" />
							{m.admin_posts_edit_publish()}
						</Button>
					</div>
				</div>

				<!-- Locale switcher + row-type badges -->
				<div class="mb-3 flex flex-wrap items-center gap-2">
					<IconLanguage class="size-3.5 text-muted-foreground" />
					{#each LOCALE_CODES as code (code)}
						<Button
							type="button"
							variant={activeLocale === code ? 'default' : 'outline'}
							size="sm"
							class="h-6 px-2 text-xs"
							onclick={() => switchLocale(code)}
						>
							{localeLabels[code]}
						</Button>
					{/each}
					<span class="mx-1 h-4 w-px bg-border"></span>
					{#if !data.page.placeholder}
						<Badge variant={data.page.isDefault ? 'secondary' : 'outline'} class="text-xs">
							{data.page.isDefault ? m.admin_pages_default_page() : m.admin_pages_extra_page()}
						</Badge>
					{/if}
					<Badge variant="outline" class="text-xs">{m.admin_pages_md_page()}</Badge>
				</div>

				<!-- Conflict banner -->
				{#if saveState === 'conflict'}
					<Alert.Root variant="destructive" class="mb-3">
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

				<!-- Expired-session banner: an action answered with a redirect. -->
				{#if saveState === 'error' && reauthUrl}
					<Alert.Root variant="destructive" class="mb-3">
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

				<!-- Validation / save error banner -->
				{#if activeErrors.length > 0}
					<div
						role="alert"
						class="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
					>
						<span class="shrink-0 font-medium">{m.admin_posts_edit_validation_failed()}</span>
						<span class="min-w-0">{activeErrors.join(m.admin_posts_edit_error_join())}</span>
					</div>
				{/if}

				<!-- Title + description inputs (active locale) -->
				<div class="group">
					<input
						aria-label={m.admin_pages_edit_title_label()}
						class="w-full border-0 bg-transparent px-0 py-0 text-3xl font-semibold tracking-tight text-neutral-950 outline-none placeholder:font-medium placeholder:text-neutral-300 dark:text-neutral-50 dark:placeholder:text-neutral-700"
						placeholder={m.admin_posts_edit_title_placeholder()}
						bind:value={titleMap[activeLocale]}
					/>
					<input
						aria-label={m.admin_pages_edit_desc_section()}
						class="mt-2 w-full border-0 bg-transparent px-0 py-0 text-sm text-neutral-500 outline-none placeholder:text-neutral-300 dark:text-neutral-400 dark:placeholder:text-neutral-700"
						placeholder={m.admin_pages_edit_desc_section()}
						bind:value={descMap[activeLocale]}
					/>
					<!-- Slug button -->
					<div class="mt-1 flex items-center gap-2">
						<button
							type="button"
							class="-ml-1 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-opacity duration-150 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-accent/15"
							onclick={() => (slugDialogOpen = true)}
							aria-label={m.admin_posts_edit_add_slug()}
						>
							<span class="truncate">{slug ? `/${slug}` : m.admin_posts_edit_add_slug_label()}</span
							>
							<IconPencil class="size-3 shrink-0" />
						</button>
						{#if (titleMap[activeLocale] ?? '') !== '' && !slug}
							<span class="text-xs text-destructive">{m.admin_notes_edit_slug_required_hint()}</span
							>
						{/if}
					</div>
				</div>

				<hr class="my-4 border-0 border-t border-neutral-100 dark:border-neutral-800" />
			</div>

			<!-- Editor area -->
			<div class="flex min-h-0 flex-1 flex-col">
				<div class="mx-auto flex w-full max-w-5xl flex-1 flex-col px-3">
					{#key `${loadedKey}@${editorEpoch}`}
						<MarkdownEditor
							initialMarkdown={markdown}
							placeholder={m.admin_pages_edit_body_placeholder()}
							stickyToolbar={true}
							borderless={true}
							class="min-h-0 flex-1"
							onChange={(detail) => {
								markdown = detail.markdown;
							}}
						/>
					{/key}
				</div>
			</div>
		</main>
	</div>

	<!-- Slug Dialog -->
	<Dialog.Root open={slugDialogOpen} onOpenChange={(v) => (slugDialogOpen = v)}>
		<Dialog.Portal>
			<Dialog.Overlay />
			<Dialog.Content class="sm:max-w-md">
				<Dialog.Header>
					<Dialog.Title>{m.admin_posts_edit_slug_dialog_title()}</Dialog.Title>
					<Dialog.Description>{m.admin_pages_edit_slug_dialog_desc()}</Dialog.Description>
				</Dialog.Header>
				<div class="px-6 pb-2">
					<Input
						name="slug-input"
						aria-label="Slug"
						placeholder="my-page"
						class="font-mono"
						value={slug}
						readonly={data.page.isDefault}
						oninput={onSlugInput}
					/>
					<p class="mt-1.5 text-xs text-muted-foreground">{m.admin_pages_edit_slug_rule()}</p>
					{#if slug}
						<p class="mt-1.5 font-mono text-xs text-muted-foreground">
							{m.admin_pages_edit_slug_preview()}{slug}
						</p>
					{/if}
					{#if data.page.isDefault}
						<p class="mt-1.5 text-xs text-muted-foreground">
							{m.admin_pages_edit_slug_default_hint()}
						</p>
					{:else}
						<p class="mt-1.5 text-xs text-muted-foreground">{m.admin_pages_edit_slug_note()}</p>
					{/if}
				</div>
				<Dialog.Footer>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" {...props}>{m.admin_common_cancel()}</Button>
						{/snippet}
					</Dialog.Close>
					<Button onclick={() => (slugDialogOpen = false)}>{m.admin_common_confirm()}</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Portal>
	</Dialog.Root>

	<!-- Properties Sheet (icon / external_url direct save) -->
	<Sheet.Root open={settingsOpen} onOpenChange={(v) => (settingsOpen = v)}>
		<Sheet.Portal>
			<Sheet.Overlay />
			<Sheet.Content side="right" class="w-full sm:max-w-sm">
				<Sheet.Header>
					<Sheet.Title>{m.admin_pages_edit_props()}</Sheet.Title>
					<Sheet.Close
						class="absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none"
					>
						<IconX class="size-4" />
						<span class="sr-only">{m.admin_common_close()}</span>
					</Sheet.Close>
				</Sheet.Header>
				<div class="flex flex-col gap-5 overflow-y-auto px-6 py-4">
					<form
						method="POST"
						action="?/save"
						use:enhance={propsHandler}
						class="flex flex-col gap-5"
					>
						<!-- Live pageId (M4): new-mode state starts as '' (never
						     null) - the `??` fallback only guards null, and an
						     empty id is rejected server-side with a clean 400. -->
						<input type="hidden" name="id" value={pageId ?? data.page.id} />
						<div class="flex flex-col gap-1.5">
							<label for="props-icon" class="text-sm font-medium">{m.admin_pages_edit_icon()}</label
							>
							<Input
								id="props-icon"
								name="icon"
								value={data.page.icon}
								placeholder={m.admin_pages_edit_icon_ph()}
							/>
						</div>
						<div class="flex flex-col gap-1.5">
							<label for="props-external" class="text-sm font-medium"
								>{m.admin_pages_edit_external()}</label
							>
							<Input
								id="props-external"
								name="externalUrl"
								value={data.page.externalUrl}
								placeholder={m.admin_pages_edit_external_ph()}
							/>
						</div>
						{#if publishErrors.form}
							<p class="text-sm text-destructive">{publishErrors.form}</p>
						{/if}
						<Button type="submit" variant="outline" size="sm" class="w-full">
							{m.admin_common_save()}
						</Button>
					</form>

					<!-- Danger zone -->
					{#if draftId}
						<AlertDialog.Root>
							<AlertDialog.Trigger>
								{#snippet child({ props })}
									<Button
										variant="outline"
										class="w-full border-destructive/30 text-destructive"
										{...props}
									>
										<IconTrash class="size-4" />
										{m.admin_posts_edit_discard_draft()}
									</Button>
								{/snippet}
							</AlertDialog.Trigger>
							<AlertDialog.Content>
								<AlertDialog.Header>
									<AlertDialog.Title>{m.admin_posts_edit_discard_title()}</AlertDialog.Title>
									<AlertDialog.Description>
										{m.admin_pages_edit_discard_desc()}
									</AlertDialog.Description>
								</AlertDialog.Header>
								<AlertDialog.Footer>
									<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
									<AlertDialog.Action
										onclick={() => {
											const f = document.getElementById('discard-form');
											if (f instanceof HTMLFormElement) f.requestSubmit();
										}}
									>
										{m.admin_posts_edit_discard_confirm()}
									</AlertDialog.Action>
								</AlertDialog.Footer>
							</AlertDialog.Content>
						</AlertDialog.Root>
					{/if}
				</div>
			</Sheet.Content>
		</Sheet.Portal>
	</Sheet.Root>
{:else}
	<!-- code / external rows keep the P2 metadata form (unchanged shape) -->
	<div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
		{#if form?.error}
			<div
				role="alert"
				class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			>
				{form.error}
			</div>
		{:else if saved}
			<div
				role="status"
				class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
			>
				{m.admin_pages_saved()}
			</div>
		{/if}

		<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
			<Badge variant={data.page.isDefault ? 'secondary' : 'outline'} class="text-xs">
				{data.page.isDefault ? m.admin_pages_default_page() : m.admin_pages_extra_page()}
			</Badge>
			<Badge variant="outline" class="text-xs">
				{m.admin_pages_code_page()}
			</Badge>
			<span>slug: <span class="font-mono">{data.page.slug}</span></span>
		</div>

		<form
			method="POST"
			action="?/save"
			oninput={() => {
				saved = false;
			}}
			use:enhance={() => {
				saved = false;
				return async ({ result, update }) => {
					await update();
					if (result.type === 'success') saved = true;
				};
			}}
			class="flex flex-col gap-6"
		>
			<input type="hidden" name="id" value={data.page.id} />

			<section class="flex flex-col gap-3">
				<h2 class="text-sm font-semibold">{m.admin_pages_edit_title_section()}</h2>
				{#each LOCALES as locale (locale.code)}
					<label class="flex items-center gap-3">
						<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
						<input
							type="text"
							name="title_{locale.code}"
							value={data.page.title[locale.code] ?? ''}
							class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
						/>
					</label>
				{/each}
			</section>

			<section class="flex flex-col gap-3">
				<h2 class="text-sm font-semibold">{m.admin_pages_edit_desc_section()}</h2>
				{#each LOCALES as locale (locale.code)}
					<label class="flex items-center gap-3">
						<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
						<input
							type="text"
							name="description_{locale.code}"
							value={data.page.description[locale.code] ?? ''}
							class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
						/>
					</label>
				{/each}
			</section>

			<section class="flex flex-col gap-3">
				<h2 class="text-sm font-semibold">{m.admin_pages_edit_props()}</h2>
				<label class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-xs text-muted-foreground"
						>{m.admin_pages_edit_icon()}</span
					>
					<input
						type="text"
						name="icon"
						value={data.page.icon}
						placeholder={m.admin_pages_edit_icon_ph()}
						class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					/>
				</label>
				<label class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-xs text-muted-foreground"
						>{m.admin_pages_edit_external()}</span
					>
					<input
						type="url"
						name="externalUrl"
						value={data.page.externalUrl}
						placeholder={m.admin_pages_edit_external_ph()}
						class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					/>
				</label>
				<label class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-xs text-muted-foreground">Slug</span>
					<input
						type="text"
						name="slug"
						value={data.page.slug}
						readonly={data.page.isDefault}
						class="h-9 w-full rounded-md border bg-transparent px-3 font-mono text-sm read-only:opacity-60"
					/>
				</label>
				{#if data.page.isDefault}
					<p class="text-xs text-muted-foreground">
						{m.admin_pages_edit_slug_default_hint()}
					</p>
				{:else}
					<p class="text-xs text-amber-600 dark:text-amber-400">
						{m.admin_pages_edit_slug_code_hint()}
					</p>
				{/if}
			</section>

			<div class="flex items-center gap-3">
				<Button type="submit">{m.admin_common_save()}</Button>
				<Button variant="outline" href="/admin/pages">{m.admin_common_back_to_list()}</Button>
			</div>
		</form>
	</div>
{/if}
