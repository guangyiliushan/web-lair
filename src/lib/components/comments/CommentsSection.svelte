<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import CommentComposer from './CommentComposer.svelte';
	import CommentItem from './CommentItem.svelte';
	import type { CommentFormState, CommentTargetType, ThreadsPage } from './types';

	interface Props {
		/** Exclusive-arc target kind (frozen API for the notes/pages mounts). */
		targetType: CommentTargetType;
		/** Assembled threads from `services/comments.ts#loadThreads`. */
		threads: ThreadsPage;
		/** Viewer may submit right now (signed in + verified + thread open). */
		canComment: boolean;
		/** Signed-in viewer's email verification state (hint when false). */
		emailVerified: boolean;
		/** Login link for guests; null once signed in. */
		loginUrl: string | null;
		/** Latest form action result (page form), when present. */
		form?: CommentFormState | null;
	}

	let { targetType, threads, canComment, emailVerified, loginUrl, form = null }: Props = $props();

	// P3b view-model compat: `orphans`/`orphanCount` are optional so producers
	// from before segment anchors keep rendering (derive instead of crashing).
	const orphans = $derived(threads.orphans ?? []);
	const orphanCount = $derived(threads.orphanCount ?? orphans.length);

	// A failed submission/action renders one section-level alert; pull focus
	// to it so a reader deep in the thread is not left guessing (review P2-3).
	let messageEl = $state<HTMLElement | null>(null);
	$effect(() => {
		// The segment panel renders the same message and owns focus while open;
		// stealing it here would scroll the reader away from their composer.
		if (form?.message && !document.querySelector('[data-slot="comment-selection-panel"]')) {
			messageEl?.focus();
		}
	});
</script>

<section
	id="comments"
	class="mt-16 border-t border-border/40 pt-8"
	aria-labelledby="comments-title"
	data-comment-target={targetType}
	data-slot="comments-section"
>
	<h2 id="comments-title" tabindex="-1" class="text-lg font-medium">
		{m.comment_title()}
		<span class="text-muted-foreground">({threads.visibleCount})</span>
		{#if orphanCount > 0}
			<!-- Orphaned threads are visible, never silently hidden (spec §8):
			     the count sits next to the main one, the threads in the fold below. -->
			<span class="ml-2 text-xs text-muted-foreground" data-slot="comment-orphan-count">
				{m.comment_orphan_count({ count: orphanCount })}
			</span>
		{/if}
	</h2>

	{#if form?.submitted}
		<p class="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">
			{form.submitted === 'approved'
				? m.comment_submitted_approved()
				: m.comment_submitted_pending()}
		</p>
	{/if}
	{#if form?.deleted}
		<p class="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">
			{m.comment_deleted()}
		</p>
	{/if}
	{#if form?.message}
		<p
			bind:this={messageEl}
			class="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
			role="alert"
			tabindex="-1"
		>
			{form.message}
		</p>
	{/if}

	<div class="mt-6">
		{#if canComment}
			<CommentComposer action="?/comment" />
		{:else if loginUrl}
			<p class="text-sm text-muted-foreground">
				{m.comment_login_prompt()}
				<a class="wl-accent-link underline underline-offset-2" href={loginUrl}>
					{m.comment_login_action()}
				</a>
			</p>
		{:else if !emailVerified}
			<p class="text-sm text-muted-foreground">{m.comment_verify_hint()}</p>
		{/if}
	</div>

	{#if threads.roots.length === 0 && orphans.length === 0}
		<p class="mt-6 text-sm text-muted-foreground">{m.comment_empty()}</p>
	{:else}
		<ul class="mt-2">
			{#each threads.roots as root (root.id)}
				<CommentItem {root} {canComment} />
			{/each}
		</ul>
	{/if}

	{#if threads.truncated}
		<p class="mt-4 text-xs text-muted-foreground">{m.comment_truncated()}</p>
	{/if}

	{#if orphans.length > 0}
		<!-- Folded "original text changed" area (spec §7): quote-first, own count,
		     never part of the main list numbering. -->
		<details class="mt-6 rounded-md border border-border/50 px-3 py-2" data-slot="comment-orphans">
			<summary
				class="cursor-pointer rounded-sm text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				{m.comment_orphan_title()} ({orphanCount})
			</summary>
			<p class="mt-2 text-xs text-muted-foreground">{m.comment_orphan_hint()}</p>
			<ul class="mt-2">
				{#each orphans as root (root.id)}
					<CommentItem {root} {canComment} />
				{/each}
			</ul>
		</details>
	{/if}
</section>
