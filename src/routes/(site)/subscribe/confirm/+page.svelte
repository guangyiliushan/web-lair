<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { m } from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const state = $derived(form?.result ?? data.status);
</script>

<div class="flex w-full flex-col items-center py-12">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<h1 data-slot="card-title" class="text-base leading-snug font-medium">
				{m.subscribe_confirm_title()}
			</h1>
		</Card.Header>
		<Card.Content class="grid gap-4">
			{#if state === 'subscribed'}
				<p class="text-sm" role="status">{m.subscribe_confirm_done()}</p>
			{:else if state === 'already-subscribed'}
				<p class="text-sm" role="status">{m.subscribe_confirm_already()}</p>
			{:else if state === 'unsubscribed'}
				<p class="text-sm" role="status">{m.subscribe_confirm_unsubscribed()}</p>
				<a class="text-sm underline underline-offset-2" href={localizeHref('/subscribe')}>
					{m.subscribe_title()}
				</a>
			{:else if state === 'invalid'}
				<p class="text-sm text-destructive" role="alert">{m.subscribe_confirm_invalid()}</p>
			{:else}
				<p class="text-sm">{m.subscribe_confirm_body({ email: data.email ?? '' })}</p>
				<form method="POST">
					<input type="hidden" name="token" value={data.token} />
					<Button type="submit">{m.subscribe_confirm_button()}</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
