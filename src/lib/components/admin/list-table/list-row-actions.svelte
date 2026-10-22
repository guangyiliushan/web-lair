<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Pathname } from '$app/types';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';
	import type { Snippet } from 'svelte';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconArrowBackUp from '@tabler/icons-svelte-runes/icons/arrow-back-up';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';

	/**
	 * Row actions, in the order the list pages all use them: the common action
	 * first, the destructive one in the middle, everything else folded into the
	 * overflow menu. Every slot is optional — a list with no destructive action
	 * simply omits it, and a list whose primary action is not "edit" supplies
	 * `primary` instead (the files list shows a download button).
	 */
	interface Props {
		/** First-slot control. Takes precedence over the built-in edit button. */
		primary?: Snippet;
		/** Edit target; omit `editId` and pass `onEdit` for dialog editors. */
		editPath?: Pathname;
		editId?: string;
		onEdit?: () => void;
		editLabel?: string;
		/**
		 * Middle slot. On the default view of a content list that is the
		 * destructive one (move to trash on posts/notes, permanent delete on
		 * moments); a row already in the trash passes `deleteIcon="restore"` so
		 * the button is never a no-op. The page owns the row + confirm dialog.
		 */
		onDelete?: () => void;
		deleteLabel?: string;
		deleteIcon?: 'trash' | 'restore';
		/** Secondary actions folded into the overflow menu. */
		more?: Snippet;
		moreLabel?: string;
	}

	let {
		primary,
		editPath,
		editId,
		onEdit,
		editLabel,
		onDelete,
		deleteLabel,
		deleteIcon = 'trash',
		more,
		moreLabel = m.admin_list_more()
	}: Props = $props();

	const editHref = $derived(
		editPath ? `${resolve(editPath)}${editId ? `?id=${editId}` : ''}` : undefined
	);
</script>

<div class="flex items-center justify-end gap-0.5">
	{#if primary}
		{@render primary()}
	{:else if editLabel && editHref}
		<Button variant="ghost" size="icon-sm" href={editHref} aria-label={editLabel} title={editLabel}>
			<IconPencil />
		</Button>
	{:else if editLabel && onEdit}
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={onEdit}
			aria-label={editLabel}
			title={editLabel}
		>
			<IconPencil />
		</Button>
	{/if}
	{#if onDelete && deleteLabel}
		<Button
			variant="ghost"
			size="icon-sm"
			onclick={onDelete}
			aria-label={deleteLabel}
			title={deleteLabel}
			class={cn(
				deleteIcon === 'trash' && 'text-destructive hover:bg-destructive/10 hover:text-destructive'
			)}
		>
			{#if deleteIcon === 'restore'}<IconArrowBackUp />{:else}<IconTrash />{/if}
		</Button>
	{/if}
	{#if more}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						variant="ghost"
						size="icon-sm"
						{...props}
						aria-label={moreLabel}
						title={moreLabel}
					>
						<IconDots />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					{@render more()}
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}
</div>
