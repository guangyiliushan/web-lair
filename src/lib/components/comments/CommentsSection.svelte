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
</script>

<section
	id="comments"
	class="mt-16 border-t border-border/40 pt-8"
	aria-labelledby="comments-title"
	data-comment-target={targetType}
>
	<h2 id="comments-title" class="text-lg font-medium">
		{m.comment_title()}
		<span class="text-muted-foreground">({threads.visibleCount})</span>
	</h2>

	{#if form?.submitted}
		<p class="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">
			{form.submitted === 'approved'
				? m.comment_submitted_approved()
				: m.comment_submitted_pending()}
		</p>
	{/if}
	{#if form?.message}
		<p class="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
			{form.message}
		</p>
	{/if}

	<div class="mt-6">
		{#if canComment}
			<CommentComposer action="?/comment" />
		{:else if loginUrl}
			<p class="text-sm text-muted-foreground">
				{m.comment_login_prompt()}
				<a class="text-primary underline underline-offset-2" href={loginUrl}>
					{m.comment_login_action()}
				</a>
			</p>
		{:else if !emailVerified}
			<p class="text-sm text-muted-foreground">{m.comment_verify_hint()}</p>
		{/if}
	</div>

	{#if threads.roots.length === 0}
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
</section>
