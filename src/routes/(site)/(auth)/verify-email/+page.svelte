<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import IconMailForward from '@tabler/icons-svelte-runes/icons/mail-forward';
	import { m } from '$lib/paraglide/messages';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<div class="flex w-full flex-col items-center justify-center">
	<Card.Root class="w-full max-w-md text-center">
		<Card.Header>
			<h1 data-slot="card-title" class="text-2xl leading-snug font-medium">
				{m.auth_verify_title()}
			</h1>
			<Card.Description>
				{m.auth_verify_description()}
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col items-center gap-4">
			<IconMailForward class="size-12 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">
				{m.auth_verify_spam_hint()}
			</p>
			{#if form?.message}
				<p class="text-sm text-destructive" role="alert">{form.message}</p>
			{/if}
			{#if form?.sent}
				<p class="text-sm" role="status">{m.auth_verify_resent()}</p>
			{/if}
			<form method="POST" action="?/resend" class="flex w-full gap-2">
				<input
					type="email"
					name="email"
					required
					autocomplete="email"
					placeholder={m.auth_email_placeholder()}
					class="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
				/>
				<Button type="submit" variant="outline">{m.auth_verify_resend()}</Button>
			</form>
		</Card.Content>
		<Card.Footer class="justify-center">
			<a href="/login">
				<Button variant="outline">{m.auth_back_to_login()}</Button>
			</a>
		</Card.Footer>
	</Card.Root>
</div>
