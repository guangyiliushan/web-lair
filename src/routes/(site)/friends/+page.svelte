<script lang="ts">
	import { page } from '$app/state';
	import IconArrowUpRight from '@tabler/icons-svelte-runes/icons/arrow-up-right';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import * as Alert from '$lib/components/ui/alert';
	import * as Avatar from '$lib/components/ui/avatar';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import * as Item from '$lib/components/ui/item';
	import { Separator } from '$lib/components/ui/separator';
	import { m } from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';
	import FriendsApplyDialog from './friends-apply-dialog.svelte';
	import FriendsPolicyDialog from './friends-policy-dialog.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const siteUrl = $derived(`${page.url.origin}/`);
	const approvedCount = $derived(data.friends.approved.length);
	const MOBILE_PREVIEW = 10;

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let showAll = $state(false);

	function avatarText(name: string): string {
		return name.slice(0, 1).toUpperCase();
	}

	/** The "our link info" block exists so partners can copy us verbatim. */
	async function copySiteInfo() {
		const lines = [
			`${m.friends_site_info_name()}: ${data.siteInfo.name}`,
			`${m.friends_site_info_url()}: ${siteUrl}`,
			`${m.friends_site_info_avatar()}: ${data.siteInfo.avatar ?? ''}`,
			`${m.friends_site_info_description()}: ${data.siteInfo.description}`
		];
		try {
			await navigator.clipboard.writeText(lines.join('\n'));
			copied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 2000);
		} catch {
			copied = false;
		}
	}
</script>

<svelte:head>
	<title>{m.friends_title()}</title>
	<meta name="description" content={m.friends_subtitle()} />
</svelte:head>

<div class="mx-auto mt-14 w-full max-w-5xl px-4 sm:px-6 lg:mt-20 lg:px-8 2xl:max-w-6xl">
	<header class="flex items-start justify-between gap-3">
		<div class="max-w-2xl min-w-0 flex-1">
			<h1 class="text-3xl font-normal tracking-tight text-balance">{m.friends_title()}</h1>
			<p class="mt-3 text-sm leading-relaxed text-muted-foreground">{m.friends_subtitle()}</p>
		</div>
		{#if approvedCount > 0}
			<Badge variant="secondary" class="mt-1 shrink-0 tabular-nums">
				{m.friends_count({ count: approvedCount })}
			</Badge>
		{/if}
	</header>

	<section class="mt-8" aria-labelledby="friends-list-title">
		<h2 id="friends-list-title" class="sr-only">{m.friends_title()}</h2>
		{#if approvedCount === 0}
			<Empty.Root class="border border-border/60 bg-muted/20">
				<Empty.Header>
					<Empty.Media variant="icon"><IconUsers /></Empty.Media>
					<Empty.Title>{m.friends_empty()}</Empty.Title>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<Item.Group
				id="friends-list"
				class="grid grid-cols-1 gap-x-8! gap-y-0! sm:grid-cols-2 lg:grid-cols-3"
				aria-labelledby="friends-list-title"
			>
				{#each data.friends.approved as friend, index (friend.id)}
					<div role="listitem" class={cn(index >= MOBILE_PREVIEW && !showAll && 'max-md:hidden')}>
						<Item.Root
							size="xs"
							class="min-h-14 rounded-none border-0 border-b border-border/50 focus-visible:ring-foreground/60"
						>
							{#snippet child({ props })}
								<a
									{...props}
									href={friend.url}
									target="_blank"
									rel="noopener noreferrer"
									title={`${friend.name} — ${friend.description ?? friend.host}`}
								>
									<Item.Media variant="image" class="rounded-full">
										<Avatar.Root class="size-8">
											{#if friend.avatar}
												<Avatar.Image src={friend.avatar} alt="" referrerpolicy="no-referrer" />
											{/if}
											<Avatar.Fallback class="bg-primary/10 text-xs text-primary-text">
												{avatarText(friend.name)}
											</Avatar.Fallback>
										</Avatar.Root>
									</Item.Media>
									<Item.Content class="min-w-0">
										<Item.Title class="w-full group-hover/item:text-primary-text">
											{friend.name}
										</Item.Title>
										<Item.Description class="font-mono text-xs">
											{friend.host}
										</Item.Description>
										{#if friend.description}
											<span class="sr-only">{friend.description}</span>
										{/if}
									</Item.Content>
									<Item.Actions>
										<IconArrowUpRight
											class="size-4 text-muted-foreground opacity-0 transition-opacity group-focus-within/item:opacity-100 group-hover/item:opacity-100 motion-reduce:transition-none"
											aria-hidden="true"
										/>
									</Item.Actions>
									<span class="sr-only">{m.friends_opens_new_tab()}</span>
								</a>
							{/snippet}
						</Item.Root>
					</div>
				{/each}
			</Item.Group>

			{#if approvedCount > MOBILE_PREVIEW && !showAll}
				<Button
					type="button"
					variant="ghost"
					class="mt-2 min-h-11 w-full text-primary-text focus-visible:ring-foreground/40 md:hidden"
					aria-controls="friends-list"
					aria-expanded={showAll}
					onclick={() => (showAll = true)}
				>
					{m.friends_show_all({ count: approvedCount })}
				</Button>
			{/if}
		{/if}
	</section>

	{#if data.friends.outdated.length > 0}
		<section class="mt-12" aria-labelledby="friends-outdated-title">
			<div class="flex items-center gap-2">
				<h2 id="friends-outdated-title" class="text-base font-medium">
					{m.friends_unreachable()}
				</h2>
				<Badge variant="secondary" class="tabular-nums">{data.friends.outdated.length}</Badge>
			</div>
			<p class="mt-1 text-sm text-muted-foreground">{m.friends_outdated_note()}</p>
			<Item.Group class="mt-3 grid grid-cols-1 gap-x-8! gap-y-0! sm:grid-cols-2 lg:grid-cols-3">
				{#each data.friends.outdated as friend (friend.id)}
					<Item.Root
						role="listitem"
						size="xs"
						variant="muted"
						class="min-h-14 rounded-none border-0 border-b border-border/50 opacity-70"
						title={friend.description}
					>
						<Item.Media variant="image" class="rounded-full">
							<Avatar.Root class="size-8">
								<Avatar.Fallback class="bg-muted text-xs text-muted-foreground">
									{avatarText(friend.name)}
								</Avatar.Fallback>
							</Avatar.Root>
						</Item.Media>
						<Item.Content class="min-w-0">
							<Item.Title class="w-full">{friend.name}</Item.Title>
							<Item.Description class="font-mono text-xs">{friend.host}</Item.Description>
							{#if friend.description}
								<span class="sr-only">{friend.description}</span>
							{/if}
						</Item.Content>
					</Item.Root>
				{/each}
			</Item.Group>
		</section>
	{/if}

	{#if data.friends.banned.length > 0}
		<section class="mt-12" aria-labelledby="friends-banned-title">
			<div class="flex items-center gap-2">
				<h2 id="friends-banned-title" class="text-base font-medium">
					{m.friends_non_compliant()}
				</h2>
				<Badge variant="secondary" class="tabular-nums">{data.friends.banned.length}</Badge>
			</div>
			<p class="mt-1 text-sm text-muted-foreground">{m.friends_banned_note()}</p>
			<Item.Group class="mt-3 gap-y-2!">
				{#each data.friends.banned as friend (friend.id)}
					<Item.Root role="listitem" size="xs" variant="muted" class="min-h-14">
						<Item.Content class="min-w-0">
							<Item.Title class="w-full">
								{friend.name}
								<span class="mx-2 text-muted-foreground">·</span>
								<span class="font-mono text-xs font-normal text-muted-foreground"
									>{friend.host}</span
								>
							</Item.Title>
							{#if friend.reason}
								<Item.Description class="text-xs">
									{m.friends_banned_reason({ reason: friend.reason })}
								</Item.Description>
							{/if}
						</Item.Content>
					</Item.Root>
				{/each}
			</Item.Group>
		</section>
	{/if}

	<Separator class="mt-16" />

	<section
		id="apply"
		class="mt-8 grid scroll-mt-24 grid-cols-1 items-start gap-8 md:grid-cols-[minmax(0,1fr)_320px] md:gap-12 lg:grid-cols-[minmax(0,1fr)_340px]"
		aria-labelledby="friends-apply-title"
	>
		<div>
			<p class="font-mono text-xs tracking-[0.16em] text-muted-foreground uppercase">
				{m.friends_apply_eyebrow()}
			</p>
			<h2 id="friends-apply-title" class="mt-2 text-2xl font-normal tracking-tight text-balance">
				{m.friends_apply_title()}
			</h2>
			<p class="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
				{m.friends_apply_description()}
			</p>
			<div id="friends-policy" class="mt-5 flex scroll-mt-24 items-baseline justify-between gap-2">
				<h3 id="friends-policy-title" class="text-sm font-medium">
					{m.friends_policy_title()}
				</h3>
				<FriendsPolicyDialog facts={data.policyFacts} />
			</div>
			<ul
				class="mt-2 flex max-w-prose flex-col gap-2 text-sm leading-relaxed text-muted-foreground"
			>
				<li class="flex gap-2">
					<span class="mt-[0.55em] size-1 shrink-0 rounded-full bg-primary/60"></span>
					<span>{m.friends_site_info()}</span>
				</li>
				<li class="flex gap-2">
					<span class="mt-[0.55em] size-1 shrink-0 rounded-full bg-primary/60"></span>
					<span>{m.friends_policy_backlink()}</span>
				</li>
			</ul>
			<p class="mt-4 max-w-prose text-xs text-muted-foreground">{m.friends_apply_note()}</p>
		</div>

		<Card.Root class="bg-card/60">
			<Card.Header>
				<Card.Title>
					<h3 class="text-sm font-medium">{m.friends_site_info_title()}</h3>
				</Card.Title>
				{#if data.siteInfo.description}
					<Card.Description>{data.siteInfo.description}</Card.Description>
				{/if}
			</Card.Header>

			<Card.Content class="flex flex-col gap-4">
				<div class="flex items-center gap-2.5">
					<Avatar.Root class="size-9 shrink-0 rounded-full">
						{#if data.siteInfo.avatar}
							<Avatar.Image src={data.siteInfo.avatar} alt="" referrerpolicy="no-referrer" />
						{/if}
						<Avatar.Fallback class="bg-primary/10 text-primary-text">
							{avatarText(data.siteInfo.name)}
						</Avatar.Fallback>
					</Avatar.Root>
					<p class="min-w-0 truncate text-sm font-medium">{data.siteInfo.name}</p>
				</div>

				<dl class="grid grid-cols-[64px_1fr] gap-x-3 gap-y-2 text-xs">
					<div class="contents">
						<dt class="text-muted-foreground">{m.friends_site_info_url()}</dt>
						<dd class="min-w-0 truncate font-mono" title={siteUrl}>{siteUrl}</dd>
					</div>
					{#if data.siteInfo.avatar}
						<div class="contents">
							<dt class="text-muted-foreground">{m.friends_site_info_avatar()}</dt>
							<dd class="min-w-0 truncate">
								<a
									class="text-primary-text hover:underline"
									href={data.siteInfo.avatar}
									target="_blank"
									rel="noopener noreferrer"
									title={data.siteInfo.avatar}
								>
									{data.siteInfo.avatar}
								</a>
							</dd>
						</div>
					{/if}
				</dl>
			</Card.Content>

			<Card.Footer class="flex-col items-stretch gap-2">
				<Button
					type="button"
					variant="outline"
					class="min-h-11 w-full focus-visible:ring-foreground/40"
					onclick={copySiteInfo}
				>
					<IconCopy data-icon="inline-start" />
					{copied ? m.friends_site_info_copied() : m.friends_site_info_copy()}
				</Button>
				<span class="sr-only" role="status" aria-live="polite">
					{copied ? m.friends_site_info_copied() : ''}
				</span>

				{#if data.applyEnabled}
					<FriendsApplyDialog {form} policyFacts={data.policyFacts} />
				{:else}
					<Alert.Root role="status">
						<Alert.Description>{m.friends_apply_closed()}</Alert.Description>
					</Alert.Root>
				{/if}
			</Card.Footer>
		</Card.Root>
	</section>
</div>
