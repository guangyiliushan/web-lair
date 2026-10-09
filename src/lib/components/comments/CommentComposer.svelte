<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { m } from '$lib/paraglide/messages';
	import { COMMENT_MAX_LENGTH } from './types';

	interface Props {
		/** Form action to post to: '?/comment', '?/reply' or '?/edit'. */
		action: string;
		/** Reply target id; omitted for a root comment. */
		parentId?: string | null;
		/** Comment id for the edit mode (posts the row identity). */
		commentId?: string | null;
		/** Prefilled text (edit mode); the textarea stays uncontrolled. */
		initialText?: string;
		/** Override for the submit button label (edit mode: 保存). */
		submitLabel?: string;
		/** Optional hint under the textarea (edit mode: re-review notice). */
		hint?: string;
		/** Denser layout for inline reply/edit forms. */
		compact?: boolean;
		/** Focus the textarea on mount (inline replies opened by a click). */
		autofocus?: boolean;
		/** Present when the composer can be dismissed (inline reply/edit). */
		onCancel?: () => void;
	}

	let {
		action,
		parentId = null,
		commentId = null,
		initialText = '',
		submitLabel,
		hint,
		compact = false,
		autofocus = false,
		onCancel
	}: Props = $props();
	let submitting = $state(false);
</script>

<form
	method="POST"
	{action}
	class="flex flex-col gap-2"
	aria-busy={submitting}
	data-slot="comment-composer"
	use:enhance={() => {
		submitting = true;
		return async ({ result, update }) => {
			if (result.type === 'failure') {
				// Keep the typed text visible so the author can fix it.
				await update({ reset: false });
			} else {
				await update();
				if (result.type === 'success') onCancel?.();
			}
			submitting = false;
		};
	}}
>
	{#if parentId}
		<input type="hidden" name="parentId" value={parentId} />
	{/if}
	{#if commentId}
		<input type="hidden" name="id" value={commentId} />
	{/if}
	<Textarea
		name="text"
		required
		maxlength={COMMENT_MAX_LENGTH}
		rows={compact ? 2 : 3}
		value={initialText}
		{autofocus}
		placeholder={m.comment_composer_placeholder()}
		aria-label={m.comment_composer_label()}
	/>
	{#if hint}
		<p class="text-xs text-muted-foreground">{hint}</p>
	{/if}
	<div class="flex items-center justify-end gap-2">
		{#if onCancel}
			<Button type="button" variant="ghost" size="sm" onclick={onCancel}>
				{m.comment_cancel()}
			</Button>
		{/if}
		<Button type="submit" size="sm" disabled={submitting}
			>{submitLabel ?? m.comment_submit()}</Button
		>
	</div>
</form>
