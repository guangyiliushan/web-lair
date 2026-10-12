<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance, deserialize } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { ActionResult } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
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
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconCategory from '@tabler/icons-svelte-runes/icons/category';
	import IconTag from '@tabler/icons-svelte-runes/icons/tag';
	import IconFileDescription from '@tabler/icons-svelte-runes/icons/file-description';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconSend from '@tabler/icons-svelte-runes/icons/send';
	import IconLanguage from '@tabler/icons-svelte-runes/icons/language';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconCloudUpload from '@tabler/icons-svelte-runes/icons/cloud-upload';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const AUTOSAVE_DEBOUNCE_MS = 2500;
	const THROTTLE_RETRY_MS = 12_000;

	// ── Editor state ─────────────────────────────────────────────────────
	let title = $state('');
	let slug = $state('');
	let slugTouched = $state(false);
	let categoryId = $state('');
	let summary = $state('');
	let tags = $state('');
	let contentMarkdown = $state('');
	let lang = $state<string>(untrack(() => data.defaultLang));

	let postId = $state<string | null>(null);
	let draftId = $state<string | null>(null);
	let draftVersion = $state<number | null>(null);

	// `savedSnapshot` mirrors the last payload the server acknowledged; the
	// dirty test and the publish flush both compare against it.
	let savedSnapshot = $state('');
	let lastSeen = $state('');
	let lastSavedAt = $state<Date | null>(null);
	type SaveState =
		'idle' | 'saved' | 'saving' | 'dirty' | 'throttled' | 'conflict' | 'error' | 'needs-category';
	let saveState = $state<SaveState>('idle');
	let saveError = $state<string | null>(null);
	let conflictMessage = $state<string | null>(null);
	let inFlight = false;
	let pendingResave = false;
	let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

	let slugDialogOpen = $state(false);
	let settingsOpen = $state(false);
	let translationOpen = $state(false);
	let translationLang = $state('');
	let publishing = $state(false);
	let publishErrors = $state<Record<string, string>>({});
	let flash = $state<string | null>(null);
	/** Set when an action answers with a redirect instead of data (session). */
	let reauthUrl = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Shared handler for the publish/discard/createTranslation forms: on
	 * failure the messages surface in the editor banners; on success/redirect
	 * the default update() runs (so navigations and redirects land).
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
				// A publish-side base conflict also freezes publishes until reload.
				if (result.status === 409) conflictMessage = d.message ?? conflictMessage;
			} else {
				// A same-route redirect keeps component state: close the dialogs
				// explicitly or the translation/settings panels stay open over
				// the freshly created page (review probe finding).
				translationOpen = false;
				settingsOpen = false;
				await update();
			}
		};

	function currentPayload(): string {
		return JSON.stringify([title, slug, categoryId, summary, tags, contentMarkdown]);
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
		const loadedSlug = draft ? (draft.slug ?? '') : post && !post.placeholder ? post.slug : '';
		slug = loadedSlug;
		slugTouched = !!loadedSlug;
		categoryId = draft?.categoryId ?? post?.categoryId ?? '';
		summary = draft?.summary ?? post?.summary ?? '';
		tags = draft?.tags ?? post?.tags ?? '';
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
		if (!postId && !draftId && !categoryId) {
			saveState = 'needs-category';
			return;
		}
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

	async function runSave(autosave: boolean): Promise<boolean> {
		if (inFlight) {
			pendingResave = true;
			return false;
		}
		inFlight = true;
		saveState = 'saving';
		const snapshotAtSubmit = currentPayload();
		try {
			const fd = new FormData();
			fd.set('autosave', autosave ? '1' : '0');
			fd.set('title', title);
			fd.set('slug', slug);
			fd.set('categoryId', categoryId);
			fd.set('summary', summary);
			fd.set('tags', tags);
			fd.set('content', contentMarkdown);
			if (postId) fd.set('id', postId);
			if (draftId) fd.set('draftId', draftId);
			if (draftVersion != null) fd.set('draftVersion', String(draftVersion));
			if (!postId) fd.set('lang', lang);

			const response = await fetch('?/save', {
				method: 'POST',
				body: fd,
				// The JSON action protocol is selected by Accept negotiation; the
				// x-sveltekit-action header is only a bypass switch (probe finding).
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
				const d = (result.data ?? {}) as { message?: string; needsCategory?: boolean };
				if (result.status === 409) {
					saveState = 'conflict';
					conflictMessage = d.message ?? m.admin_posts_edit_conflict_short();
				} else if (result.status === 400 && d.needsCategory) {
					saveState = 'needs-category';
				} else {
					saveState = 'error';
					saveError = d.message ?? m.admin_posts_edit_err_save_failed();
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
	}

	async function onPublish() {
		if (saveState === 'conflict' || publishing) return;
		publishing = true;
		try {
			if (!draftId || isDirty()) {
				// Only publish once the working copy is actually persisted: an
				// error / throttled / in-flight save must abort the publish or we
				// would ship the server's stale draft and silently drop edits.
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

	// Slugs accept lowercase letters, digits and hyphens only.
	function onTitleInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		title = input.value;
		if (!slugTouched) slug = normalizeSlug(title.replace(/[^a-z0-9]+/g, '-'));
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
			case 'needs-category':
				return m.admin_posts_edit_pick_category_hint();
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

	const occupiedLangs = $derived(
		new Set([data.post?.lang ?? '', ...(data.siblings ?? []).map((s) => s.lang)])
	);

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
		};
	});
</script>

<svelte:head>
	<title>{title ? `${title} - Lair Admin` : `${m.admin_posts_new()} - Lair Admin`}</title>
</svelte:head>

<div class="flex h-full min-h-0 min-w-0 flex-col">
	<!-- Publish/discard/translation live in their own forms; the visible
	     controls trigger them (publish flushes the draft first). -->
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
	<form
		id="translation-form"
		method="POST"
		action="?/createTranslation"
		use:enhance={formResultHandler}
		class="hidden"
	>
		<input type="hidden" name="id" value={postId ?? ''} />
		<input type="hidden" name="lang" value={translationLang} />
	</form>

	<!-- Main content area -->
	<main class="flex min-h-full min-w-0 flex-col bg-background">
		<!-- Header area: title + slug + separator -->
		<div class="mx-auto w-full max-w-5xl shrink-0 px-3 pt-8">
			<!-- Status bar -->
			<div
				class="group mb-3 flex min-h-7 items-center justify-between gap-3 opacity-60 transition-opacity duration-200 hover:opacity-100"
			>
				<div class="flex min-w-0 items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
					<span
						aria-hidden="true"
						class="inline-block size-1.5 shrink-0 rounded-full {saveState === 'conflict'
							? 'bg-destructive'
							: 'bg-emerald-500'}"
					></span>
					<span class="truncate">
						{statusText}
						{#if data.post}
							{m.admin_posts_edit_modified()}
							{formatDateTime(new Date(data.post.updatedAt ?? data.post.createdAt), {
								dateStyle: 'short',
								timeStyle: 'short'
							})}
						{/if}
					</span>
					{#if data.post && !data.post.placeholder && data.post.status !== 'draft'}
						{#if data.draft}
							<Badge variant="secondary" class="shrink-0"
								>{m.admin_posts_unpublished_changes()}</Badge
							>
						{/if}
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
					<!-- Settings button -->
					<button
						type="button"
						onclick={() => (settingsOpen = true)}
						class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
						aria-label={m.admin_posts_edit_settings()}
						title={m.admin_posts_edit_settings()}
					>
						<IconSettings class="size-3.5" />
					</button>
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

			<!-- Title input -->
			<div class="group">
				<input
					name="title"
					class="w-full border-0 bg-transparent px-0 py-0 text-3xl font-semibold tracking-tight text-neutral-950 outline-none placeholder:font-medium placeholder:text-neutral-300 dark:text-neutral-50 dark:placeholder:text-neutral-700"
					placeholder={m.admin_posts_edit_title_placeholder()}
					bind:value={title}
					oninput={onTitleInput}
				/>
				<!-- Slug button -->
				<div class="mt-1 flex items-center gap-2">
					<button
						type="button"
						class="-ml-1 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-opacity duration-150 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-accent/15"
						onclick={() => (slugDialogOpen = true)}
						aria-label={m.admin_posts_edit_add_slug()}
					>
						<span class="truncate">{slug ? `/${slug}` : m.admin_posts_edit_add_slug_label()}</span>
						<IconPencil class="size-3 shrink-0" />
					</button>
					{#if title && !slug}
						<span class="text-xs text-destructive">{m.admin_posts_edit_slug_required_hint()}</span>
					{/if}
				</div>
			</div>

			<hr class="my-4 border-0 border-t border-neutral-100 dark:border-neutral-800" />
		</div>

		<!-- Editor area -->
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="mx-auto flex w-full max-w-5xl flex-1 flex-col px-3">
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
	</main>
</div>

<!-- Slug Dialog -->
<Dialog.Root open={slugDialogOpen} onOpenChange={(v) => (slugDialogOpen = v)}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>{m.admin_posts_edit_slug_dialog_title()}</Dialog.Title>
				<Dialog.Description>{m.admin_posts_edit_slug_dialog_desc()}</Dialog.Description>
			</Dialog.Header>
			<div class="px-6 pb-2">
				<Input
					name="slug-input"
					placeholder="my-post-slug"
					class="font-mono"
					value={slug}
					oninput={onSlugInput}
				/>
				<p class="mt-1.5 text-xs text-muted-foreground">{m.admin_posts_edit_slug_rule()}</p>
				{#if slug}
					<p class="mt-1.5 font-mono text-xs text-muted-foreground">
						{m.admin_posts_edit_slug_preview()}{slug}
					</p>
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

<!-- Settings Sheet -->
<Sheet.Root open={settingsOpen} onOpenChange={(v) => (settingsOpen = v)}>
	<Sheet.Portal>
		<Sheet.Overlay />
		<Sheet.Content side="right" class="w-full sm:max-w-sm">
			<Sheet.Header>
				<Sheet.Title>{m.admin_posts_edit_settings()}</Sheet.Title>
				<Sheet.Description>{m.admin_posts_edit_settings_desc()}</Sheet.Description>
				<Sheet.Close
					class="absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none"
				>
					<IconX class="size-4" />
					<span class="sr-only">{m.admin_common_close()}</span>
				</Sheet.Close>
			</Sheet.Header>
			<div class="flex flex-col gap-5 overflow-y-auto px-6 py-4">
				<!-- Language -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-lang" class="flex items-center gap-1.5 text-sm font-medium">
						<IconLanguage class="size-4 text-muted-foreground" />
						{m.admin_posts_edit_lang_label()}
					</label>
					{#if postId}
						<div class="flex items-center gap-2 text-sm">
							<Badge variant="outline">{lang}</Badge>
							<span class="text-xs text-muted-foreground">{m.admin_posts_edit_lang_locked()}</span>
						</div>
					{:else}
						<Select.Root type="single" bind:value={lang as never}>
							<Select.Trigger id="settings-lang" class="w-full">{lang}</Select.Trigger>
							<Select.Portal>
								<Select.Content class="z-[60]">
									{#each data.langs as l (l)}
										<Select.Item value={l}>{l}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Portal>
						</Select.Root>
					{/if}
				</div>

				<!-- Category -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-category" class="flex items-center gap-1.5 text-sm font-medium">
						<IconCategory class="size-4 text-muted-foreground" />
						{m.nav_posts_categories()}
					</label>
					<Select.Root type="single" bind:value={categoryId as never}>
						<Select.Trigger id="settings-category" class="w-full">
							{categoryId
								? (data.categories.find((c) => c.id === categoryId)?.name ??
									m.admin_categories_select())
								: m.admin_categories_select()}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="z-[60]">
								<Select.Group>
									<Select.Label>{m.nav_posts_categories()}</Select.Label>
									{#each data.categories as cat (cat.id)}
										<Select.Item value={cat.id}>{cat.name}</Select.Item>
									{/each}
								</Select.Group>
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					{#if !postId && !categoryId}
						<p class="text-xs text-muted-foreground">
							{m.admin_posts_edit_category_autosave_hint()}
						</p>
					{/if}
					{#if publishErrors.categoryId}
						<p class="text-sm text-destructive">{publishErrors.categoryId}</p>
					{/if}
				</div>

				<!-- Tags -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-tags" class="flex items-center gap-1.5 text-sm font-medium">
						<IconTag class="size-4 text-muted-foreground" />
						{m.admin_tags_nav()}
					</label>
					<Input id="settings-tags" placeholder="svelte, typescript, tutorial" bind:value={tags} />
					<p class="text-xs text-muted-foreground">{m.admin_posts_edit_tags_hint()}</p>
				</div>

				<!-- Summary -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-summary" class="flex items-center gap-1.5 text-sm font-medium">
						<IconFileDescription class="size-4 text-muted-foreground" />
						{m.admin_posts_edit_summary_label()}
					</label>
					<Textarea
						id="settings-summary"
						placeholder={m.admin_posts_edit_summary_placeholder()}
						bind:value={summary}
						rows={4}
					/>
				</div>

				<!-- Translation family -->
				<div class="flex flex-col gap-2">
					<div class="flex items-center gap-1.5 text-sm font-medium">
						<IconLanguage class="size-4 text-muted-foreground" />
						{m.admin_posts_edit_translations()}
					</div>
					{#if data.siblings.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each data.siblings as s (s.id)}
								<Badge variant={s.status === 'published' ? 'default' : 'outline'}>
									{s.lang}·{s.status === 'published'
										? m.admin_posts_status_published()
										: m.admin_posts_status_draft()}
								</Badge>
							{/each}
						</div>
					{:else}
						<p class="text-xs text-muted-foreground">{m.admin_posts_edit_no_translations()}</p>
					{/if}
					{#if postId}
						<Button
							type="button"
							variant="outline"
							class="w-full"
							onclick={() => {
								translationLang = '';
								translationOpen = true;
							}}
						>
							<IconLanguage class="size-4" />
							{m.admin_posts_edit_create_translation()}
						</Button>
					{/if}
				</div>

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
									{draftId ? m.admin_posts_edit_discard_desc() : ''}
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

<!-- Translation dialog -->
<Dialog.Root open={translationOpen} onOpenChange={(v) => (translationOpen = v)}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>{m.admin_posts_edit_create_translation()}</Dialog.Title>
				<Dialog.Description>
					{m.admin_posts_edit_translation_desc()}
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-3 px-6 pb-2">
				<Select.Root type="single" bind:value={translationLang as never}>
					<Select.Trigger class="w-full">
						{translationLang || m.admin_posts_edit_target_lang()}
					</Select.Trigger>
					<Select.Portal>
						<Select.Content class="z-[60]">
							{#each data.langs as l (l)}
								<Select.Item value={l} disabled={occupiedLangs.has(l)}>
									{l}{occupiedLangs.has(l) ? m.admin_posts_edit_lang_exists() : ''}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Portal>
				</Select.Root>
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button
					disabled={!translationLang || occupiedLangs.has(translationLang)}
					onclick={() => {
						const f = document.getElementById('translation-form');
						if (f instanceof HTMLFormElement) f.requestSubmit();
					}}
				>
					<IconSend class="size-4" />
					{m.admin_common_create()}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
