<script lang="ts">
	import * as Table from '$lib/components/ui/table';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
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

	function avatarText(name: string): string {
		return name.slice(0, 1);
	}

	const columns = [
		m.admin_friends_col_name(),
		m.admin_friends_col_description(),
		m.admin_friends_col_url(),
		m.admin_common_type(),
		m.admin_friends_col_email(),
		m.admin_friends_col_created(),
		m.admin_common_actions()
	];
</script>

<svelte:head>
	<title>{m.admin_friends_title()} - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<!-- 页面头部 -->
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2">
			<h2 class="inline-flex items-center gap-2 text-lg font-semibold">
				<IconUsers class="size-4" />
				{m.admin_nav_friends()}
			</h2>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<span class="hidden text-xs text-muted-foreground sm:inline"
				>{m.admin_friends_count({ count: friends.length })}</span
			>
			<Button size="sm" variant="outline" onclick={openAddDialog}>
				<IconPlus class="size-4" />
				<span class="hidden sm:inline">{m.admin_friends_add()}</span>
			</Button>
			<Button size="sm" variant="outline" aria-label={m.admin_friends_check_aria()}>
				<IconSearch class="size-4" />
				<span class="hidden lg:inline">{m.admin_friends_check()}</span>
			</Button>
			<Button size="sm" variant="outline" aria-label={m.admin_friends_migrate_avatars()}>
				<IconRefresh class="size-4" />
				<span class="hidden lg:inline">{m.admin_friends_migrate_avatars()}</span>
			</Button>
		</div>
	</header>

	<!-- 状态标签栏 -->
	<div class="shrink-0 border-b px-4 py-2">
		<div class="inline-flex flex-wrap gap-1 rounded-sm border bg-background p-1">
			{#each states as state (state)}
				<button
					type="button"
					class="inline-flex h-8 items-center gap-2 rounded-xs px-3 text-sm transition-colors {activeState ===
					state
						? 'bg-foreground text-background'
						: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
					onclick={() => (activeState = state)}
				>
					{stateLabels[state]}
					<span
						class="rounded-full px-1.5 py-0.5 text-xs {activeState === state
							? 'bg-background/20'
							: 'bg-muted'}"
					>
						{activeState === state ? friends.length : 0}
					</span>
				</button>
			{/each}
		</div>
	</div>

	<!-- 数据表格 -->
	<div class="min-h-0 flex-1 overflow-auto">
		<Table.Root>
			<Table.Header class="sticky top-0 z-10 bg-muted/50">
				<Table.Row class="text-xs text-muted-foreground uppercase hover:bg-transparent">
					{#each columns as col (col)}
						<Table.Head class={col === m.admin_common_actions() ? 'text-right' : ''}
							>{col}</Table.Head
						>
					{/each}
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#if friends.length === 0}
					<Table.Row>
						<Table.Cell colspan={columns.length} class="py-12 text-center">
							<p class="text-sm text-muted-foreground">{m.admin_friends_empty()}</p>
						</Table.Cell>
					</Table.Row>
				{:else}
					{#each friends as friend (friend.id)}
						<Table.Row class="align-top">
							<!-- 名称 -->
							<Table.Cell>
								<div class="flex items-center gap-3">
									<div
										class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground"
									>
										{avatarText(friend.name)}
									</div>
									<a
										class="font-medium hover:underline"
										href="http://{friend.url}"
										rel="noreferrer"
										target="_blank"
									>
										{friend.name}
										<IconExternalLink class="ml-1 inline size-3" />
									</a>
								</div>
							</Table.Cell>
							<!-- 描述 -->
							<Table.Cell class="max-w-[18rem] text-muted-foreground">
								<span class="line-clamp-2">{friend.description}</span>
							</Table.Cell>
							<!-- 网址 -->
							<Table.Cell class="max-w-[18rem]">
								<a
									class="truncate text-muted-foreground hover:underline"
									href="http://{friend.url}"
									rel="noreferrer"
									target="_blank"
								>
									{friend.url}
								</a>
							</Table.Cell>
							<!-- 类型 -->
							<Table.Cell class="text-muted-foreground">{friend.type}</Table.Cell>
							<!-- 邮箱 -->
							<Table.Cell>
								<span class="text-muted-foreground/70">{friend.email}</span>
							</Table.Cell>
							<!-- 创建时间 -->
							<Table.Cell class="whitespace-nowrap text-muted-foreground"
								>{friend.createdAt}</Table.Cell
							>
							<!-- 操作 -->
							<Table.Cell class="text-right">
								<div class="flex justify-end gap-1">
									<Button variant="outline" size="sm" class="h-8 gap-1 px-2 text-xs">
										<IconPencil class="size-3.5" />
										{m.admin_common_edit()}
									</Button>
									<Button
										variant="outline"
										size="sm"
										class="h-8 gap-1 border-destructive/30 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
									>
										<IconTrash class="size-3.5" />
										{m.admin_friends_remove()}
									</Button>
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				{/if}
			</Table.Body>
		</Table.Root>
	</div>
</div>

<!-- 新增友链对话框 -->
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
						class="bg-surface-card flex h-10 w-full items-center justify-between gap-2 rounded-sm border pr-2 pl-3 text-left text-sm hover:bg-muted/50"
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
