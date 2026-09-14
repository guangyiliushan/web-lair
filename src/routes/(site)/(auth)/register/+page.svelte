<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';

	let { form }: { form: ActionData } = $props();
</script>

<div class="flex w-full flex-col items-center justify-center">
	<Card.Root class="w-full max-w-md">
		<Card.Header class="text-center">
			<Card.Title class="text-2xl">{m.auth_register_title()}</Card.Title>
			<Card.Description>{m.auth_register_description()}</Card.Description>
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

			<form method="post" action="?/signUp" use:enhance>
				<Field.FieldGroup>
					<Field.Field>
						<Field.FieldLabel for="name">{m.auth_name()}</Field.FieldLabel>
						<Input
							id="name"
							name="name"
							type="text"
							autocomplete="name"
							placeholder={m.auth_name_placeholder()}
							required
						/>
					</Field.Field>
					<Field.Field>
						<Field.FieldLabel for="email">{m.auth_email()}</Field.FieldLabel>
						<Input
							id="email"
							name="email"
							type="email"
							autocomplete="email"
							placeholder={m.auth_email_placeholder()}
							required
						/>
					</Field.Field>
					<Field.Field>
						<Field.FieldLabel for="password">{m.auth_password()}</Field.FieldLabel>
						<Input
							id="password"
							name="password"
							type="password"
							autocomplete="new-password"
							placeholder={m.auth_password_hint()}
							required
						/>
						<Field.FieldDescription>{m.auth_password_hint()}</Field.FieldDescription>
					</Field.Field>
					<Field.Field>
						<Field.FieldLabel for="confirmPassword">{m.auth_confirm_password()}</Field.FieldLabel>
						<Input
							id="confirmPassword"
							name="confirmPassword"
							type="password"
							autocomplete="new-password"
							placeholder={m.auth_confirm_placeholder()}
							required
						/>
					</Field.Field>
					<Button type="submit" class="w-full">
						<IconMail data-icon="inline-start" />
						{m.auth_create_account()}
					</Button>
				</Field.FieldGroup>
			</form>
		</Card.Content>
		<Card.Footer class="justify-center">
			<p class="text-sm text-muted-foreground">
				{m.auth_have_account()}
				<a href="/login" class="font-medium underline-offset-2 hover:underline"> {m.nav_sign_in()} </a>
			</p>
		</Card.Footer>
	</Card.Root>
</div>
