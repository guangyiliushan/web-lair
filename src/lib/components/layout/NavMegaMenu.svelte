<script lang="ts">
	import { cn } from '$lib/utils';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Badge } from '$lib/components/ui/badge';
	import {
		IconChevronRight,
		IconBrandTwitter,
		IconRss,
		IconMail,
		IconBrandGithub
	} from '@tabler/icons-svelte-runes';
	import {
		tLabel,
		type MegaMenu,
		type MegaMenuDynamicData,
		type NavChild
	} from '$lib/config/navigation.config';
	import type { Snippet } from 'svelte';
	import { portal } from '$lib/actions/portal';
	import { siteHref } from '$lib/utils/href';

	interface Props {
		menu: MegaMenu;
		open?: boolean;
		delay?: number;
		class?: string;
		serverData?: MegaMenuDynamicData | null;
		loading?: boolean;
		/** When true, trigger is a <button> — Enter/Space toggles the menu instead of navigating */
		triggerAsButton?: boolean;
		trigger: Snippet<[TriggerState]>;
	}

	interface TriggerState {
		props: {
			'aria-expanded': boolean;
			'aria-haspopup': boolean;
			id: string;
		};
		toggle: () => void;
	}

	let {
		menu,
		open = $bindable(false),
		delay = 150,
		class: className,
		serverData = null,
		loading = false,
		triggerAsButton = false,
		trigger
	}: Props = $props();

	const triggerId = $props.id();
	const menuId = `${triggerId}-menu`;

	let triggerEl = $state<HTMLElement | null>(null);
	let menuEl = $state<HTMLElement | null>(null);

	const menuWidth = $derived(menu.width ?? 'w-80');

	// ── Label resolver (supports literal labels from server data) ──
	function labelOf(child: NavChild): string {
		return child.label ?? tLabel(child.labelKey!);
	}

	// ── Dynamic items from server data (two-column only) ──
	const leftItems = $derived(serverData?.leftItems ?? menu.columns[0]?.items ?? []);
	const rightItems = $derived(serverData?.rightItems ?? menu.rightColumn?.items ?? []);
	const footerSecondary = $derived(serverData?.footerSecondaryText ?? null);
	const footerSecondaryHref = $derived(serverData?.footerSecondaryHref ?? null);
	// Pre-compute footer secondary label to avoid optional-chain issues in template
	const footerSecondaryLabel = $derived.by(() => {
		if (!footerSecondaryHref) return null;
		if (footerSecondary) return footerSecondary;
		const sec = menu.footer?.secondary;
		return sec?.labelKey ? tLabel(sec.labelKey) : '';
	});

	// ── Skeleton helpers ──
	const showSkeleton = $derived(loading && !serverData && menu.type === 'two-column');
	const showTimelineSkeleton = $derived(loading && !serverData && menu.type === 'timeline');
	const skeletonLeftSlots = [0, 1, 2, 3, 4];
	const skeletonRightSlots = [0, 1, 2, 3];

	// ── Timer management ──
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		return () => {
			if (closeTimer) {
				clearTimeout(closeTimer);
				closeTimer = null;
			}
		};
	});

	function handleEnter() {
		if (closeTimer) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
		open = true;
	}

	function handleLeave() {
		closeTimer = setTimeout(() => {
			open = false;
		}, delay);
	}

	// ── Outside click & Escape ──
	$effect(() => {
		if (!open) return;

		function handleClick(e: MouseEvent) {
			const target = e.target as Node;
			if (triggerEl?.contains(target) || menuEl?.contains(target)) return;
			open = false;
		}

		function handleKeydown(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				e.preventDefault();
				open = false;
				triggerEl?.focus();
			}
		}

		document.addEventListener('click', handleClick, true);
		document.addEventListener('keydown', handleKeydown, true);

		return () => {
			document.removeEventListener('click', handleClick, true);
			document.removeEventListener('keydown', handleKeydown, true);
		};
	});

	// ── Dynamic Positioning ──
	let coords = $state({ top: 0, left: 0 });

	function updatePosition() {
		if (!triggerEl || !open) return;
		const rect = triggerEl.getBoundingClientRect();
		coords = {
			// Place just below the trigger (plus a tiny gap)
			top: rect.bottom + 8,
			// Center horizontally relative to the trigger
			left: rect.left + rect.width / 2
		};
	}

	// Update position when opened or when window resizes/scrolls
	$effect(() => {
		if (open) {
			updatePosition();
			window.addEventListener('resize', updatePosition);
			window.addEventListener('scroll', updatePosition, true);
			return () => {
				window.removeEventListener('resize', updatePosition);
				window.removeEventListener('scroll', updatePosition, true);
			};
		}
	});

	// ── Focus management ──
	$effect(() => {
		if (open && menuEl) {
			queueMicrotask(() => {
				const first = menuEl?.querySelector<HTMLElement>('[role="menuitem"]');
				first?.focus();
			});
		}
	});

	// ── Keyboard handlers ──
	function handleTriggerKeydown(e: KeyboardEvent) {
		switch (e.key) {
			case 'Enter':
			case ' ':
				if (triggerAsButton) {
					e.preventDefault();
					open = !open;
				}
				// For <a> triggers, let the browser navigate naturally
				break;
			case 'ArrowDown':
				e.preventDefault();
				open = true;
				break;
			case 'Escape':
				if (open) {
					e.preventDefault();
					open = false;
				}
				break;
		}
	}

	function handleMenuKeydown(e: KeyboardEvent) {
		const items = Array.from(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
		const idx = items.indexOf(document.activeElement as HTMLElement);

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				items[(idx + 1) % items.length]?.focus();
				break;
			case 'ArrowUp':
				e.preventDefault();
				items[(idx - 1 + items.length) % items.length]?.focus();
				break;
			case 'Escape':
				e.preventDefault();
				open = false;
				triggerEl?.focus();
				break;
		}
	}

	const triggerState: TriggerState = {
		props: {
			'aria-expanded': open,
			'aria-haspopup': true,
			id: triggerId
		},
		toggle: () => (open = !open)
	};
</script>

<div
	bind:this={triggerEl}
	class={cn('relative inline-block', className)}
	onmouseenter={handleEnter}
	onmouseleave={handleLeave}
	role="none"
	onkeydown={handleTriggerKeydown}
>
	{@render trigger(triggerState)}
</div>

<!-- Render panel via portal so it lives completely outside the Header -->
{#if open}
	<div
		use:portal
		bind:this={menuEl}
		id={menuId}
		role="menu"
		aria-labelledby={triggerId}
		tabindex="-1"
		class={cn(
			'fixed z-100 -translate-x-1/2 animate-in pt-2 transition-all duration-200 ease-out zoom-in-95 fade-in',
			menuWidth
		)}
		style:top={`${coords.top}px`}
		style:left={`${coords.left}px`}
		onmouseenter={handleEnter}
		onmouseleave={handleLeave}
		onkeydown={handleMenuKeydown}
	>
		<div class="rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl">
			{#if menu.type === 'home'}
				<!-- Home Layout (Profile + Links) -->
				<div class="flex gap-6 p-2">
					<!-- Profile Side -->
					<div class="flex w-40 flex-col gap-4">
						<div class="flex items-center gap-3">
							<div class="size-10 overflow-hidden rounded-full bg-muted">
								<img
									src="https://github.com/guangyiliushan.png"
									alt="Avatar"
									class="h-full w-full object-cover"
								/>
							</div>
							<div>
								<div class="font-bold">Lair</div>
								<div class="flex items-center gap-1 text-xs text-green-500">
									<span class="size-1.5 rounded-full bg-green-500"></span>
									Online now
								</div>
							</div>
						</div>
						<div class="flex justify-between text-xs">
							<div class="flex flex-col">
								<span class="font-bold text-foreground">369</span>
								<span class="text-muted-foreground uppercase">Posts</span>
							</div>
							<div class="flex flex-col">
								<span class="font-bold text-foreground">1419</span>
								<span class="text-muted-foreground uppercase">K Words</span>
							</div>
							<div class="flex flex-col">
								<span class="font-bold text-foreground">2849</span>
								<span class="text-muted-foreground uppercase">Days</span>
							</div>
						</div>
						<Separator />
						<div class="flex gap-3 text-muted-foreground">
							<a
								href="https://twitter.com/guangyiliushan"
								class="hover:text-foreground"
								aria-label="Twitter"><IconBrandTwitter class="size-4" /></a
							>
							<a href={siteHref('/rss.xml')} class="hover:text-foreground" aria-label="RSS"
								><IconRss class="size-4" /></a
							>
							<a
								href="mailto:guangyiliushan@example.com"
								class="hover:text-foreground"
								aria-label="Email"><IconMail class="size-4" /></a
							>
							<a
								href="https://github.com/guangyiliushan"
								class="hover:text-foreground"
								aria-label="GitHub"><IconBrandGithub class="size-4" /></a
							>
						</div>
					</div>
					<!-- Links Side -->
					<div class="flex-1 border-l pl-6">
						<div class="grid grid-cols-2 gap-x-4 gap-y-2">
							{#each menu.columns[0].items as child (child.href)}
								<a
									href={siteHref(child.href)}
									role="menuitem"
									class="rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
								>
									{labelOf(child)}
								</a>
							{/each}
						</div>
					</div>
				</div>
			{:else if menu.type === 'two-column'}
				<!-- Two Column Layout (Categories/Series + Recent Posts/Notes) -->
				{#if showSkeleton}
					<!-- Skeleton Loading State -->
					<div class="flex gap-4">
						<div class="w-40 flex-col gap-1">
							{#each menu.columns as column, i (i)}
								{#if column.titleKey}
									<Skeleton class="mb-2 h-3 w-14" />
								{/if}
								<div class="flex flex-col gap-0.5">
									{#each skeletonLeftSlots as i (i)}
										<Skeleton class="h-8 rounded-lg" />
									{/each}
								</div>
							{/each}
						</div>
						<div class="flex-1 border-l pl-4">
							{#if menu.rightColumn?.titleKey}
								<Skeleton class="mb-2 h-3 w-20" />
							{/if}
							<div class="flex flex-col gap-2">
								{#each skeletonRightSlots as i (i)}
									<div class="rounded-lg border border-transparent px-3 py-2.5">
										<Skeleton class="mb-1.5 h-4 w-3/4" />
										<Skeleton class="h-3 w-1/3" />
									</div>
								{/each}
							</div>
						</div>
					</div>
				{:else}
					<div class="flex gap-4">
						<!-- Left Column -->
						<div class="w-40 flex-col gap-1">
							{#each menu.columns as column, i (i)}
								{#if column.titleKey}
									<p
										class="mb-2 px-2 text-xs font-medium tracking-wider text-muted-foreground uppercase"
									>
										{tLabel(column.titleKey)}
									</p>
								{/if}
								<div class="flex flex-col gap-0.5" role="group">
									{#each leftItems as child (child.href)}
										<a
											href={siteHref(child.href)}
											role="menuitem"
											class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
										>
											{#if child.imageUrl}
												<img
													src={child.imageUrl}
													alt=""
													class="size-4 shrink-0 rounded object-cover"
												/>
											{:else if child.icon}
												<child.icon class="size-4 shrink-0 text-muted-foreground" />
											{/if}
											<span class="truncate">{labelOf(child)}</span>
											{#if child.badge}
												<Badge variant="secondary" class="ml-auto">{child.badge}</Badge>
											{/if}
										</a>
									{/each}
								</div>
							{/each}
						</div>
						<!-- Right Column (Recent Items) -->
						<div class="min-w-0 flex-1 border-l pl-4">
							{#if menu.rightColumn?.titleKey}
								<p
									class="mb-2 px-2 text-xs font-medium tracking-wider text-muted-foreground uppercase"
								>
									{tLabel(menu.rightColumn.titleKey)}
								</p>
							{/if}
							<div class="flex flex-col gap-2">
								{#each rightItems as child (child.href)}
									<a
										href={siteHref(child.href)}
										role="menuitem"
										class="block min-w-0 rounded-lg border border-transparent bg-muted/30 px-3 py-2.5 transition-colors hover:border-border hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
									>
										<div class="min-w-0 truncate text-sm leading-snug font-medium">
											{labelOf(child)}
										</div>
										{#if child.desc || child.descKey}
											<div class="mt-0.5 text-xs text-muted-foreground">
												{child.desc ?? tLabel(child.descKey!)}
											</div>
										{/if}
									</a>
								{/each}
							</div>
						</div>
					</div>
				{/if}
			{:else if menu.type === 'timeline'}
				<!-- Timeline Layout (Filter tabs + Recent Activity) -->
				{#if showTimelineSkeleton}
					<!-- Skeleton Loading State -->
					<div class="animate-pulse">
						<div class="flex gap-1">
							{#each skeletonLeftSlots.slice(0, 3) as i (i)}
								<div class="h-9 flex-1 rounded bg-muted"></div>
							{/each}
						</div>
						<div class="mt-2 border-t pt-2">
							<div class="mb-1.5 h-3 w-24 rounded bg-muted"></div>
							<div class="flex flex-col gap-1">
								{#each skeletonRightSlots as i (i)}
									<div class="rounded bg-muted/50 px-2.5 py-2">
										<div class="mb-1 h-4 w-3/4 rounded bg-muted"></div>
										<div class="h-3 w-1/4 rounded bg-muted"></div>
									</div>
								{/each}
							</div>
						</div>
					</div>
				{:else}
					<!-- Filter tabs -->
					<div class="flex gap-1">
						{#each menu.columns[0].items as child (child.href)}
							<a
								href={siteHref(child.href)}
								role="menuitem"
								class="flex flex-1 items-center justify-center gap-2 rounded px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
							>
								{#if child.icon}
									<span
										class="flex shrink-0 items-center justify-center opacity-70"
										aria-hidden="true"
									>
										<child.icon class="size-4" />
									</span>
								{/if}
								<span>{labelOf(child)}</span>
							</a>
						{/each}
					</div>
					<!-- Recent Activity -->
					{#if serverData?.timelineItems && serverData.timelineItems.length > 0}
						<div class="mt-2 border-t pt-2">
							<div
								class="mb-1.5 px-1 text-xs font-medium tracking-wider text-muted-foreground uppercase"
							>
								{tLabel('nav_timeline_recent')}
							</div>
							<div class="flex flex-col gap-1">
								{#each serverData.timelineItems as item (item.href)}
									{@const typeKey =
										item.type === 'posts'
											? ('nav_timeline_posts' as const)
											: item.type === 'notes'
												? ('nav_timeline_notes' as const)
												: ('nav_timeline_memories' as const)}
									<a
										href={siteHref(item.href)}
										role="menuitem"
										class="rounded bg-muted/30 px-2.5 py-2 transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
									>
										<div class="flex items-center justify-between gap-2">
											<div class="min-w-0 truncate text-sm leading-snug">{item.title}</div>
											<span class="ml-2 shrink-0 text-xs text-muted-foreground"
												>{tLabel(typeKey)}</span
											>
										</div>
										<div class="mt-0.5 text-xs text-muted-foreground">{item.date}</div>
									</a>
								{/each}
							</div>
						</div>
					{/if}
				{/if}
			{:else}
				<!-- Simple List Layout -->
				{#each menu.columns as column, i (i)}
					{#if column.titleKey}
						<p class="mb-2 px-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
							{tLabel(column.titleKey)}
						</p>
					{/if}
					<div
						class="flex flex-col gap-0.5"
						role="group"
						aria-label={column.titleKey ? tLabel(column.titleKey) : undefined}
					>
						{#each column.items as child (child.href)}
							<a
								href={siteHref(child.href)}
								role="menuitem"
								class="flex items-start gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
							>
								{#if child.icon}
									<span
										class="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground"
										aria-hidden="true"
									>
										<child.icon class="size-4" />
									</span>
								{/if}
								<div class="min-w-0 flex-1">
									<div class="flex items-center justify-between gap-2">
										<span class="truncate font-medium">{labelOf(child)}</span>
										{#if child.badge}
											<Badge variant="secondary">{child.badge}</Badge>
										{/if}
									</div>
									{#if child.desc || child.descKey}
										<p class="mt-0.5 text-xs text-muted-foreground">
											{child.desc ?? tLabel(child.descKey!)}
										</p>
									{/if}
								</div>
							</a>
						{/each}
					</div>
					{#if i < menu.columns.length - 1}
						<Separator class="my-2" role="separator" />
					{/if}
				{/each}
			{/if}

			<!-- Footer -->
			{#if menu.footer}
				<Separator class="my-2" role="separator" />
				<div class="flex items-center justify-between px-2.5 py-1">
					<a
						href={siteHref(menu.footer.href)}
						role="menuitem"
						class="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						{tLabel(menu.footer.labelKey)}
						<IconChevronRight class="size-3" aria-hidden="true" />
					</a>
					{#if footerSecondaryHref}
						<a
							href={siteHref(footerSecondaryHref)}
							role="menuitem"
							class="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						>
							{footerSecondaryLabel}
						</a>
					{:else if footerSecondary}
						<span class="text-xs text-muted-foreground">{footerSecondary}</span>
					{:else if menu.footer.secondary}
						<a
							href={siteHref(menu.footer.secondary.href)}
							role="menuitem"
							class="text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						>
							{tLabel(menu.footer.secondary.labelKey)}
						</a>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
