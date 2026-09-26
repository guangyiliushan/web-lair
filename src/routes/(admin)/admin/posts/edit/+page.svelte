<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { enhance, deserialize } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { ActionResult } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';
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
				saveError = '登录已失效，请重新登录后继续（修改尚未保存）';
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
					conflictMessage = d.message ?? '内容已在其他窗口更新';
				} else if (result.status === 400 && d.needsCategory) {
					saveState = 'needs-category';
				} else {
					saveState = 'error';
					saveError = d.message ?? '保存失败';
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
		if (params.get('published') === '1') message = '已发布';
		else if (params.get('discarded') === '1') message = '草稿已丢弃';
		else if (params.get('translation') === '1') message = '翻译草稿已创建';
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
				return '保存中…';
			case 'saved':
				return lastSavedAt
					? `已保存 ${formatDateTime(lastSavedAt, { timeStyle: 'medium' })}`
					: '已保存';
			case 'dirty':
				return '未保存的修改';
			case 'throttled':
				return '自动保存节流中，稍后重试…';
			case 'needs-category':
				return '选定分类后开始自动保存';
			case 'conflict':
				return '冲突：服务端已有更新';
			case 'error':
				return saveError ?? '保存失败';
			default:
				return null;
		}
	});

	const statusText = $derived.by(() => {
		if (!data.post) return '新文章';
		if (data.source) {
			const pending = data.post.status === 'draft' && data.post.version === 0;
			return `译文${pending ? '（待翻译）' : ''} · 源《${data.source.title}》`;
		}
		if (data.post.status === 'published') return '已发布';
		if (data.post.status === 'scheduled') return '定时发布';
		if (data.post.status === 'trash') return '回收站';
		return '草稿';
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
	<title>{title ? `${title} - Lair Admin` : 'New Post - Lair Admin'}</title>
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
							· 修改于
							{formatDateTime(new Date(data.post.updatedAt ?? data.post.createdAt), {
								dateStyle: 'short',
								timeStyle: 'short'
							})}
						{/if}
					</span>
					{#if data.post && !data.post.placeholder && data.post.status !== 'draft'}
						{#if data.draft}
							<Badge variant="secondary" class="shrink-0">有未发布改动</Badge>
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
						aria-label="文章设置"
						title="文章设置"
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
						<span class="text-xs text-destructive">发布前需要填写英文 slug</span>
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
				<Dialog.Description>URL 友好的标识符，用于文章链接。</Dialog.Description>
			</Dialog.Header>
			<div class="px-6 pb-2">
				<Input
					name="slug-input"
					placeholder="my-post-slug"
					class="font-mono"
					value={slug}
					oninput={onSlugInput}
				/>
				<p class="mt-1.5 text-xs text-muted-foreground">仅限小写英文、数字和连字符</p>
				{#if slug}
					<p class="mt-1.5 font-mono text-xs text-muted-foreground">预览: /posts/{slug}</p>
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
				<Sheet.Title>文章设置</Sheet.Title>
				<Sheet.Description>配置文章的元数据信息。</Sheet.Description>
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
					<label for="settings-lang" class="flex items-center gap-1.5 text-sm font-medium">
						<IconLanguage class="size-4 text-muted-foreground" />
						语言
					</label>
					{#if postId}
						<div class="flex items-center gap-2 text-sm">
							<Badge variant="outline">{lang}</Badge>
							<span class="text-xs text-muted-foreground">创建后不可更改</span>
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
						分类
					</label>
					<Select.Root type="single" bind:value={categoryId as never}>
						<Select.Trigger id="settings-category" class="w-full">
							{categoryId
								? (data.categories.find((c) => c.id === categoryId)?.name ?? '选择分类')
								: '选择分类'}
						</Select.Trigger>
						<Select.Portal>
							<Select.Content class="z-[60]">
								<Select.Group>
									<Select.Label>分类</Select.Label>
									{#each data.categories as cat (cat.id)}
										<Select.Item value={cat.id}>{cat.name}</Select.Item>
									{/each}
								</Select.Group>
							</Select.Content>
						</Select.Portal>
					</Select.Root>
					{#if !postId && !categoryId}
						<p class="text-xs text-muted-foreground">选定分类后即可自动保存。</p>
					{/if}
					{#if publishErrors.categoryId}
						<p class="text-sm text-destructive">{publishErrors.categoryId}</p>
					{/if}
				</div>

				<!-- Tags -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-tags" class="flex items-center gap-1.5 text-sm font-medium">
						<IconTag class="size-4 text-muted-foreground" />
						标签
					</label>
					<Input id="settings-tags" placeholder="svelte, typescript, tutorial" bind:value={tags} />
					<p class="text-xs text-muted-foreground">逗号分隔；发布时同步到标签库。</p>
				</div>

				<!-- Summary -->
				<div class="flex flex-col gap-1.5">
					<label for="settings-summary" class="flex items-center gap-1.5 text-sm font-medium">
						<IconFileDescription class="size-4 text-muted-foreground" />
						摘要
					</label>
					<Textarea
						id="settings-summary"
						placeholder="文章简短描述...（可留空；AI 摘要采纳随 P2/P3 钩子）"
						bind:value={summary}
						rows={4}
					/>
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
						<p class="text-xs text-muted-foreground">暂无其他语言版本。</p>
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
							创建翻译
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
									丢弃草稿
								</Button>
							{/snippet}
						</AlertDialog.Trigger>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>丢弃未发布的改动？</AlertDialog.Title>
								<AlertDialog.Description>
									{draftId
										? '将删除当前草稿。若是从未发布过的新文章，连占位记录一并删除。此操作不可撤销。'
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

<!-- Translation dialog -->
<Dialog.Root open={translationOpen} onOpenChange={(v) => (translationOpen = v)}>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>创建翻译</Dialog.Title>
				<Dialog.Description>
					复制当前文章的标题/正文/摘要为新草稿（同组、slug 留空），再逐段翻译并发布。
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-3 px-6 pb-2">
				<Select.Root type="single" bind:value={translationLang as never}>
					<Select.Trigger class="w-full">
						{translationLang || '选择目标语言'}
					</Select.Trigger>
					<Select.Portal>
						<Select.Content class="z-[60]">
							{#each data.langs as l (l)}
								<Select.Item value={l} disabled={occupiedLangs.has(l)}>
									{l}{occupiedLangs.has(l) ? '（已存在）' : ''}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Portal>
				</Select.Root>
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>取消</Button>
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
					创建
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
