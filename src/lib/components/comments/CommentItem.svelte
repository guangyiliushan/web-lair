<script lang="ts">
	import { tick } from 'svelte';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import * as Avatar from '$lib/components/ui/avatar';
	import { Badge } from '$lib/components/ui/badge';
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

	/** Close the inline composer and hand focus back to its trigger (WCAG). */
	async function closeReply(id: string) {
		openReplyId = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-reply-target="${id}"]`)?.focus();
	}

	function initialOf(name: string | null): string {
		return (name ?? '?').slice(0, 1).toUpperCase();
	}
</script>

{#snippet avatar(url: string | null, name: string | null)}
	<Avatar.Root class="size-8">
		{#if url}
			<Avatar.Image src={url} alt="" loading="lazy" referrerpolicy="no-referrer" />
		{/if}
		<Avatar.Fallback>{initialOf(name)}</Avatar.Fallback>
	</Avatar.Root>
{/snippet}

{#snippet ownerBadge()}
	<Badge variant="outline" class="border-primary/40 text-primary">
		{m.comment_owner_badge()}
	</Badge>
{/snippet}

{#snippet pendingBadge()}
	<Badge variant="secondary">{m.comment_pending_badge()}</Badge>
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
						<Badge variant="secondary" class="gap-0.5">
							<IconPin aria-hidden="true" />
							{m.comment_pin_badge()}
						</Badge>
					{/if}
					{@render commentTime(root.createdAt)}
					{#if root.isPending}{@render pendingBadge()}{/if}
				</div>
				<div class="mt-1.5 text-sm leading-relaxed break-words">
					{@render commentBody(root.text)}
				</div>
				{#if canComment && !root.isPending}
					<div class="mt-1.5">
						<Button
							variant="ghost"
							size="sm"
							data-reply-target={root.id}
							aria-expanded={openReplyId === root.id}
							aria-label={m.comment_replying_to({ name: root.author ?? '?' })}
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
						autofocus
						onCancel={() => closeReply(root.id)}
					/>
				{/if}
			</div>
		</article>
	{/if}

	{#if root.replies.length > 0}
		<ul class="mt-3 ml-4 flex flex-col gap-4 border-l border-border/40 pl-4 sm:ml-6">
			{#each root.replies as reply (reply.id)}
				<li data-comment-id={reply.id}>
					<article class="flex gap-3">
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
							{#if canComment && !reply.isPending}
								<div class="mt-1.5">
									<Button
										variant="ghost"
										size="sm"
										data-reply-target={reply.id}
										aria-expanded={openReplyId === reply.id}
										aria-label={m.comment_replying_to({ name: reply.author ?? '?' })}
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
									autofocus
									onCancel={() => closeReply(reply.id)}
								/>
							{/if}
						</div>
					</article>
				</li>
			{/each}
		</ul>
	{/if}
</li>
