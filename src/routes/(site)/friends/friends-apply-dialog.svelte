<script lang="ts">
	import { enhance } from '$app/forms';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import IconLink from '@tabler/icons-svelte-runes/icons/link';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import { tick } from 'svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import * as InputGroup from '$lib/components/ui/input-group';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Textarea } from '$lib/components/ui/textarea';
	import { m } from '$lib/paraglide/messages';
	import FriendsPolicyDialog from './friends-policy-dialog.svelte';
	import type { PolicyFacts } from './policy-facts';
	import type { ActionData } from './$types';

	let { form, policyFacts }: { form: ActionData; policyFacts: PolicyFacts } = $props();

	const FIELD_IDS = {
		name: 'friends-apply-name',
		url: 'friends-apply-url',
		backlinkUrl: 'friends-apply-backlink',
		email: 'friends-apply-email',
		avatar: 'friends-apply-avatar',
		description: 'friends-apply-description',
		consent: 'friends-apply-consent'
	} as const;

	let open = $state(false);
	let submitting = $state(false);

	const errorField = $derived(form?.field);
	const errorFieldId = $derived(errorField ? FIELD_IDS[errorField] : undefined);

	$effect(() => {
		if (page.url.searchParams.get('apply') === '1') open = true;
	});

	$effect(() => {
		if (form?.message) {
			open = true;
			void tick().then(() => document.getElementById('friends-apply-error')?.focus());
		}
	});

	$effect(() => {
		if (open && !form?.message) {
			void tick().then(() => document.getElementById(FIELD_IDS.name)?.focus());
		}
	});

	$effect(() => {
		const url = new URL(page.url);
		if (open) url.searchParams.set('apply', '1');
		else url.searchParams.delete('apply');
		if (url.href !== page.url.href) replaceState(url, page.state);
	});

	function errorProps(field: keyof typeof FIELD_IDS) {
		return {
			'aria-invalid': errorField === field,
			'aria-describedby': errorField === field ? `${FIELD_IDS[field]}-error` : undefined
		};
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button
				variant="outline"
				class="min-h-11 w-full border-primary/30 bg-primary/10 text-primary-text hover:bg-primary/15 focus-visible:ring-foreground/40"
				{...props}
			>
				{m.friends_apply_open()}
			</Button>
		{/snippet}
	</Dialog.Trigger>

	<Dialog.Content
		showCloseButton={false}
		class="overscroll-contain motion-reduce:animate-none max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[calc(100dvh-1rem)] max-sm:max-w-[calc(100%-1rem)] max-sm:translate-y-0 max-sm:rounded-b-none sm:max-w-md"
	>
		<Dialog.Header class="pr-12">
			<Dialog.Title>{m.friends_apply_title()}</Dialog.Title>
			<Dialog.Description class="sr-only">{m.friends_apply_description()}</Dialog.Description>
		</Dialog.Header>

		<Dialog.Close>
			{#snippet child({ props })}
				<Button
					variant="ghost"
					size="icon"
					class="absolute top-2 right-2 size-11 focus-visible:ring-foreground/40"
					{...props}
				>
					<IconX />
					<span class="sr-only">{m.friends_apply_close()}</span>
				</Button>
			{/snippet}
		</Dialog.Close>

		{#if form?.success}
			<Alert.Root role="status">
				<Alert.Description>{m.friends_apply_success()}</Alert.Description>
			</Alert.Root>
		{:else}
			{#if form?.message}
				<Alert.Root
					id="friends-apply-error"
					tabindex={-1}
					variant="destructive"
					role={errorField ? 'status' : 'alert'}
					class="scroll-mt-4"
				>
					<Alert.Title>{m.friends_apply_err_summary()}</Alert.Title>
					<Alert.Description>
						{#if errorFieldId}
							<a class="underline underline-offset-4" href={`#${errorFieldId}`}>{form.message}</a>
						{:else}
							{form.message}
						{/if}
					</Alert.Description>
				</Alert.Root>
			{/if}

			<form
				method="POST"
				class="flex flex-col gap-4"
				aria-describedby={form?.message ? 'friends-apply-error' : undefined}
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
					};
				}}
			>
				<Field.Group class="grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-2">
					<Field.Field data-invalid={errorField === 'name'}>
						<Field.Label for={FIELD_IDS.name}>
							{m.friends_apply_name_label()}<span class="text-destructive"> *</span>
						</Field.Label>
						<Input
							id={FIELD_IDS.name}
							name="name"
							required
							maxlength={80}
							autocomplete="organization"
							class="h-11 focus-visible:ring-foreground/40 sm:h-9"
							value={form?.values?.name ?? ''}
							{...errorProps('name')}
						/>
						{#if errorField === 'name'}
							<Field.Error id={`${FIELD_IDS.name}-error`}>{form?.message}</Field.Error>
						{/if}
					</Field.Field>

					<Field.Field data-invalid={errorField === 'url'}>
						<Field.Label for={FIELD_IDS.url}>
							{m.friends_apply_url_label()}<span class="text-destructive"> *</span>
						</Field.Label>
						<InputGroup.Root class="h-11 sm:h-9">
							<InputGroup.Addon><IconLink aria-hidden="true" /></InputGroup.Addon>
							<InputGroup.Input
								id={FIELD_IDS.url}
								name="url"
								type="url"
								required
								placeholder="https://example.com"
								autocomplete="url"
								inputmode="url"
								spellcheck="false"
								class="h-full"
								value={form?.values?.url ?? ''}
								{...errorProps('url')}
							/>
						</InputGroup.Root>
						{#if errorField === 'url'}
							<Field.Error id={`${FIELD_IDS.url}-error`}>{form?.message}</Field.Error>
						{/if}
					</Field.Field>

					<Field.Field data-invalid={errorField === 'backlinkUrl'}>
						<Field.Label for={FIELD_IDS.backlinkUrl}>
							{m.friends_apply_backlink_label()}<span class="text-destructive"> *</span>
						</Field.Label>
						<InputGroup.Root class="h-11 sm:h-9">
							<InputGroup.Addon><IconLink aria-hidden="true" /></InputGroup.Addon>
							<InputGroup.Input
								id={FIELD_IDS.backlinkUrl}
								name="backlinkUrl"
								type="url"
								required
								placeholder="https://example.com/links"
								autocomplete="url"
								inputmode="url"
								spellcheck="false"
								class="h-full"
								value={form?.values?.backlinkUrl ?? ''}
								{...errorProps('backlinkUrl')}
							/>
						</InputGroup.Root>
						{#if errorField === 'backlinkUrl'}
							<Field.Error id={`${FIELD_IDS.backlinkUrl}-error`}>{form?.message}</Field.Error>
						{/if}
					</Field.Field>

					<Field.Field data-invalid={errorField === 'avatar'}>
						<Field.Label for={FIELD_IDS.avatar}>{m.friends_apply_avatar_label()}</Field.Label>
						<Input
							id={FIELD_IDS.avatar}
							name="avatar"
							type="url"
							placeholder="https://example.com/avatar.png"
							autocomplete="url"
							inputmode="url"
							spellcheck="false"
							class="h-11 focus-visible:ring-foreground/40 sm:h-9"
							value={form?.values?.avatar ?? ''}
							{...errorProps('avatar')}
						/>
						{#if errorField === 'avatar'}
							<Field.Error id={`${FIELD_IDS.avatar}-error`}>{form?.message}</Field.Error>
						{/if}
					</Field.Field>

					<Field.Field class="sm:col-span-2" data-invalid={errorField === 'email'}>
						<Field.Label for={FIELD_IDS.email}>
							{m.friends_apply_email_label()}<span class="text-destructive"> *</span>
						</Field.Label>
						<Input
							id={FIELD_IDS.email}
							name="email"
							type="email"
							required
							autocomplete="email"
							spellcheck="false"
							class="h-11 focus-visible:ring-foreground/40 sm:h-9"
							value={form?.values?.email ?? ''}
							{...errorProps('email')}
							aria-describedby={`${FIELD_IDS.email}-hint${errorField === 'email' ? ` ${FIELD_IDS.email}-error` : ''}`}
						/>
						<Field.Description id={`${FIELD_IDS.email}-hint`} class="text-xs">
							{m.friends_apply_email_hint()}
						</Field.Description>
						{#if errorField === 'email'}
							<Field.Error id={`${FIELD_IDS.email}-error`}>{form?.message}</Field.Error>
						{/if}
					</Field.Field>

					<Field.Field class="sm:col-span-2" data-invalid={errorField === 'description'}>
						<Field.Label for={FIELD_IDS.description}>
							{m.friends_apply_description_label()}
						</Field.Label>
						<Textarea
							id={FIELD_IDS.description}
							name="description"
							rows={2}
							maxlength={300}
							autocomplete="off"
							class="min-h-20 focus-visible:ring-foreground/40"
							value={form?.values?.description ?? ''}
							{...errorProps('description')}
						/>
						{#if errorField === 'description'}
							<Field.Error id={`${FIELD_IDS.description}-error`}>{form?.message}</Field.Error>
						{/if}
					</Field.Field>
				</Field.Group>

				<Field.Field
					orientation="horizontal"
					class="min-h-11"
					data-invalid={errorField === 'consent'}
				>
					<Checkbox
						id={FIELD_IDS.consent}
						name="consent"
						value="on"
						required
						{...errorProps('consent')}
					/>
					<Field.Content class="flex-col gap-1">
						<Field.Label for={FIELD_IDS.consent} class="text-sm font-normal">
							{m.friends_apply_consent()}
						</Field.Label>
						<FriendsPolicyDialog
							facts={policyFacts}
							labelledBy={FIELD_IDS.consent}
							class="self-start"
						/>
						{#if errorField === 'consent'}
							<Field.Error id={`${FIELD_IDS.consent}-error`}>{form?.message}</Field.Error>
						{/if}
					</Field.Content>
				</Field.Field>
				<input
					type="text"
					name="website"
					class="hidden"
					tabindex={-1}
					autocomplete="off"
					aria-hidden="true"
				/>

				<Dialog.Footer class="mx-0 mt-0 mb-0 rounded-none border-0 bg-transparent p-0">
					<!-- --primary is a light fill (2.9:1 on white); dark text keeps this CTA at 6.8:1. -->
					<Button
						type="submit"
						class="min-h-11 w-full text-foreground focus-visible:ring-foreground/40 sm:w-auto"
						disabled={submitting}
						aria-busy={submitting}
					>
						{#if submitting}
							<Spinner data-icon="inline-start" />
						{/if}
						{m.friends_apply_submit()}
					</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
