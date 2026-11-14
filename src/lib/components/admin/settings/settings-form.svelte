<script lang="ts">
	import type { Snippet } from 'svelte';
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';

	let {
		action,
		dirty,
		message,
		error = false,
		onCancel,
		children
	}: {
		action: string;
		dirty: boolean;
		message?: string | null;
		error?: boolean;
		onCancel?: () => void;
		children: Snippet;
	} = $props();

	let pending = $state(false);

	// In-app navigation: ask before dropping a dirty form. `beforeNavigate`
	// only runs in the browser, so the SSR path never touches `window`.
	beforeNavigate((navigation) => {
		if (!dirty || !navigation.to || typeof window === 'undefined') return;
		if (!window.confirm(m.admin_settings_unsaved_leave())) navigation.cancel();
	});

	// Tab close / reload: the browser's own guard. The listener is removed
	// as soon as the form is clean.
	$effect(() => {
		if (!dirty || typeof window === 'undefined') return;
		const handler = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	});
</script>

<form
	method="POST"
	{action}
	use:enhance={() => {
		pending = true;
		return async ({ update }) => {
			await update();
			pending = false;
		};
	}}
>
	{@render children()}
	{#if message}
		<p
			class="mt-3 text-sm {error ? 'text-destructive' : 'text-muted-foreground'}"
			role={error ? 'alert' : 'status'}
		>
			{message}
		</p>
	{/if}
	<div class="mt-4 flex items-center justify-end gap-2 border-t pt-4">
		{#if dirty}
			<span class="mr-auto text-xs text-muted-foreground">{m.admin_settings_unsaved()}</span>
		{/if}
		<Button type="button" variant="ghost" size="sm" disabled={!dirty || pending} onclick={onCancel}>
			{m.admin_common_cancel()}
		</Button>
		<Button type="submit" size="sm" disabled={!dirty || pending}>
			{m.admin_common_save()}
		</Button>
	</div>
</form>
