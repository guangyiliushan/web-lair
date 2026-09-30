<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** Form action to post to: '?/comment' (root) or '?/reply'. */
		action: string;
		/** Reply target id; omitted for a root comment. */
		parentId?: string | null;
		/** Denser layout for inline reply forms. */
		compact?: boolean;
		/** Present when the composer can be dismissed (inline reply). */
		onCancel?: () => void;
	}

	let { action, parentId = null, compact = false, onCancel }: Props = $props();
	let submitting = $state(false);
</script>

<form
	method="POST"
	{action}
	class="flex flex-col gap-2"
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
	<Textarea
		name="text"
		required
		maxlength={2000}
		rows={compact ? 2 : 3}
		placeholder={m.comment_composer_placeholder()}
		aria-label={m.comment_composer_placeholder()}
	/>
	<div class="flex items-center justify-end gap-2">
		{#if onCancel}
			<Button type="button" variant="ghost" size="sm" onclick={onCancel}>
				{m.comment_cancel()}
			</Button>
		{/if}
		<Button type="submit" size="sm" disabled={submitting}>{m.comment_submit()}</Button>
	</div>
</form>
