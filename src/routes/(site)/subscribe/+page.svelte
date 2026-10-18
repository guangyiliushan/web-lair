<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { m } from '$lib/paraglide/messages';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<div class="flex w-full flex-col items-center py-12">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<h1 data-slot="card-title" class="text-base leading-snug font-medium">
				{m.subscribe_title()}
			</h1>
			<Card.Description>{m.subscribe_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if form?.success}
				<p class="text-sm" role="status">{m.subscribe_success()}</p>
			{:else}
				{#if form?.message}
					<p class="mb-4 text-sm text-destructive" role="alert">{form.message}</p>
				{/if}
				<form method="POST" class="grid gap-4">
					<Field.Field>
						<Field.FieldLabel for="subscribe-email">{m.subscribe_email_label()}</Field.FieldLabel>
						<Input id="subscribe-email" name="email" type="email" autocomplete="email" required />
					</Field.Field>
					<div class="hidden" aria-hidden="true">
						<label for="subscribe-website">Website</label>
						<input
							id="subscribe-website"
							name="website"
							type="text"
							tabindex="-1"
							autocomplete="off"
						/>
					</div>
					<Button type="submit">{m.subscribe_submit()}</Button>
				</form>
			{/if}
			<p class="mt-6 text-xs text-muted-foreground">{m.subscribe_privacy()}</p>
		</Card.Content>
	</Card.Root>
</div>
