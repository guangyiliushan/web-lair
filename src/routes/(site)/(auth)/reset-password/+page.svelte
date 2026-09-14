<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageServerData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';

	let { data, form }: { data: PageServerData; form: ActionData } = $props();
</script>

<div class="flex w-full flex-col items-center justify-center">
	<Card.Root class="w-full max-w-md">
		<Card.Header class="text-center">
			<Card.Title class="text-2xl">{m.auth_reset_title()}</Card.Title>
			<Card.Description>{m.auth_reset_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if form?.message}
				<div
					class="mb-6 flex items-center gap-2 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
					role="alert"
				>
					<IconAlertCircle class="size-4 shrink-0" />
					<span>{form.message}</span>
				</div>
			{/if}

			<form method="post" action="?/reset" use:enhance>
				<input type="hidden" name="token" value={data.token} />
				<Field.FieldGroup>
					<Field.Field>
						<Field.FieldLabel for="password">{m.auth_new_password()}</Field.FieldLabel>
						<Input
							id="password"
							name="password"
							type="password"
							autocomplete="new-password"
							placeholder={m.auth_password_hint()}
							required
						/>
					</Field.Field>
					<Field.Field>
						<Field.FieldLabel for="confirmPassword">{m.auth_confirm_password()}</Field.FieldLabel>
						<Input
							id="confirmPassword"
							name="confirmPassword"
							type="password"
							autocomplete="new-password"
							required
						/>
					</Field.Field>
					<Button type="submit" class="w-full">
						<IconLock data-icon="inline-start" />
						{m.auth_reset_title()}
					</Button>
				</Field.FieldGroup>
			</form>
		</Card.Content>
		<Card.Footer class="justify-center">
			<a
				href="/login"
				class="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:underline"
			>
				<IconArrowLeft class="size-4" />
				{m.auth_back_to_login()}
			</a>
		</Card.Footer>
	</Card.Root>
</div>
