<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { m } from '$lib/paraglide/messages';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const state = $derived(form?.result ?? data.status);
</script>

<div class="flex w-full flex-col items-center py-12">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<h1 data-slot="card-title" class="text-base leading-snug font-medium">
				{m.unsubscribe_title()}
			</h1>
		</Card.Header>
		<Card.Content class="grid gap-4">
			{#if state === 'unsubscribed'}
				<p class="text-sm" role="status">{m.unsubscribe_done()}</p>
			{:else if state === 'already-unsubscribed'}
				<p class="text-sm" role="status">{m.unsubscribe_already()}</p>
			{:else if state === 'invalid'}
				<p class="text-sm text-destructive" role="alert">{m.unsubscribe_invalid()}</p>
			{:else}
				<p class="text-sm">{m.unsubscribe_body({ email: data.email ?? '' })}</p>
				<form method="POST">
					<input type="hidden" name="token" value={data.token} />
					<Button type="submit" variant="destructive">{m.unsubscribe_button()}</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
