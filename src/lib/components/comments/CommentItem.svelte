<script lang="ts">
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import { Button } from '$lib/components/ui/button';
	import { m } from '$lib/paraglide/messages';
	import { parseCommentText } from '$lib/utils/comment-text';
	import { formatDateTime, formatRelativeTime } from '$lib/utils/i18n';
	import CommentComposer from './CommentComposer.svelte';
	import type { ThreadRoot } from './types';

	interface Props {
		root: ThreadRoot;
		/** Viewer may submit right now (signed in + verified + thread open). */
		canComment: boolean;
	}

	let { root, canComment }: Props = $props();

	// One inline reply composer at a time, keyed by the comment being replied to.
	let openReplyId = $state<string | null>(null);

	function toggleReply(id: string) {
		openReplyId = openReplyId === id ? null : id;
	}
</script>

{#snippet avatar(url: string | null, name: string | null)}
	{#if url}
		<img src={url} alt="" class="size-8 shrink-0 rounded-full object-cover" loading="lazy" />
	{:else}
		<span
			aria-hidden="true"
			class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
		>
			{(name ?? '?').slice(0, 1).toUpperCase()}
		</span>
	{/if}
{/snippet}

{#snippet ownerBadge()}
	<span class="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
		{m.comment_owner_badge()}
	</span>
{/snippet}

{#snippet pendingBadge()}
	<span class="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
		{m.comment_pending_badge()}
	</span>
{/snippet}

{#snippet commentTime(value: Date)}
	<time
		class="text-xs text-muted-foreground"
		datetime={value.toISOString()}
		title={formatDateTime(value)}
	>
		{formatRelativeTime(value)}
	</time>
{/snippet}

{#snippet commentBody(text: string)}
	<span class="whitespace-pre-wrap" data-comment-body
		>{#each parseCommentText(text) as segment, i (i)}{#if segment.type === 'link'}<a
					class="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
					href={segment.href}
					target="_blank"
					rel="nofollow ugc noopener noreferrer">{segment.text}</a
				>{:else}{segment.text}{/if}{/each}</span
	>
{/snippet}

<li class="border-b border-border/40 py-5 last:border-b-0" data-comment-id={root.id}>
	{#if root.isDeleted}
		<p class="text-sm text-muted-foreground italic">{m.comment_deleted()}</p>
	{:else}
		<article class="flex gap-3">
			{@render avatar(root.avatar, root.author)}
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span class="text-sm font-medium">{root.author ?? '?'}</span>
					{#if root.isOwner}{@render ownerBadge()}{/if}
					{#if root.pin}
						<span class="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
							<IconPin class="size-3" />
							{m.comment_pin_badge()}
						</span>
					{/if}
					{@render commentTime(root.createdAt)}
					{#if root.isPending}{@render pendingBadge()}{/if}
				</div>
				<div class="mt-1.5 text-sm leading-relaxed break-words">
					{@render commentBody(root.text)}
				</div>
				{#if canComment}
					<div class="mt-1.5">
						<Button
							variant="ghost"
							size="sm"
							data-reply-target={root.id}
							onclick={() => toggleReply(root.id)}
						>
							{m.comment_reply()}
						</Button>
					</div>
				{/if}
				{#if openReplyId === root.id}
					<CommentComposer
						action="?/reply"
						parentId={root.id}
						compact
						onCancel={() => (openReplyId = null)}
					/>
				{/if}
			</div>
		</article>
	{/if}

	{#if root.replies.length > 0}
		<ul class="mt-3 ml-4 space-y-4 border-l border-border/40 pl-4 sm:ml-6">
			{#each root.replies as reply (reply.id)}
				<li data-comment-id={reply.id}>
					<div class="flex gap-3">
						{@render avatar(reply.avatar, reply.author)}
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<span class="text-sm font-medium">{reply.author ?? '?'}</span>
								{#if reply.isOwner}{@render ownerBadge()}{/if}
								{#if reply.replyToAuthor}
									<span class="text-xs text-muted-foreground">
										{m.comment_replying_to({ name: reply.replyToAuthor })}
									</span>
								{/if}
								{@render commentTime(reply.createdAt)}
								{#if reply.isPending}{@render pendingBadge()}{/if}
							</div>
							<div class="mt-1.5 text-sm leading-relaxed break-words">
								{@render commentBody(reply.text)}
							</div>
							{#if canComment}
								<div class="mt-1.5">
									<Button
										variant="ghost"
										size="sm"
										data-reply-target={reply.id}
										onclick={() => toggleReply(reply.id)}
									>
										{m.comment_reply()}
									</Button>
								</div>
							{/if}
							{#if openReplyId === reply.id}
								<CommentComposer
									action="?/reply"
									parentId={reply.id}
									compact
									onCancel={() => (openReplyId = null)}
								/>
							{/if}
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</li>
