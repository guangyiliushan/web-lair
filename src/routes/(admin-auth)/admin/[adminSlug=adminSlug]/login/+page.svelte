<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import IconShieldLock from '@tabler/icons-svelte-runes/icons/shield-lock';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Secure Admin Login</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4 py-12">
	<Card.Root class="w-full max-w-md">
		<Card.Header class="text-center">
			<div
				class="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
			>
				<IconShieldLock class="size-6" />
			</div>
			<Card.Title class="text-2xl">{m.auth_admin_title()}</Card.Title>
			<Card.Description>
				{m.auth_admin_description()}
			</Card.Description>
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

			<form method="post" action="?/signIn" use:enhance>
				<input type="hidden" name="redirectTo" value={form?.redirectTo ?? data.redirectTo} />

				<Field.FieldGroup>
					<Field.Field>
						<Field.FieldLabel for="email">{m.auth_admin_email()}</Field.FieldLabel>
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
							autocomplete="current-password"
							placeholder={m.auth_password_placeholder()}
							required
						/>
					</Field.Field>
					<Button type="submit" class="w-full">
						<IconMail data-icon="inline-start" />
						{m.auth_establish_session()}
					</Button>
				</Field.FieldGroup>
			</form>

			<p class="mt-4 text-center text-xs text-muted-foreground">
				{m.auth_admin_note()}
			</p>
		</Card.Content>
	</Card.Root>
</div>
