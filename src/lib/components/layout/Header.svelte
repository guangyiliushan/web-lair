<script lang="ts">
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';
	import { page } from '$app/state';
	import { IconCodeCircle2, IconMenu2, IconX, IconChevronDown } from '@tabler/icons-svelte-runes';
	import { slide } from 'svelte/transition';
	import { cubicInOut, quartInOut } from 'svelte/easing';
	import ThemeToggle from '$lib/components/layout/ThemeToggle.svelte';
	import LangSwitcher from '$lib/components/layout/LangSwitcher.svelte';
	import UserNav from '$lib/components/account/UserNav.svelte';
	import { Separator } from '$lib/components/ui/separator';
	import NavMegaMenu from '$lib/components/layout/NavMegaMenu.svelte';
	import {
		navigationConfig,
		tLabel,
		type MegaMenuDynamicData,
		type NavChild
	} from '$lib/config/navigation.config';

	// ── Types ──
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

	// ── Props ──
	let {
		auth,
		postsData,
		notesData,
		timelineData
	}: {
		auth?: AuthData;
		postsData?: MegaMenuDynamicData | null;
		notesData?: MegaMenuDynamicData | null;
		timelineData?: MegaMenuDynamicData | null;
	} = $props();

	// ── Derived ──
	const currentPath = $derived(page.url.pathname);

	function isActive(path: string): boolean {
		if (path === '/') return currentPath === '/' || !currentPath.startsWith('/en');
		return currentPath.startsWith(path);
	}

	function getMobileChildren(item: (typeof navigationConfig)[number]): NavChild[] {
		if (item.key === 'nav_posts') {
			const cats = postsData?.leftItems || [];
			return [...cats, { labelKey: 'nav_posts_view_all' as const, href: '/posts' }];
		}
		if (item.key === 'nav_timeline') {
			return [
				{ label: 'Posts', href: '/timeline?type=post' },
				{ label: 'Notes', href: '/timeline?type=note' },
				{ label: 'Thinking', href: '/timeline?type=thinking' }
			];
		}
		if (item.key === 'nav_notes') {
			return [];
		}
		return item.children || [];
	}

	/** Safely resolve display label from NavChild */
	function childLabel(child: NavChild): string {
		return child.label ?? (child.labelKey ? tLabel(child.labelKey) : '');
	}

	// ── Mobile menu state ──
	let menuOpen = $state(false);
	let expandedKey = $state<string | null>(null);

	function toggleMenu() {
		menuOpen = !menuOpen;
	}
	function closeMenu() {
		menuOpen = false;
		expandedKey = null;
	}
	function toggleExpanded(key: string) {
		expandedKey = expandedKey === key ? null : key;
	}
</script>

<header class="pointer-events-none fixed top-6 right-0 left-0 z-50 flex justify-center px-4">
	<!-- Single cohesive card: fixed rounded-3xl to prevent morphing artifacts during height transition -->
	<div
		class="pointer-events-auto w-full max-w-5xl overflow-hidden rounded-3xl border bg-background/70 shadow-sm backdrop-blur-md"
	>
		<!-- ══Top bar (always visible) ══-->
		<div class="flex items-center justify-between px-4 py-2">
			<!-- Logo -->
			<a href="/" class="flex shrink-0 items-center gap-2 font-bold">
				<IconCodeCircle2 class="size-6 text-primary" />
				<span class="hidden sm:inline">Lair</span>
			</a>

			<!-- Desktop nav: mega menu hover (lg+) -->
			<nav class="hidden items-center gap-1 lg:flex" aria-label="Main navigation">
				{#each navigationConfig as item (item.key)}
					{#if item.megaMenu}
						<NavMegaMenu
							menu={item.megaMenu}
							delay={150}
							triggerAsButton={item.href === '#'}
							serverData={item.key === 'nav_posts'
								? (postsData ?? null)
								: item.key === 'nav_notes'
									? (notesData ?? null)
									: item.key === 'nav_timeline'
										? (timelineData ?? null)
										: null}
						>
							{#snippet trigger(state)}
								{#if item.href === '#'}
									<button
										{...state.props}
										class={cn(
											'cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors hover:text-primary',
											'text-muted-foreground'
										)}
									>
										{tLabel(item.labelKey)}
									</button>
								{:else}
									<a
										{...state.props}
										href={item.href}
										class={cn(
											'rounded-full px-4 py-1.5 text-sm font-medium transition-colors hover:text-primary',
											isActive(item.href) ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
										)}
									>
										{tLabel(item.labelKey)}
									</a>
								{/if}
							{/snippet}
						</NavMegaMenu>
					{:else}
						<a
							href={item.href}
							class={cn(
								'rounded-full px-4 py-1.5 text-sm font-medium transition-colors hover:text-primary',
								isActive(item.href) ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
							)}
						>
							{tLabel(item.labelKey)}
						</a>
					{/if}
				{/each}
			</nav>

			<!-- Right controls -->
			<div class="flex items-center gap-1">
				<!-- Desktop: all inline -->
				<div class="hidden items-center gap-2 lg:flex">
					<LangSwitcher />
					<ThemeToggle />
					<UserNav {auth} />
				</div>

				<!-- Mobile: lang + theme + menu toggle -->
				<div class="flex items-center gap-1 lg:hidden">
					<LangSwitcher />
					<ThemeToggle />
					<button
						onclick={toggleMenu}
						aria-expanded={menuOpen}
						aria-label={menuOpen ? m.ui_close_menu() : m.ui_open_menu()}
						class="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
					>
						{#if menuOpen}
							<IconX class="size-5" data-icon="inline-start" />
						{:else}
							<IconMenu2 class="size-5" data-icon="inline-start" />
						{/if}
					</button>
				</div>
			</div>
		</div>

		<!-- ══Expandable menu (mobile only) ══-->
		{#if menuOpen}
			<div transition:slide={{ duration: 400, easing: quartInOut }}>
				<Separator class="mx-4" />

				<div class="px-5 pt-6 pb-5">
					<nav class="max-h-[70svh] overflow-y-auto" aria-label="Mobile navigation">
						<div class="flex flex-col">
							{#each navigationConfig.filter((i) => i.key !== 'nav_more') as item (item.key)}
								{@const mobileChildren = getMobileChildren(item)}
								<div>
									<!-- Top-level: click to expand accordion (if has children), else direct link -->
									{#if mobileChildren.length > 0}
										<div
											class="flex items-center justify-between rounded-lg transition-colors hover:bg-muted/50"
										>
											<a
												href={item.href}
												onclick={closeMenu}
												class={cn(
													'flex-1 px-3 py-2.5 text-sm font-medium transition-colors hover:text-foreground',
													isActive(item.href) ? 'text-primary' : 'text-muted-foreground'
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
														href={child.href}
														onclick={closeMenu}
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
											href={item.href}
											onclick={closeMenu}
											class={cn(
												'flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted/50 hover:text-foreground',
												isActive(item.href) ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
											)}
										>
											{tLabel(item.labelKey)}
										</a>
									{/if}
								</div>
							{/each}
						</div>

						<!-- Unrolled More Items -->
						{#if navigationConfig.find((i) => i.key === 'nav_more')?.children}
							<Separator class="my-2" />
							<div class="flex flex-wrap justify-between gap-1 px-1">
								{#each navigationConfig.find((i) => i.key === 'nav_more')!.children! as child (child.href)}
									<a
										href={child.href}
										onclick={closeMenu}
										class="rounded-lg px-2 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
									>
										{tLabel(child.labelKey!)}
									</a>
								{/each}
							</div>
						{/if}
					</nav>

					<!-- Bottom: user section -->
					<Separator class="mt-4" />
					<div class="pt-4">
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
									href="/admin"
									onclick={closeMenu}
									class="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
								>
									{m.nav_dashboard()}
								</a>
								<a
									href="/account"
									onclick={closeMenu}
									class="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
								>
									{m.nav_account()}
								</a>
							</div>
						{:else}
							<a
								href="/login?redirectTo={encodeURIComponent(page.url.pathname + page.url.search)}"
								onclick={closeMenu}
								class="flex items-center justify-center rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted/50"
							>
								{m.nav_sign_in()}
							</a>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>
</header>
