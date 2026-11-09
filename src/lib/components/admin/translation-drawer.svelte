<script lang="ts" module>
	export type DrawerAction =
		| 'generate'
		| 'copy-source'
		| 'accept'
		| 'retry'
		| 'discard'
		| 'retranslate'
		| 'refresh'
		| 'open-target';

	/** The drawer reads only what it paints; the editor owns the row. */
	export type DrawerCandidate = {
		id: string;
		targetLang: string;
		status: string;
		title: string;
		content: string | null;
		/** Live body while the run streams; `content` supersedes it. */
		partial?: string | null;
		/** Chunk counters while a segmented run progresses. */
		chunksDone?: number | null;
		chunksTotal?: number | null;
		/** Glossary terms the finished body ignored; advisory. */
		glossaryMisses?: { term: string; expected: string }[] | null;
		error: string | null;
	};
</script>

<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Button } from '$lib/components/ui/button';
	import { MarkdownRenderer } from '$lib/components/markdown';
	import { m } from '$lib/paraglide/messages';
	import type { DrawerState } from '$lib/utils/translation-drawer-state';
	import { queuedPresentation } from '$lib/utils/translation-drawer-state';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';

	let {
		open = $bindable(false),
		lang,
		state: langState,
		candidate,
		source,
		targetId = null,
		busy,
		error,
		notice = null,
		canGenerate = true,
		canRetranslate = false,
		job = null,
		stage = null,
		waitingReason = null,
		budget = null,
		readiness = null,
		glossaryMisses = null,
		onAction
	}: {
		open?: boolean;
		lang: string;
		state: DrawerState;
		candidate: DrawerCandidate | null;
		source: { lang: string; content: string | null };
		/** The row behind the language, when the language has one. */
		targetId?: string | null;
		/** Only a draft row with content behind it can be translated again. */
		canRetranslate?: boolean;
		/** Generation reads the published body, which a new post does not have. */
		canGenerate?: boolean;
		busy: boolean;
		error: string | null;
		/** In-place accept: the page must reload for the draft to show it. */
		notice?: { text: string; href: string } | null;
		/**
		 * Job-level liveness from `job_runs`. A queued row with no running drain
		 * is waiting for a worker that may never come - never "generating".
		 */
		job?: {
			queuedAgeSec: number | null;
			runningSinceSec: number | null;
			lastStatus: string | null;
		} | null;
		/**
		 * The row's own `stage` and why it is parked. A rate limit, a network
		 * outage or a paused budget releases the row (`stage='waiting'`) but
		 * keeps it queued, so the drawer has to explain the pause instead of
		 * painting a generation that is not happening.
		 */
		stage?: string | null;
		waitingReason?: string | null;
		/** A paused budget is why a queued row is not moving; display only. */
		budget?: { paused: boolean; monthly: number; spent: number; currency: string } | null;
		/** Readiness gate: Generate must not promise an unconfigured slot. */
		readiness?: { status: string } | null;
		/**
		 * Glossary terms the finished body ignored. Advisory: the candidate stays
		 * usable, the list just points at rows worth reviewing.
		 */
		glossaryMisses?: { term: string; expected: string }[] | null;
		onAction: (action: DrawerAction) => void | Promise<void>;
	} = $props();

	type FooterItem = { action: DrawerAction; label: string };

	const stateLabel = $derived.by(() => {
		switch (langState) {
			case 'empty':
				return m.admin_posts_edit_translation_state_empty();
			case 'queued': {
				// The token keeps the copy decision out of the state algebra
				// (invariant I1): parked explains itself, claimed is generating,
				// unclaimed is waiting for a worker that may never come.
				const presentation = queuedPresentation({
					stage,
					waitingReason,
					runningSinceSec: job?.runningSinceSec ?? null
				});
				if (presentation === 'waiting' && waitingReason)
					return m.admin_posts_edit_translation_waiting({ reason: waitingReason });
				return presentation === 'running'
					? m.admin_posts_edit_translation_state_queued()
					: m.admin_posts_edit_translation_pending();
			}
			case 'candidate':
				return m.admin_posts_edit_translation_state_candidate();
			case 'failed':
				return m.admin_posts_edit_translation_state_failed();
			case 'draft':
				return m.admin_posts_edit_translation_state_draft();
			case 'published':
				return m.admin_posts_edit_translation_state_published();
			default:
				return m.admin_posts_edit_translation_state_missing();
		}
	});

	/**
	 * Elapsed time is the only honest progress available before per-row
	 * claims land: `runningSinceSec` is the drain's clock, `queuedAgeSec` is
	 * how long nobody has claimed the row. Numbers only, so no new copy.
	 */
	const elapsedLabel = $derived.by(() => {
		if (langState !== 'queued') return null;
		const sec = job?.runningSinceSec ?? job?.queuedAgeSec ?? null;
		if (sec === null) return null;
		return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
	});

	/** "Body 7/25 parts" only matters when the document was actually split. */
	const chunkProgress = $derived(
		candidate?.chunksTotal != null && candidate.chunksTotal > 1
			? m.admin_posts_edit_translation_chunks({
					done: candidate.chunksDone ?? 0,
					total: candidate.chunksTotal
				})
			: null
	);

	/** A slot without a model/provider must not offer a Generate button. */
	const notReady = $derived(readiness !== null && readiness.status !== 'ready');

	const primary = $derived.by<FooterItem | null>(() => {
		switch (langState) {
			case 'candidate':
				return { action: 'accept', label: m.admin_posts_edit_translation_accept() };
			case 'failed':
				return { action: 'retry', label: m.admin_posts_edit_translation_retry() };
			case 'draft':
			case 'published':
				// Both states describe an existing row; without one there is
				// nothing to open, so no primary is painted at all.
				return targetId
					? { action: 'open-target', label: m.admin_posts_edit_translation_open_target() }
					: null;
			default:
				return { action: 'generate', label: m.admin_posts_edit_translation_generate() };
		}
	});

	// A generation that failed stores its reason on the candidate; the editor
	// passes it in, and a candidate-only render still has to paint it.
	const alert = $derived(candidate?.error ?? error);

	/** Generate reads the published body, so an unpublished source cannot ask. */
	const needsPublishedBody = $derived(
		!canGenerate && (langState === 'missing' || langState === 'empty')
	);

	const primaryDisabled = $derived(
		busy || langState === 'queued' || needsPublishedBody || notReady
	);
	const primaryLabel = $derived(
		busy || langState === 'queued'
			? m.admin_posts_edit_translation_generating()
			: (primary?.label ?? '')
	);

	const secondary = $derived.by<FooterItem | null>(() => {
		if (langState === 'missing' && canGenerate)
			return { action: 'copy-source', label: m.admin_posts_edit_translation_copy_source() };
		// An empty language already has a row: D5 offers the AI request and the
		// empty editor side by side.
		if ((langState === 'empty' || langState === 'candidate') && targetId)
			return { action: 'open-target', label: m.admin_posts_edit_translation_open_target() };
		// A draft is still rewritable: the operator may ask for a fresh body
		// even though the language already reads as translated.
		if (langState === 'draft' && canRetranslate)
			return { action: 'retranslate', label: m.admin_posts_edit_translation_retranslate() };
		return null;
	});

	const overflow = $derived.by<FooterItem[]>(() => {
		const items: FooterItem[] = [];
		if (langState === 'candidate')
			items.push({ action: 'retry', label: m.admin_posts_edit_translation_retry() });
		if (langState === 'candidate' || langState === 'queued' || langState === 'failed')
			items.push({ action: 'discard', label: m.admin_posts_edit_translation_discard() });
		return items;
	});

	// A candidate's own body is the drawer's rich surface. Without one the
	// source still gets a reading column, so a language is never a blank page.
	// A queued candidate exists but has no body yet - that is exactly the case
	// the old `!candidate` guard blanked out. While the model is still writing,
	// `partial` carries what it has produced so far.
	const candidateText = $derived(candidate?.content ?? candidate?.partial ?? null);
	const isStreaming = $derived(Boolean(candidateText) && !candidate?.content);
	const showPreview = $derived(Boolean(candidateText) || Boolean(source.content));

	// Overwriting is irreversible, so the retranslate request goes through a
	// confirmation that names the language it will replace.
	let retranslateOpen = $state(false);

	function runSecondary(action: DrawerAction) {
		if (action === 'retranslate') {
			retranslateOpen = true;
			return;
		}
		void onAction(action);
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content
		side="right"
		class="w-full p-0 data-[side=right]:w-full sm:max-w-2xl data-[side=right]:sm:max-w-2xl"
	>
		<div class="flex h-full flex-col">
			<Sheet.Header class="border-b border-border px-6 pt-5 pr-12 pb-4">
				<Sheet.Title class="text-sm font-semibold">
					{lang} · {stateLabel}
					{#if elapsedLabel}
						<span class="ml-2 font-mono text-xs font-normal text-muted-foreground">
							{elapsedLabel}
						</span>
					{/if}
				</Sheet.Title>
				<Sheet.Description class="text-xs text-muted-foreground">
					{m.admin_posts_edit_translation_from_source({ lang: source.lang })}
					{#if chunkProgress}
						· {chunkProgress}{/if}
				</Sheet.Description>
			</Sheet.Header>

			<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-6 py-5">
				{#if notice}
					<p class="text-xs text-muted-foreground">
						<a href={notice.href} class="underline underline-offset-2 hover:text-foreground"
							>{notice.text}</a
						>
					</p>
				{/if}

				{#if alert}
					<p role="alert" class="text-xs text-destructive">{alert}</p>
				{/if}

				{#if needsPublishedBody}
					<p class="text-xs text-muted-foreground">
						{m.admin_posts_edit_translation_publish_first()}
					</p>
				{/if}

				{#if notReady}
					<p class="text-xs text-muted-foreground">
						{m.admin_posts_edit_translation_not_ready()} ·
						<a href="/admin/settings/ai" class="underline underline-offset-2 hover:text-foreground">
							{m.admin_nav_settings()}
						</a>
					</p>
				{/if}

				{#if budget?.paused}
					<p class="text-xs text-muted-foreground">
						{m.admin_posts_edit_translation_budget_paused()}
					</p>
				{/if}

				{#if glossaryMisses?.length}
					<!-- Advisory, not an error: the candidate is usable. It tells the
					     operator either the glossary row or the generated body needs a
					     look, without forcing a retranslation. -->
					<p class="text-xs text-muted-foreground" data-testid="translation-glossary-misses">
						{m.admin_posts_edit_translation_glossary_misses()}
						{#each glossaryMisses as miss, index (miss.term)}
							{#if index > 0}<span aria-hidden="true"> · </span>{/if}
							<span class="whitespace-nowrap"
								>{miss.term} → <span class="text-destructive">{miss.expected}</span></span
							>
						{/each}
					</p>
				{/if}

				{#if showPreview}
					<div
						class="grid min-h-0 flex-1 grid-cols-1 {candidateText
							? 'divide-y md:grid-cols-2 md:divide-x md:divide-y-0'
							: 'md:grid-cols-1'} divide-border rounded-lg border border-border bg-card"
						data-testid="translation-preview"
					>
						<div class="min-h-0 overflow-y-auto p-6">
							<p class="mb-2 text-xs text-muted-foreground">
								{m.admin_posts_edit_translation_preview_source()}
							</p>
							<MarkdownRenderer
								source={source.content ?? ''}
								class="prose prose-sm max-w-[38rem]"
							/>
						</div>
						{#if candidateText}
							<div class="min-h-0 overflow-y-auto p-6">
								<p class="mb-2 text-xs text-muted-foreground">
									{isStreaming
										? m.admin_posts_edit_translation_generating()
										: m.admin_posts_edit_translation_preview_candidate()}
								</p>
								<MarkdownRenderer source={candidateText} class="prose prose-sm max-w-[38rem]" />
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<div class="flex items-center gap-2 border-t border-border px-6 py-4">
				{#if primary}
					{@const action = primary}
					<Button size="sm" disabled={primaryDisabled} onclick={() => void onAction(action.action)}>
						{primaryLabel}
					</Button>
				{/if}
				{#if secondary}
					{@const action = secondary}
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onclick={() => runSecondary(action.action)}
					>
						{secondary.label}
					</Button>
				{/if}
				{#if overflow.length > 0}
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
						<DropdownMenu.Content align="start">
							{#each overflow as item (item.action)}
								<DropdownMenu.Item disabled={busy} onclick={() => void onAction(item.action)}>
									{item.label}
								</DropdownMenu.Item>
							{/each}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}
				<a
					href="/admin/translations"
					class="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					{m.admin_posts_edit_translation_all_jobs()}
				</a>
			</div>
		</div>
	</Sheet.Content>
</Sheet.Root>

<AlertDialog.Root bind:open={retranslateOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{m.admin_posts_edit_translation_retranslate_title({ lang })}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_posts_edit_translation_retranslate_confirm({ lang })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<!--
				bits-ui's AlertDialog.Action does not close the dialog on click (only
				Cancel does), so the confirmation that answered it has to go away on
				its own - waiting for the request would leave a decided dialog open.
			-->
			<AlertDialog.Action
				onclick={() => {
					retranslateOpen = false;
					void onAction('retranslate');
				}}
			>
				{m.admin_posts_edit_translation_retranslate_action()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
