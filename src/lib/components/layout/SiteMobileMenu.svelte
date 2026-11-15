<script lang="ts">
	import { page } from '$app/state';
	import { deLocalizeHref } from '$lib/paraglide/runtime';
	import { isActivePath, siteHref } from '$lib/utils/href';
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import { slide } from 'svelte/transition';
	import { cubicInOut } from 'svelte/easing';
	import { Separator } from '$lib/components/ui/separator';
	import SocialRail from '$lib/components/layout/SocialRail.svelte';
	import type { SocialLinkLike } from '$lib/config/social';
	import {
		navigationConfig,
		tLabel,
		type NavChild,
		type NavMenuData,
		type PagesMegaData
	} from '$lib/config/navigation.config';

	type AuthData = {
		user: {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			image: string | null;
		} | null;
		profile: { displayName: string; avatarUrl: string | null } | null;
	} | null;

	let {
		auth,
		ownerLinks,
		postsData,
		pagesData,
		onclose
	}: {
		auth?: AuthData;
		ownerLinks?: readonly SocialLinkLike[] | null;
		postsData?: NavMenuData | null;
		pagesData?: PagesMegaData | null;
		onclose: () => void;
	} = $props();

	let expandedKey = $state<string | null>(null);
	const neutralPath = $derived(deLocalizeHref(page.url.pathname));

	function isActive(path: string): boolean {
		return isActivePath(neutralPath, path);
	}

	function getMobileChildren(item: (typeof navigationConfig)[number]): NavChild[] {
		if (item.key === 'nav_posts') {
			const cats = postsData?.leftItems || [];
			return [...cats, { labelKey: 'nav_posts_view_all' as const, href: '/posts' }];
		}
		if (item.key === 'nav_timeline') {
			return [
				{ label: m.nav_timeline_posts(), href: '/timeline?type=post' },
				{ label: m.nav_timeline_notes(), href: '/timeline?type=note' }
			];
		}
		if (item.key === 'nav_notes') {
			return [];
		}
		return item.children || [];
	}

	function childLabel(child: NavChild): string {
		return child.label ?? (child.labelKey ? tLabel(child.labelKey) : '');
	}

	function toggleExpanded(key: string) {
		expandedKey = expandedKey === key ? null : key;
	}
</script>

<Separator class="mx-4" />

<div class="px-5 pt-6 pb-5">
	<nav class="max-h-[70svh] overflow-y-auto" aria-label="Mobile navigation">
		<div class="flex flex-col">
			{#each navigationConfig.filter((i) => i.key !== 'nav_more') as item (item.key)}
				{@const mobileChildren = getMobileChildren(item)}
				<div>
					{#if mobileChildren.length > 0}
						<div
							class="flex items-center justify-between rounded-lg transition-colors hover:bg-muted/50"
						>
							<a
								href={siteHref(item.href)}
								onclick={onclose}
								class={cn(
									'flex-1 px-3 py-2.5 text-sm font-medium transition-colors hover:text-foreground',
									isActive(item.href) ? 'text-primary-text' : 'text-muted-foreground'
								)}
							>
								{tLabel(item.labelKey)}
							</a>
							<button
								onclick={() => toggleExpanded(item.key)}
								class="flex items-center justify-center px-4 py-2.5 text-muted-foreground transition-colors hover:text-foreground"
								aria-label={expandedKey === item.key ? 'Collapse' : 'Expand'}
							>
								<span
									class={cn(
										'transition-transform duration-300',
										expandedKey === item.key ? 'rotate-180' : ''
									)}
								>
									<IconChevronDown class="size-4" />
								</span>
							</button>
						</div>
						{#if expandedKey === item.key}
							<div
								transition:slide={{ duration: 300, easing: cubicInOut }}
								class="ml-3 flex flex-col border-l pt-0.5 pb-1 pl-3"
							>
								{#each mobileChildren as child (child.href)}
									<a
										href={siteHref(child.href)}
										onclick={onclose}
										class="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
									>
										<span>{childLabel(child)}</span>
										{#if child.badge}
											<span class="text-xs text-muted-foreground">{child.badge}</span>
										{/if}
									</a>
								{/each}
							</div>
						{/if}
					{:else}
						<a
							href={siteHref(item.href)}
							onclick={onclose}
							class={cn(
								'flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted/50 hover:text-foreground',
								isActive(item.href) ? 'bg-primary/10 text-primary-text' : 'text-muted-foreground'
							)}
						>
							{tLabel(item.labelKey)}
						</a>
					{/if}
				</div>
			{/each}
		</div>

		{#if pagesData && pagesData.leftItems.length > 0}
			<div>
				<div
					class="flex items-center justify-between rounded-lg transition-colors hover:bg-muted/50"
				>
					<span class="flex-1 px-3 py-2.5 text-sm font-medium text-muted-foreground"
						>{m.nav_pages()}</span
					>
					<button
						onclick={() => toggleExpanded('nav_pages')}
						class="flex items-center justify-center px-4 py-2.5 text-muted-foreground transition-colors hover:text-foreground"
						aria-label={expandedKey === 'nav_pages' ? 'Collapse' : 'Expand'}
					>
						<span
							class={cn(
								'transition-transform duration-300',
								expandedKey === 'nav_pages' ? 'rotate-180' : ''
							)}
						>
							<IconChevronDown class="size-4" />
						</span>
					</button>
				</div>
				{#if expandedKey === 'nav_pages'}
					<div
						transition:slide={{ duration: 300, easing: cubicInOut }}
						class="ml-3 flex flex-col border-l pt-0.5 pb-1 pl-3"
					>
						{#each pagesData.leftItems as child (child.key ?? child.href)}
							<a
								href={siteHref(child.href)}
								onclick={onclose}
								class="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
							>
								<span>{childLabel(child)}</span>
							</a>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		{#if navigationConfig.find((i) => i.key === 'nav_more')?.children}
			<Separator class="my-2" />
			<div class="flex flex-wrap justify-between gap-1 px-1">
				{#each navigationConfig.find((i) => i.key === 'nav_more')!.children! as child (child.href)}
					<a
						href={siteHref(child.href)}
						onclick={onclose}
						class="rounded-lg px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
					>
						{tLabel(child.labelKey!)}
					</a>
				{/each}
			</div>
		{/if}
	</nav>

	<Separator class="mt-4" />
	<div class="pt-4">
		<SocialRail links={ownerLinks} variant="mobile" class="px-1 pb-4" />
		{#if auth?.user}
			<div class="flex items-center gap-3">
				<div
					class="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-medium"
				>
					{auth.profile?.displayName?.charAt(0) ?? auth.user.name?.charAt(0) ?? '?'}
				</div>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">
						{auth.profile?.displayName ?? auth.user.name}
					</p>
					<p class="truncate text-xs text-muted-foreground">
						{auth.user.email}
					</p>
				</div>
			</div>
			<div class="mt-3 flex flex-col gap-0.5">
				<a
					href={siteHref('/admin/dashboard')}
					onclick={onclose}
					class="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
				>
					{m.nav_dashboard()}
				</a>
				<a
					href={siteHref('/account')}
					onclick={onclose}
					class="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
				>
					{m.nav_account()}
				</a>
			</div>
		{:else}
			<a
				href={siteHref(
					`/login?redirectTo=${encodeURIComponent(page.url.pathname + page.url.search)}`
				)}
				onclick={onclose}
				class="flex items-center justify-center rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted/50"
			>
				{m.nav_sign_in()}
			</a>
		{/if}
	</div>
</div>
