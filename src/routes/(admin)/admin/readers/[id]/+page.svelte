<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Field from '$lib/components/ui/field';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import IconCrown from '@tabler/icons-svelte-runes/icons/crown';
	import IconBan from '@tabler/icons-svelte-runes/icons/ban';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data }: { data: PageData } = $props();

	let confirmOpen = $state(false);
	let reason = $state('');

	const headerActions = useAdminHeaderActionRegistry();
	$effect(() => {
		const off1 = headerActions?.register('readers:ban', () => (confirmOpen = true));
		const off2 = headerActions?.register('readers:unban', () => unbanForm?.requestSubmit());
		return () => {
			off1?.();
			off2?.();
		};
	});

	let unbanForm = $state<HTMLFormElement | null>(null);

	const afterToggle: SubmitFunction = () => {
		return async ({ update }) => {
			confirmOpen = false;
			reason = '';
			await update();
		};
	};

	function formatDate(value: Date | null): string {
		if (!value) return m.admin_readers_never();
		return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
	}
</script>

<div class="@container/detail flex min-h-0 flex-1 flex-col">
	<!-- Panel heading: focus lands here on open (a11y contract). -->
	<div class="flex h-11 shrink-0 items-center gap-2 border-b px-4">
		<h1 class="min-w-0 flex-1 truncate text-sm font-semibold" tabindex="-1">
			{data.reader.name}
		</h1>
		{#if data.reader.role === 'owner'}
			<Badge variant="secondary">
				<IconCrown data-icon="inline-start" />
				{m.admin_readers_role_owner()}
			</Badge>
		{/if}
		{#if data.reader.banned}
			<Badge variant="destructive">
				<IconBan data-icon="inline-start" />
				{m.admin_readers_ban()}
			</Badge>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<!-- Identity block -->
		<section class="flex items-center gap-3 border-b px-4 py-3">
			<span
				class="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted"
			>
				{#if data.reader.image}
					<img alt="" class="size-11 object-cover" src={data.reader.image} />
				{:else}
					<span class="text-sm font-medium text-muted-foreground">
						{data.reader.name.slice(0, 1).toUpperCase()}
					</span>
				{/if}
			</span>
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm font-medium">{data.reader.email}</div>
				<div class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
					{#if data.reader.emailVerified}
						<span class="text-emerald-600 dark:text-emerald-400">
							{m.admin_readers_verified()}
						</span>
					{:else}
						<span>{m.admin_readers_unverified()}</span>
					{/if}
					{#if data.reader.twoFactorEnabled}
						<span aria-hidden="true">·</span>
						<span>2FA</span>
					{/if}
				</div>
			</div>
		</section>

		<!-- Facts: a compact two-column definition grid -->
		<section
			class="grid grid-cols-1 gap-x-4 gap-y-2.5 border-b px-4 py-3 @min-[32rem]/detail:grid-cols-2"
		>
			{#each [{ label: 'ID', value: data.reader.id }, { label: m.admin_readers_role(), value: data.reader.role }, { label: m.admin_readers_joined(), value: formatDate(data.reader.createdAt) }, { label: m.admin_readers_last_login(), value: formatDate(data.reader.lastLogin) }, { label: m.admin_readers_updated(), value: formatDate(data.reader.updatedAt) }, { label: m.admin_readers_account(), value: data.reader.name }] as row (row.label)}
				<div class="flex min-w-0 items-baseline justify-between gap-3">
					<span class="shrink-0 text-[11px] text-muted-foreground">{row.label}</span>
					<span class="min-w-0 truncate text-right text-xs">{row.value}</span>
				</div>
			{/each}
		</section>

		{#if data.reader.banned && data.reader.banReason}
			<section class="border-b px-4 py-3">
				<Field.Field>
					<Field.FieldLabel class="text-[11px]">{m.admin_readers_ban_reason()}</Field.FieldLabel>
					<p class="text-sm text-destructive">{data.reader.banReason}</p>
				</Field.Field>
			</section>
		{/if}
	</div>

	<form bind:this={unbanForm} method="POST" action="?/unban" use:enhance={afterToggle}></form>
</div>

<!-- Ban is destructive and not the default action anywhere (Apple HIG, Alerts). -->
<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_readers_ban_confirm_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_readers_ban_confirm_desc({ name: data.reader.name })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<form method="POST" action="?/ban" use:enhance={afterToggle} class="contents">
			<div class="px-6 pb-2">
				<Field.Field>
					<Field.FieldLabel for="ban-reason" class="text-[11px]">
						{m.admin_readers_ban_reason()}
					</Field.FieldLabel>
					<Input id="ban-reason" name="reason" bind:value={reason} />
				</Field.Field>
			</div>
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
				<Button type="submit" variant="destructive">{m.admin_readers_ban()}</Button>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>
