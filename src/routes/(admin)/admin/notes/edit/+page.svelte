<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance, deserialize } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { ActionResult } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Alert from '$lib/components/ui/alert';
	import { MarkdownEditor } from '$lib/components/markdown';
	import { formatDateTime } from '$lib/utils/i18n';
	import { titleSlug } from '$lib/utils/slug';
	import {
		NOTE_EMOTIONS,
		NOTE_EMOTION_LABELS,
		NOTE_MOODS,
		NOTE_MOOD_LABELS,
		NOTE_WEATHER
	} from '$lib/utils/note-meta';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconCategory from '@tabler/icons-svelte-runes/icons/category';
	import IconMoodSmile from '@tabler/icons-svelte-runes/icons/mood-smile';
	import IconCloudRain from '@tabler/icons-svelte-runes/icons/cloud-rain';
	import IconMapPin from '@tabler/icons-svelte-runes/icons/map-pin';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconLanguage from '@tabler/icons-svelte-runes/icons/language';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconCloudUpload from '@tabler/icons-svelte-runes/icons/cloud-upload';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import IconMessage from '@tabler/icons-svelte-runes/icons/message';
	import IconArchive from '@tabler/icons-svelte-runes/icons/archive';
	import IconArrowBackUp from '@tabler/icons-svelte-runes/icons/arrow-back-up';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const AUTOSAVE_DEBOUNCE_MS = 2500;
	const THROTTLE_RETRY_MS = 12_000;
	const NONE = '__none__';

	// ── Editor state ─────────────────────────────────────────────────────
	let title = $state('');
	let slug = $state('');
	let slugTouched = $state(false);
	let topicId = $state('');
	let mood = $state('');
	let weatherCode = $state('');
	let temperatureC = $state('');
	let latitude = $state('');
	let longitude = $state('');
	let location = $state('');
	let contentMarkdown = $state('');
	let lang = $state<string>(untrack(() => data.defaultLang));

	let noteId = $state<string | null>(null);
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

	/**
	 * Row-level action handler (pin / comments / emotions / password): the
	 * settings sheet stays open so several toggles can be made in a row; only
	 * a failure banner changes on error.
	 */
	const rowActionHandler =
		() =>
		async ({ result, update }: FormResultInput) => {
			if (result.type === 'failure') {
				const d = (result.data ?? {}) as { message?: string };
				publishErrors = d.message ? { form: d.message } : {};
			} else {
				publishErrors = {};
				await update();
			}
		};

	function currentPayload(): string {
		return JSON.stringify([
			title,
			slug,
			topicId,
			mood,
			weatherCode,
			temperatureC,
			latitude,
			longitude,
			location,
			contentMarkdown
		]);
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
		const note = data.note;
		title = draft?.title ?? note?.title ?? '';
		slug = draft ? (draft.slug ?? '') : note && !note.placeholder ? note.slug : '';
		slugTouched = !!slug;
		topicId = draft?.topicId ?? note?.topicId ?? '';
		mood = draft?.mood ?? note?.mood ?? '';
		weatherCode =
			draft?.weatherCode != null
				? String(draft.weatherCode)
				: note?.weatherCode != null
					? String(note.weatherCode)
					: '';
		temperatureC = draft?.temperatureC ?? note?.temperatureC ?? '';
		latitude = draft?.coordinates
			? String(draft.coordinates.latitude)
			: note?.coordinates
				? String(note.coordinates.latitude)
				: '';
		longitude = draft?.coordinates
			? String(draft.coordinates.longitude)
			: note?.coordinates
				? String(note.coordinates.longitude)
				: '';
		location = draft?.location ?? note?.location ?? '';
		// A published note without a draft opens on its published content;
		// an empty editor here silently staged a blank first draft.
		contentMarkdown = draft?.content ?? note?.content ?? '';
		lang = note?.lang ?? data.defaultLang;
		noteId = note?.id ?? null;
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

	// Background refreshes (row-level actions, the first-save URL anchor) must
	// never replay the server copy over unsaved edits: draft.version stays OUT
	// of the key - it advances on every autosave, which used to make any
	// row-level click wipe the editor working copy (round-7 review finding).
	// reloadFromServer() remounts the editor explicitly via editorEpoch.
	const dataKey = $derived(`${data.note?.id ?? 'new'}@${data.draft?.id ?? ''}`);
	let loadedKey = $state(untrack(() => dataKey));
	/** Bumped to force an editor remount (MarkdownEditor reads initialMarkdown at mount only). */
	let editorEpoch = $state(0);
	$effect(() => {
		if (dataKey === loadedKey) return;
		loadedKey = dataKey;
		// The draft vanished server-side (published or discarded from this or
		// another tab): drop the stale address so the dirty working copy can
		// re-save as a FRESH draft instead of 409ing against a deleted row
		// (verify-round finding).
		if (!data.draft && draftId !== null) {
			draftId = null;
			draftVersion = null;
		}
		if (isDirty()) return; // keep the working copy; id state already tracks the save
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

	async function runSave(autosave: boolean): Promise<boolean> {
		if (inFlight) {
			if (autosave) {
				pendingResave = true;
				return false;
			}
			// Manual saves (and the publish flush) must not be dropped by a race
			// with the autosave flight: wait it out, then save the latest state
			// below (round-7 review finding).
			for (let waited = 0; waited < 100 && inFlight; waited += 1) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (inFlight) return false;
		}
		inFlight = true;
		saveState = 'saving';
		const snapshotAtSubmit = currentPayload();
		try {
			const fd = new FormData();
			fd.set('autosave', autosave ? '1' : '0');
			fd.set('title', title);
			fd.set('slug', slug);
			fd.set('topicId', topicId);
			fd.set('mood', mood);
			fd.set('weatherCode', weatherCode);
			fd.set('temperatureC', temperatureC);
			fd.set('latitude', latitude);
			fd.set('longitude', longitude);
			fd.set('location', location);
			fd.set('content', contentMarkdown);
			if (noteId) fd.set('id', noteId);
			if (draftId) fd.set('draftId', draftId);
			if (draftVersion != null) fd.set('draftVersion', String(draftVersion));
			if (!noteId) fd.set('lang', lang);

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
				saveError = '登录已失效，请重新登录后继续（修改尚未保存）';
				reauthUrl = result.location ?? null;
			} else if (result.type === 'success') {
				const d = result.data as {
					saved: boolean;
					reason?: 'unchanged' | 'throttled';
					draftId: string;
					draftVersion: number;
					noteId: string | null;
					retryAfterMs?: number;
					updatedAt?: Date | string | null;
				};
				reauthUrl = null;
				draftId = d.draftId;
				draftVersion = d.draftVersion;
				if (d.noteId && d.noteId !== noteId) {
					noteId = d.noteId;
					// First save of a new note: anchor the URL to the row.
					replaceState(`/admin/notes/edit?id=${d.noteId}${page.url.search}`, {});
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
					conflictMessage = d.message ?? '内容已在其他窗口更新';
				} else {
					// Prefer the graded field errors (e.g. a topic deleted while
					// the editor held its id) over the generic message.
					const graded = Object.values(d.errors ?? {}).filter(Boolean);
					saveState = 'error';
					saveError = graded.length > 0 ? graded.join('；') : (d.message ?? '保存失败');
				}
			} else {
				saveState = 'error';
				saveError = '网络异常，稍后将重试';
				scheduleSave(THROTTLE_RETRY_MS);
			}
		} catch {
			saveState = 'error';
			saveError = '网络异常，稍后将重试';
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
		try {
			if (!draftId || isDirty()) {
				// Flush the working copy first. runSave() itself waits out any
				// in-flight autosave (a `saveState`-based wait missed the case
				// where typing mid-flight flips the state to 'dirty' - round-7
				// review finding); only real end-states (conflict / error /
				// session loss) abort here.
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

	// The shared titleSlug rule (CJK kept, separators collapsed) lives in
	// $lib/utils/slug - the local copy had drifted without its 120-char cap
	// (review finding).
	function onTitleInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		title = input.value;
		if (!slugTouched) slug = titleSlug(title);
	}

	function onSlugInput(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		slugTouched = true;
		slug = titleSlug(input.value);
	}

	// Transient banners for ?published=1 / ?discarded=1 / ?private=1 / ?restored=1.
	// afterNavigate (not $effect) - replaceState throws before the router is
	// initialized, which a hard load of such a URL used to hit (dev probe).
	afterNavigate(() => {
		const params = page.url.searchParams;
		let message: string | null = null;
		if (params.get('published') === '1') message = '已发布';
		else if (params.get('discarded') === '1') message = '草稿已丢弃';
		else if (params.get('private') === '1') message = '已转为私密';
		else if (params.get('restored') === '1') message = '已从回收站恢复';
		if (!message) return;
		flash = message;
		if (flashTimer) clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flash = null), 3500);
		const url = new URL(page.url);
		for (const key of ['published', 'discarded', 'private', 'restored'])
			url.searchParams.delete(key);
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
				return '保存中…';
			case 'saved':
				return lastSavedAt
					? `已保存 ${formatDateTime(lastSavedAt, { timeStyle: 'medium' })}`
					: '已保存';
			case 'dirty':
				return '未保存的修改';
			case 'throttled':
				return '自动保存节流中，稍后重试…';
			case 'conflict':
				return '冲突：服务端已有更新';
			case 'error':
				return saveError ?? '保存失败';
			default:
				return null;
		}
	});

	const statusText = $derived.by(() => {
		if (!data.note) return '新手记';
		if (data.note.status === 'published') return '已发布';
		if (data.note.status === 'private') return '私密';
		if (data.note.status === 'scheduled') return '定时发布';
		if (data.note.status === 'trash') return '回收站';
		return '草稿';
	});

	// Static option list: no reactive dependency, computed once per module.
	const weatherOptions = Object.entries(NOTE_WEATHER)
		.map(([code, entry]) => ({
			value: code,
			label: `${code} ${entry.labels['zh-cn'] ?? entry.labels.en}`
		}))
		.sort((a, b) => Number(a.value) - Number(b.value));

	let beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
	$effect(() => {
		beforeUnloadHandler = (e: BeforeUnloadEvent) => {
			// A conflict freezes SAVES but the typed text is still unsaved and
			// would be lost silently; guard it like any other dirty state.
			if (isDirty()) {
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
	<title>{title ? `${title} - Lair Admin` : 'New Note - Lair Admin'}</title>
</svelte:head>

<div class="flex h-full min-h-0 min-w-0 flex-col">
	<!-- Publish/discard/status live in their own forms; the visible controls
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
						{#if data.note}
							· 修改于
							{formatDateTime(new Date(data.note.updatedAt ?? data.note.createdAt), {
								dateStyle: 'short',
								timeStyle: 'short'
							})}
						{/if}
					</span>
					{#if data.note && !data.note.placeholder && data.note.status !== 'draft'}
						{#if data.draft}
							<Badge variant="secondary" class="shrink-0">有未发布改动</Badge>
						{/if}
					{/if}
					{#if data.note?.locked}
						<IconLock class="size-3.5 shrink-0" role="img" aria-label="已加密" />
					{/if}
					{#if data.note?.pinAt}
						<IconPin class="size-3.5 shrink-0" role="img" aria-label="已置顶" />
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
						aria-label="手记设置"
						title="手记设置"
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
						保存草稿
					</Button>
					<Button
						type="button"
						size="sm"
						class="h-7 gap-1 px-2.5 text-xs"
						onclick={() => void onPublish()}
						disabled={publishing || saveState === 'conflict'}
					>
						<IconCloudUpload class="size-3" />
						发布
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
									'内容已在其他窗口更新'}——编辑已暂停，请先载入服务端最新内容。</span
							>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onclick={() => void reloadFromServer()}
							>
								载入服务端最新
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
							<span>{saveError ?? '登录状态已失效'}</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onclick={() => window.location.assign(reauthUrl ?? '/')}
							>
								重新登录
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
					<span class="shrink-0 font-medium">无法完成:</span>
					<span class="min-w-0">{activeErrors.join('；')}</span>
				</div>
			{/if}

			<!-- Title input -->
			<div class="group">
				<input
					name="title"
					aria-label="标题"
					class="w-full border-0 bg-transparent px-0 py-0 text-3xl font-semibold tracking-tight text-neutral-950 outline-none placeholder:font-medium placeholder:text-neutral-300 dark:text-neutral-50 dark:placeholder:text-neutral-700"
					placeholder="输入标题..."
					bind:value={title}
					oninput={onTitleInput}
				/>
				<!-- Slug button -->
				<div class="mt-1 flex items-center gap-2">
					<button
						type="button"
						class="-ml-1 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-opacity duration-150 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-accent/15"
						onclick={() => (slugDialogOpen = true)}
						aria-label="添加 slug"
					>
						<span class="truncate">{slug ? `/${slug}` : '+ 添加 slug'}</span>
						<IconPencil class="size-3 shrink-0" />
					</button>
					{#if title && !slug}
						<span class="text-xs text-destructive">发布前需要填写 slug</span>
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
						initialMarkdown={contentMarkdown}
						placeholder="输入正文..."
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
				<Dialog.Title>设置 Slug</Dialog.Title>
				<Dialog.Description>URL 友好的标识符，用于手记链接。</Dialog.Description>
			</Dialog.Header>
			<div class="px-6 pb-2">
				<Input
					name="slug-input"
					aria-label="Slug"
					placeholder="my-note-slug"
					class="font-mono"
					value={slug}
					oninput={onSlugInput}
				/>
				<p class="mt-1.5 text-xs text-muted-foreground">仅限小写字母、数字、汉字和连字符</p>
				{#if slug}
					<p class="mt-1.5 font-mono text-xs text-muted-foreground">预览: /notes/{slug}</p>
				{/if}
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>取消</Button>
					{/snippet}
				</Dialog.Close>
				<Button onclick={() => (slugDialogOpen = false)}>确定</Button>
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
				<Sheet.Title>手记设置</Sheet.Title>
				<Sheet.Description>配置手记的元数据信息。</Sheet.Description>
				<Sheet.Close
					class="absolute top-4 right-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none"
				>
					<IconX class="size-4" />
					<span class="sr-only">关闭</span>
				</Sheet.Close>
			</Sheet.Header>
			<div class="flex flex-col gap-5 overflow-y-auto px-6 py-4">
				<!-- Language -->
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center gap-1.5 text-sm font-medium">
						<IconLanguage class="size-4 text-muted-foreground" />
						语言
					</div>
					{#if noteId}
						<div class="flex items-center gap-2 text-sm">
							<Badge variant="outline">{lang}</Badge>
							<span class="text-xs text-muted-foreground">创建后不可更改</span>
						</div>
					{:else}
						<Select.Root type="single" bind:value={lang as never}>
							<Select.Trigger id="settings-lang" aria-label="语言" class="w-full"
								>{lang}</Select.Trigger
							>
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

				<!-- Topic (optional) -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-topic" class="flex items-center gap-1.5 text-sm font-medium">
						<IconCategory class="size-4 text-muted-foreground" />
						专栏
					</label>
					<Select.Root
						type="single"
						value={topicId === '' ? NONE : topicId}
						onValueChange={(v) => (topicId = v === NONE || v == null ? '' : v)}
					>
						<Select.Trigger id="settings-topic" class="w-full">
							{topicId
								? (data.topics.find((t) => t.id === topicId)?.name ?? '选择专栏')
								: '（不设置）'}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="z-[60]">
								<Select.Item value={NONE}>（不设置）</Select.Item>
								{#each data.topics as topic (topic.id)}
									<Select.Item value={topic.id}>{topic.name}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					{#if publishErrors.topicId}
						<p class="text-sm text-destructive">{publishErrors.topicId}</p>
					{/if}
				</div>

				<!-- Mood (five levels) -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-mood" class="flex items-center gap-1.5 text-sm font-medium">
						<IconMoodSmile class="size-4 text-muted-foreground" />
						心情
					</label>
					<Select.Root
						type="single"
						value={mood === '' ? NONE : mood}
						onValueChange={(v) => (mood = v === NONE || v == null ? '' : v)}
					>
						<Select.Trigger id="settings-mood" class="w-full">
							{mood
								? (NOTE_MOOD_LABELS[mood as (typeof NOTE_MOODS)[number]]?.['zh-cn'] ?? mood)
								: '（不设置）'}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="z-[60]">
								<Select.Item value={NONE}>（不设置）</Select.Item>
								{#each NOTE_MOODS as level (level)}
									<Select.Item value={level}>{NOTE_MOOD_LABELS[level]['zh-cn']}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Portal>
					</Select.Root>
				</div>

				<!-- Emotions (38-token flat multi-select) -->
				<div class="flex flex-col gap-1.5">
					<div class="flex items-center gap-1.5 text-sm font-medium">
						<IconMoodSmile class="size-4 text-muted-foreground" />
						情绪
					</div>
					{#if noteId}
						<form method="POST" action="?/emotions" use:enhance={rowActionHandler}>
							<input type="hidden" name="id" value={noteId} />
							<div class="grid grid-cols-2 gap-x-3 gap-y-1.5">
								{#each NOTE_EMOTIONS as token (token)}
									<label class="flex items-center gap-1.5 text-xs">
										<input
											type="checkbox"
											name="emotions"
											value={token}
											checked={data.note?.emotions.includes(token) ?? false}
											class="size-3.5 rounded border-border bg-transparent"
										/>
										{NOTE_EMOTION_LABELS[token]['zh-cn']}
									</label>
								{/each}
							</div>
							<Button type="submit" variant="outline" size="sm" class="mt-2 w-full">
								保存情绪选择
							</Button>
							<p class="mt-1 text-xs text-muted-foreground">发布前后均可调整；仅作展示标签。</p>
						</form>
					{:else}
						<p class="text-xs text-muted-foreground">首次保存后即可设置情绪标签。</p>
					{/if}
				</div>

				<!-- Weather / temperature / location / coordinates (draft fields) -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-weather" class="flex items-center gap-1.5 text-sm font-medium">
						<IconCloudRain class="size-4 text-muted-foreground" />
						天气
					</label>
					<Select.Root
						type="single"
						value={weatherCode === '' ? NONE : weatherCode}
						onValueChange={(v) => (weatherCode = v === NONE || v == null ? '' : v)}
					>
						<Select.Trigger id="settings-weather" class="w-full">
							{weatherCode
								? (weatherOptions.find((o) => o.value === weatherCode)?.label ?? weatherCode)
								: '（不设置）'}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="z-[60]">
								<Select.Item value={NONE}>（不设置）</Select.Item>
								{#each weatherOptions as option (option.value)}
									<Select.Item value={option.value}>{option.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Portal>
					</Select.Root>
				</div>
				<div class="flex items-end gap-3">
					<div class="flex flex-1 flex-col gap-1.5">
						<label for="settings-temp" class="text-sm font-medium">温度（°C）</label>
						<Input
							id="settings-temp"
							type="number"
							step="0.1"
							placeholder="21.5"
							bind:value={temperatureC}
						/>
					</div>
					<div class="flex flex-1 flex-col gap-1.5">
						<label for="settings-location" class="text-sm font-medium">位置</label>
						<Input id="settings-location" placeholder="Taipei" bind:value={location} />
					</div>
				</div>
				<div class="flex items-end gap-3">
					<div class="flex flex-1 flex-col gap-1.5">
						<label for="settings-lat" class="text-sm font-medium">纬度</label>
						<Input id="settings-lat" placeholder="25.03" bind:value={latitude} />
					</div>
					<div class="flex flex-1 flex-col gap-1.5">
						<label for="settings-lng" class="text-sm font-medium">经度</label>
						<Input id="settings-lng" placeholder="121.56" bind:value={longitude} />
					</div>
				</div>
				<p class="-mt-3 text-xs text-muted-foreground">
					<IconMapPin class="inline size-3" />
					位置与坐标成对写入；空值表示不记录。
				</p>

				<!-- Row-level settings (never staged in drafts) -->
				{#if noteId}
					<div class="flex flex-col gap-2">
						<div class="flex items-center gap-1.5 text-sm font-medium">
							<IconMessage class="size-4 text-muted-foreground" />
							行级设置
						</div>
						<form method="POST" action="?/pin" use:enhance={rowActionHandler}>
							<input type="hidden" name="id" value={noteId} />
							<input type="hidden" name="value" value={data.note?.pinAt ? '0' : '1'} />
							<Button type="submit" variant="outline" size="sm" class="w-full">
								<IconPin class="size-4" />
								{data.note?.pinAt ? '取消置顶' : '置顶'}
							</Button>
						</form>
						<form method="POST" action="?/comments" use:enhance={rowActionHandler}>
							<input type="hidden" name="id" value={noteId} />
							<input type="hidden" name="value" value={data.note?.allowComment ? '0' : '1'} />
							<Button type="submit" variant="outline" size="sm" class="w-full">
								<IconMessage class="size-4" />
								{data.note?.allowComment ? '关闭评论' : '开启评论'}
							</Button>
						</form>
						<form method="POST" action="?/password" use:enhance={rowActionHandler}>
							<input type="hidden" name="id" value={noteId} />
							<div class="flex items-center gap-2">
								<Input
									name="password"
									type="password"
									aria-label="新密码"
									placeholder="设置/更新密码（留空清除）"
									autocomplete="new-password"
								/>
								<Button type="submit" variant="outline" size="sm" class="shrink-0">
									<IconLock class="size-3.5" />
									保存
								</Button>
							</div>
						</form>
						<p class="text-xs text-muted-foreground">
							当前状态：{data.note?.locked
								? '已设置密码（修改或清除会立刻失效所有已解锁 cookie）'
								: '未设置密码'}
						</p>
					</div>

					<!-- Translation family -->
					<div class="flex flex-col gap-2">
						<div class="flex items-center gap-1.5 text-sm font-medium">
							<IconLanguage class="size-4 text-muted-foreground" />
							多语言版本
						</div>
						{#if data.siblings.length > 0}
							<div class="flex flex-wrap gap-1.5">
								{#each data.siblings as s (s.id)}
									<Badge variant={s.status === 'published' ? 'default' : 'outline'}>
										{s.lang}·{s.status === 'published' ? '已发布' : '草稿'}
									</Badge>
								{/each}
							</div>
						{:else}
							<p class="text-xs text-muted-foreground">
								暂无其他语言版本（翻译流水线随后续批次）。
							</p>
						{/if}
					</div>

					<!-- Status actions -->
					<div class="flex flex-col gap-2">
						<div class="flex items-center gap-1.5 text-sm font-medium">
							<IconArchive class="size-4 text-muted-foreground" />
							状态
						</div>
						{#if data.note?.status === 'trash'}
							<form method="POST" action="?/status" use:enhance={formResultHandler}>
								<input type="hidden" name="id" value={noteId} />
								<input type="hidden" name="action" value="restore" />
								<Button type="submit" variant="outline" size="sm" class="w-full">
									<IconArrowBackUp class="size-4" />
									从回收站恢复
								</Button>
							</form>
						{:else if data.note?.status === 'private'}
							<form method="POST" action="?/status" use:enhance={formResultHandler}>
								<input type="hidden" name="id" value={noteId} />
								<input type="hidden" name="action" value="restore" />
								<Button type="submit" variant="outline" size="sm" class="w-full">
									<IconArrowBackUp class="size-4" />
									恢复公开（回已发布或草稿）
								</Button>
							</form>
							<form method="POST" action="?/status" use:enhance={formResultHandler}>
								<input type="hidden" name="id" value={noteId} />
								<input type="hidden" name="action" value="trash" />
								<Button
									type="submit"
									variant="outline"
									size="sm"
									class="w-full border-destructive/30 text-destructive hover:bg-destructive/10"
								>
									<IconArchive class="size-4" />
									移入回收站
								</Button>
							</form>
						{:else}
							<form method="POST" action="?/status" use:enhance={formResultHandler}>
								<input type="hidden" name="id" value={noteId} />
								<input type="hidden" name="action" value="private" />
								<Button type="submit" variant="outline" size="sm" class="w-full">
									转为私密（不上前台）
								</Button>
							</form>
							<form method="POST" action="?/status" use:enhance={formResultHandler}>
								<input type="hidden" name="id" value={noteId} />
								<input type="hidden" name="action" value="trash" />
								<Button
									type="submit"
									variant="outline"
									size="sm"
									class="w-full border-destructive/30 text-destructive hover:bg-destructive/10"
								>
									<IconArchive class="size-4" />
									移入回收站
								</Button>
							</form>
						{/if}
					</div>
				{:else}
					<p class="text-xs text-muted-foreground">首次保存后可配置置顶 / 评论开关 / 密码。</p>
				{/if}

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
									丢弃草稿
								</Button>
							{/snippet}
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>丢弃未发布的改动？</AlertDialog.Title>
								<AlertDialog.Description>
									{draftId
										? '将删除当前草稿。若是从未发布过的新手记，连占位记录一并删除。此操作不可撤销。'
										: ''}
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>取消</AlertDialog.Cancel>
								<AlertDialog.Action
									onclick={() => {
										const f = document.getElementById('discard-form');
										if (f instanceof HTMLFormElement) f.requestSubmit();
									}}
								>
									丢弃
								</AlertDialog.Action>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
				{/if}
			</div>
		</Sheet.Content>
	</Sheet.Portal>
</Sheet.Root>
