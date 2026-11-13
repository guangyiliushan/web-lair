<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import type { ActionData, PageServerData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import IconBrandGithub from '@tabler/icons-svelte-runes/icons/brand-github';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
	import IconCircleCheck from '@tabler/icons-svelte-runes/icons/circle-check';

	let { data, form }: { data: PageServerData; form: ActionData } = $props();

	const redirectParam = $derived(
		$page.url.searchParams.get('redirectTo')
			? `?redirectTo=${encodeURIComponent($page.url.searchParams.get('redirectTo')!)}`
			: ''
	);
</script>

<div class="flex w-full flex-col items-center justify-center">
	<Card.Root class="w-full max-w-md">
		<Card.Header class="text-center">
			<Card.Title class="text-2xl">{m.auth_login_title()}</Card.Title>
			<Card.Description>{m.auth_login_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if data.resetSuccess}
				<div
					class="mb-6 flex items-center gap-2 rounded-md bg-primary/10 px-4 py-3 text-sm text-primary"
					role="status"
				>
					<IconCircleCheck class="size-4 shrink-0" />
					<span>{m.auth_reset_success_message()}</span>
				</div>
			{/if}

			{#if form?.message}
				<div
					class="mb-6 flex items-center gap-2 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
					role="alert"
				>
					<IconAlertCircle class="size-4 shrink-0" />
					<span>{form.message}</span>
				</div>
			{/if}

			{#if data.oauthError}
				<div
					class="mb-6 flex items-start gap-2 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
					role="alert"
				>
					<IconAlertCircle class="mt-0.5 size-4 shrink-0" />
					<span>
						{data.oauthError === 'admin_blocked'
							? m.auth_login_oauth_admin_blocked()
							: m.auth_login_oauth_error()}
					</span>
				</div>
			{/if}

			<form method="post" action="?/signIn" use:enhance>
				<Field.FieldGroup>
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
							autocomplete="current-password"
							placeholder={m.auth_password_placeholder()}
							required
						/>
					</Field.Field>
					<Button type="submit" class="w-full">
						<IconMail data-icon="inline-start" />
						{m.auth_sign_in_email()}
					</Button>
				</Field.FieldGroup>
			</form>

			<div class="mt-4 text-center">
				<a
					href="/forgot-password"
					class="text-sm text-muted-foreground underline-offset-2 hover:underline"
				>
					{m.auth_forgot_password()}
				</a>
			</div>

			<div class="relative my-6">
				<Separator />
				<span
					class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs text-muted-foreground"
				>
					{m.auth_or_continue_with()}
				</span>
			</div>

			<form method="post" action="?/signInSocial" use:enhance>
				<input type="hidden" name="provider" value="github" />
				<input
					type="hidden"
					name="redirectTo"
					value={$page.url.searchParams.get('redirectTo') ?? '/admin'}
				/>
				<Button variant="outline" type="submit" class="w-full">
					<IconBrandGithub data-icon="inline-start" />
					GitHub
				</Button>
			</form>
		</Card.Content>
		<Card.Footer class="justify-center">
			<p class="text-sm text-muted-foreground">
				{m.auth_no_account()}
				<a href="/register{redirectParam}" class="font-medium underline-offset-2 hover:underline">
					{m.auth_sign_up_link()}
				</a>
			</p>
		</Card.Footer>
	</Card.Root>
</div>
