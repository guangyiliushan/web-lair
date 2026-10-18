<script lang="ts">
	import { enhance } from '$app/forms';
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

	// One inline surface at a time, keyed by the comment it belongs to:
	// reply composer, edit composer, delete confirmation (P4 self-service).
	let openReplyId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let confirmingDeleteId = $state<string | null>(null);
	let deleteBusy = $state(false);

	function toggleReply(id: string) {
		openReplyId = openReplyId === id ? null : id;
		editingId = null;
		confirmingDeleteId = null;
	}

	async function startEdit(id: string) {
		if (editingId === id) {
			// Same toggle shape as the delete trigger (pre-release review
			// 07-P3-4).
			await cancelEdit(id);
			return;
		}
		editingId = id;
		openReplyId = null;
		confirmingDeleteId = null;
	}

	async function startDelete(id: string) {
		if (confirmingDeleteId === id) {
			await cancelDelete(id);
			return;
		}
		confirmingDeleteId = id;
		editingId = null;
		openReplyId = null;
		// Announce the confirmation: focus its question text (tabindex -1)
		// so SR users hear it without hunting (review P2-1).
		await tick();
		document.querySelector<HTMLElement>(`[data-delete-confirm-text="${id}"]`)?.focus();
	}

	/** Close an inline surface and hand focus back to its trigger (WCAG). */
	async function closeReply(id: string) {
		openReplyId = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-reply-target="${id}"]`)?.focus();
	}

	async function cancelEdit(id: string) {
		editingId = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-edit-target="${id}"]`)?.focus();
	}

	async function cancelDelete(id: string) {
		confirmingDeleteId = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-delete-target="${id}"]`)?.focus();
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

{#snippet editedMark(editedAt: Date | null)}
	{#if editedAt}
		<time
			class="text-xs text-muted-foreground"
			datetime={editedAt.toISOString()}
			title={formatDateTime(editedAt)}
		>
			{m.comment_edited()}
		</time>
	{/if}
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
					class="wl-accent-link underline underline-offset-2 hover:decoration-primary"
					href={segment.href}
					target="_blank"
					rel="nofollow ugc noopener noreferrer">{segment.text}</a
				>{:else}{segment.text}{/if}{/each}</span
	>
{/snippet}

{#snippet itemActions(
	id: string,
	text: string,
	author: string | null,
	isPending: boolean,
	isMine: boolean
)}
	{#if canComment}
		<div class="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1">
			{#if !isPending}
				<Button
					variant="ghost"
					size="sm"
					data-reply-target={id}
					aria-expanded={openReplyId === id}
					aria-label={m.comment_reply_action({ name: author ?? '?' })}
					onclick={() => toggleReply(id)}
				>
					{m.comment_reply()}
				</Button>
			{/if}
			{#if isMine}
				<Button
					variant="ghost"
					size="sm"
					data-edit-target={id}
					aria-expanded={editingId === id}
					aria-label={m.comment_edit_aria({ name: author ?? '?' })}
					onclick={() => startEdit(id)}
				>
					{m.comment_edit()}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					data-delete-target={id}
					aria-expanded={confirmingDeleteId === id}
					aria-label={m.comment_delete_aria({ name: author ?? '?' })}
					onclick={() => startDelete(id)}
				>
					{m.comment_delete()}
				</Button>
			{/if}
		</div>
		{#if editingId === id}
			<div class="mt-2">
				<CommentComposer
					action="?/edit"
					commentId={id}
					initialText={text}
					submitLabel={m.comment_edit_save()}
					hint={m.comment_edit_hint()}
					compact
					autofocus
					onCancel={() => cancelEdit(id)}
				/>
			</div>
		{/if}
		{#if openReplyId === id}
			<CommentComposer
				action="?/reply"
				parentId={id}
				compact
				autofocus
				onCancel={() => closeReply(id)}
			/>
		{/if}
	{/if}
	{#if confirmingDeleteId === id}
		<!-- Neutral fill: the former destructive tint stacked under the button's
		     own /10 fill and measured 3.67:1 in light mode - below AA (pre-release
		     review 07-P2-3; the token-level fix is tracked separately). -->
		<form
			method="POST"
			action="?/delete"
			class="mt-2 rounded-md border border-destructive/30 bg-card px-3 py-2"
			data-slot="comment-delete-confirm"
			aria-busy={deleteBusy}
			use:enhance={() => {
				deleteBusy = true;
				return async ({ result, update }) => {
					try {
						// An error result would route the page to the error boundary
						// and take the inline confirm with it.
						if (result.type === 'error') return;
						await update();
					} finally {
						deleteBusy = false;
					}
					if (result.type === 'success' && confirmingDeleteId === id) {
						// Park focus on the section title so keyboard users keep
						// their place. Guarded to THIS surface: a user who moved
						// to another composer while the request flew must not have
						// that surface closed or its focus stolen (pre-release
						// review 07-P2-1, the admin/delete-confirm shape).
						confirmingDeleteId = null;
						document.getElementById('comments-title')?.focus();
					}
				};
			}}
		>
			<input type="hidden" name="id" value={id} />
			<p
				id={`comment-delete-question-${id}`}
				class="text-sm"
				tabindex="-1"
				data-delete-confirm-text={id}
			>
				{m.comment_delete_confirm()}
			</p>
			<div class="mt-2 flex items-center justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={deleteBusy}
					onclick={() => cancelDelete(id)}
				>
					{m.comment_cancel()}
				</Button>
				<Button
					type="submit"
					variant="destructive"
					size="sm"
					aria-describedby={`comment-delete-question-${id}`}
					disabled={deleteBusy}
				>
					{m.comment_delete_confirm_action()}
				</Button>
			</div>
		</form>
	{/if}
{/snippet}

<li
	class="border-b border-border/40 py-5 last:border-b-0"
	data-comment-id={root.id}
	data-slot="comment-item"
>
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
					{@render editedMark(root.editedAt)}
				</div>
				<div class="mt-1.5 text-sm leading-relaxed break-words">
					{@render commentBody(root.text)}
				</div>
				{#if root.anchor}
					<!-- Segment-anchor chip (P3b): the quoted text plus the deep link
					     back to the marked passage. Orphaned anchors have no target. -->
					<div
						class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
						data-slot="comment-anchor"
					>
						<!-- `text-foreground/80` (≈11:1) instead of the muted token:
						     12px muted on the chip fill measured 4.33:1 (WCAG 1.4.3). -->
						<span class="max-w-full truncate rounded bg-muted/60 px-2 py-0.5 text-foreground/80">
							“{root.anchor.quote}”
						</span>
						{#if root.anchor.orphaned}
							<Badge variant="secondary">{m.comment_orphan_title()}</Badge>
						{:else if root.anchor.targetId}
							<a
								class="wl-accent-link rounded-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
								href={`#${root.anchor.targetId}`}>{m.comment_jump_to_source()}</a
							>
						{/if}
					</div>
				{/if}
				{@render itemActions(root.id, root.text, root.author, root.isPending, root.isMine)}
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
								{@render editedMark(reply.editedAt)}
							</div>
							<div class="mt-1.5 text-sm leading-relaxed break-words">
								{@render commentBody(reply.text)}
							</div>
							{@render itemActions(
								reply.id,
								reply.text,
								reply.author,
								reply.isPending,
								reply.isMine
							)}
						</div>
					</article>
				</li>
			{/each}
		</ul>
	{/if}
</li>
