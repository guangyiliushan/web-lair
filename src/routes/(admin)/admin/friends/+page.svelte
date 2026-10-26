<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import { useAdminHeaderActionRegistry } from '$lib/components/admin/admin-header-actions';
	import { Empty } from '$lib/components/ui/empty';
	import { ListRowActions, ListTable, listColumnClass } from '$lib/components/admin/list-table';
	import { cols, columns } from './columns';
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';

	interface Friend {
		id: string;
		name: string;
		description: string;
		url: string;
		type: string;
		email: string;
		createdAt: string;
	}

	const friends: Friend[] = [
		{
			id: '1',
			name: '123',
			description: '-',
			url: 'example.com',
			type: m.admin_friends_type_friend(),
			email: '-',
			createdAt: '2026/07/17'
		}
	];

	const states = ['friends', 'pending', 'outdated', 'rejected', 'banned'] as const;
	const stateLabels: Record<string, string> = {
		friends: m.admin_friends_state_friends(),
		pending: m.admin_friends_state_pending(),
		outdated: m.admin_friends_state_outdated(),
		rejected: m.admin_friends_state_rejected(),
		banned: m.admin_friends_state_banned()
	};

	let activeState = $state('friends');
	let addDialogOpen = $state(false);

	let formName = $state('');
	let formAvatar = $state('');
	let formUrl = $state('');
	let formDescription = $state('');
	let formType = $state(m.admin_friends_type_friend());

	function resetForm() {
		formName = '';
		formAvatar = '';
		formUrl = '';
		formDescription = '';
		formType = m.admin_friends_type_friend();
	}

	function openAddDialog() {
		resetForm();
		addDialogOpen = true;
	}

	// The header lives in the admin layout; bind its "新建" action to this
	// page's dialog (the label/icon are declared in +page.server.ts).
	const headerActions = useAdminHeaderActionRegistry();
	$effect(() => {
		return headerActions?.register('friends:create', openAddDialog);
	});

	function avatarText(name: string): string {
		return name.slice(0, 1);
	}

	// The `links` table exists but nothing reads or writes it yet, so the row
	// actions stay no-ops - the page is a UI shell over a mock array. Wiring
	// real CRUD is a separate change and must not be faked here.
	function editFriend() {}

	function removeFriend() {}
</script>

<svelte:head>
	<title>{m.admin_friends_title()} - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<!-- State tabs bar -->
	<div class="flex h-10 shrink-0 items-center gap-2 border-b px-4">
		<ToggleGroup.Root
			type="single"
			bind:value={activeState}
			variant="outline"
			size="sm"
			class="gap-1"
		>
			{#each states as state (state)}
				<ToggleGroup.Item value={state}>
					{stateLabels[state]}
					{#if activeState === state}
						<span class="ml-0.5 text-xs opacity-60">{friends.length}</span>
					{/if}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	</div>

	<ListTable
		{columns}
		rows={friends}
		rowKey={(friend) => friend.id}
		label={m.admin_friends_title()}
		class="min-h-96"
	>
		{#snippet row(friend)}
			<Table.Cell class={cn(listColumnClass(cols.name), 'whitespace-normal')}>
				<div class="flex items-center gap-3">
					<div
						class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground"
					>
						{avatarText(friend.name)}
					</div>
					<a
						class="min-w-0 truncate font-medium hover:underline"
						href="http://{friend.url}"
						rel="noreferrer"
						target="_blank"
					>
						{friend.name}
						<IconExternalLink class="ml-1 inline size-3" />
					</a>
				</div>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.description), 'whitespace-normal')}>
				<span class="line-clamp-2 text-muted-foreground">{friend.description}</span>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.url), 'whitespace-normal')}>
				<a
					class="truncate text-muted-foreground hover:underline"
					href="http://{friend.url}"
					rel="noreferrer"
					target="_blank"
				>
					{friend.url}
				</a>
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.type), 'text-muted-foreground')}>
				{friend.type}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.email), 'whitespace-normal')}>
				<span class="text-muted-foreground/70">{friend.email}</span>
			</Table.Cell>
			<Table.Cell
				class={cn(listColumnClass(cols.created), 'whitespace-nowrap text-muted-foreground')}
			>
				{friend.createdAt}
			</Table.Cell>
			<Table.Cell class={cn(listColumnClass(cols.actions), 'text-right')}>
				<ListRowActions
					editLabel={m.admin_common_edit()}
					onEdit={editFriend}
					deleteLabel={m.admin_friends_remove()}
					onDelete={removeFriend}
				/>
			</Table.Cell>
		{/snippet}

		{#snippet empty()}
			<Empty class="mx-auto py-14">
				<p class="text-sm text-muted-foreground">{m.admin_friends_empty()}</p>
			</Empty>
		{/snippet}
	</ListTable>
</div>

<!-- Add friend dialog -->
<Dialog.Root bind:open={addDialogOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form
			class="flex flex-col"
			onsubmit={(e) => {
				e.preventDefault();
				addDialogOpen = false;
			}}
		>
			<div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
				<Dialog.Title>{m.admin_friends_add()}</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							{...props}
							aria-label={m.admin_common_close()}
						>
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			<div class="grid gap-4 px-5 py-4">
				<div class="grid gap-1.5">
					<label for="friend-name" class="text-sm font-medium">
						{m.admin_friends_field_name()}<span class="text-destructive"> *</span>
					</label>
					<Input id="friend-name" required bind:value={formName} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-avatar" class="text-sm font-medium"
						>{m.admin_friends_field_avatar()}</label
					>
					<Input id="friend-avatar" bind:value={formAvatar} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-url" class="text-sm font-medium">
						{m.admin_friends_col_url()}<span class="text-destructive"> *</span>
					</label>
					<Input id="friend-url" required bind:value={formUrl} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-desc" class="text-sm font-medium"
						>{m.admin_friends_col_description()}</label
					>
					<Input id="friend-desc" bind:value={formDescription} />
				</div>
				<div class="grid gap-1.5">
					<label for="friend-type" class="text-sm font-medium">{m.admin_common_type()}</label>
					<button
						id="friend-type"
						type="button"
						class="flex h-10 w-full items-center justify-between gap-2 rounded-sm border bg-surface-card pr-2 pl-3 text-left text-sm hover:bg-muted/50"
					>
						<span>{formType}</span>
						<IconChevronDown class="size-4 shrink-0 text-muted-foreground" />
					</button>
				</div>
			</div>
			<div class="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-2">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" size="sm" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" size="sm" disabled={!formName.trim() || !formUrl.trim()}
					>{m.admin_common_confirm()}</Button
				>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
