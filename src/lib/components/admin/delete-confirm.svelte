<script lang="ts">
	import { enhance } from '$app/forms';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		/** Open state; the parent owns the target row (null = closed). */
		open: boolean;
		title: string;
		description: string;
		/** Row id submitted as `?/delete`. */
		id: string;
		/** Action failure text rendered inside the dialog (a page banner hides behind the overlay). */
		error?: string | null;
		/** Called when the dialog closes (cancel/Escape/success). */
		onclose: () => void;
	}

	let { open, title, description, id, error, onclose }: Props = $props();

	// Double-submit guard (C3 review): kit does not merge submissions, so a
	// replayed delete would answer 404 and surface a misleading error.
	let submitting = $state(false);
</script>

<AlertDialog.Root
	{open}
	onOpenChange={(next) => {
		if (!next) onclose();
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{description}</AlertDialog.Description>
		</AlertDialog.Header>
		{#if error}
			<p role="alert" class="px-6 text-sm text-destructive">{error}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>取消</AlertDialog.Cancel>
			<form
				method="post"
				action="?/delete"
				use:enhance={() => {
					submitting = true;
					return async ({ result, update }) => {
						submitting = false;
						if (result.type === 'success') onclose();
						await update();
					};
				}}
			>
				<input type="hidden" name="id" value={id} />
				<Button type="submit" variant="destructive" disabled={submitting}>删除</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
