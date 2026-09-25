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
	import IconKey from '@tabler/icons-svelte-runes/icons/key';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// The form toggles between the authenticator code and a backup code; the
	// choice is re-sent on every submit so the action knows which endpoint to use.
	let useBackupCode = $state(false);

	// better-auth collapses its 2FA failures into messages that 1.7.5 does not
	// even carry (APIError.from(status, string) -> message === ''), so the action
	// classifies them and the page owns the localized copy (B3.1 review).
	const ERROR_MESSAGES: Record<string, () => string> = {
		invalid_code: m.auth_2fa_error_invalid_code,
		expired: m.auth_2fa_error_expired,
		locked: m.auth_2fa_error_locked
	};

	const actionForm = $derived(form as { message?: string | null; errorCode?: string } | null);
	const errorText = $derived(
		actionForm?.errorCode
			? (ERROR_MESSAGES[actionForm.errorCode]?.() ?? actionForm?.message)
			: actionForm?.message
	);
</script>

<svelte:head>
	<title>Two-step verification - Lair</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4 py-12">
	<Card.Root class="w-full max-w-md">
		<Card.Header class="text-center">
			<div
				class="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary"
			>
				<IconShieldLock class="size-6" />
			</div>
			<Card.Title class="text-2xl">{m.auth_2fa_title()}</Card.Title>
			<Card.Description>{m.auth_2fa_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if errorText}
				<div
					class="mb-6 flex items-center gap-2 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
					role="alert"
				>
					<IconAlertCircle class="size-4 shrink-0" />
					<span>{errorText}</span>
				</div>
			{/if}

			<form method="post" action="?/verify" use:enhance>
				<input type="hidden" name="redirectTo" value={data.redirectTo} />
				<input type="hidden" name="method" value={useBackupCode ? 'backup' : 'totp'} />
				<Field.FieldGroup>
					<Field.Field>
						<Field.FieldLabel for="code">
							{useBackupCode ? m.auth_2fa_backup_code() : m.auth_2fa_code()}
						</Field.FieldLabel>
						<Input
							id="code"
							name="code"
							type="text"
							inputmode={useBackupCode ? 'text' : 'numeric'}
							autocomplete="one-time-code"
							placeholder={useBackupCode
								? m.auth_2fa_backup_placeholder()
								: m.auth_2fa_code_placeholder()}
							required
						/>
					</Field.Field>
					<Button type="submit" class="w-full">
						<IconKey data-icon="inline-start" />
						{m.auth_2fa_verify()}
					</Button>
					<Button
						type="button"
						variant="ghost"
						class="w-full"
						onclick={() => (useBackupCode = !useBackupCode)}
					>
						{useBackupCode ? m.auth_2fa_use_totp() : m.auth_2fa_use_backup()}
					</Button>
				</Field.FieldGroup>
			</form>
			<div class="mt-4 text-center text-sm">
				<a
					class="text-muted-foreground hover:text-foreground hover:underline"
					href={data.loginPath}
				>
					{m.auth_2fa_back_to_login()}
				</a>
			</div>
		</Card.Content>
	</Card.Root>
</div>
