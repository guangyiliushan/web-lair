<script lang="ts">
	// Root and Trigger come straight from bits-ui rather than the vendored
	// wrappers: `ui/navigation-menu/navigation-menu.svelte` always renders a
	// nested `<nav>` (duplicate landmark under Header's own nav) and
	// `navigation-menu-trigger.svelte` hard-codes a chevron + pill style that
	// would restyle Header's plain nav links. Everything else uses the
	// vendored set.
	import { NavigationMenu as NavigationMenuPrimitive } from 'bits-ui';
	import * as NavigationMenu from '$lib/components/ui/navigation-menu';
	import { cn } from '$lib/utils';
	import { navIcon } from '$lib/config/nav-icons';
	import { NAV_PANEL_HEIGHT } from './nav-menu/geometry';
	import {
		tLabel,
		type NavChild,
		type NavMenuConfig,
		type NavMenuData
	} from '$lib/config/navigation.config';
	import type { Snippet } from 'svelte';
	import type { OwnerStatus, SiteOwner } from '$lib/config/owner-status';
	import NavMenuHomeContent from './nav-menu/NavMenuHomeContent.svelte';
	import NavMenuTwoColumnContent from './nav-menu/NavMenuTwoColumnContent.svelte';
	import NavMenuSimpleContent from './nav-menu/NavMenuSimpleContent.svelte';

	interface TriggerState {
		props: Record<string, unknown>;
		toggle: () => void;
	}

	interface Props {
		menu: NavMenuConfig;
		/**
		 * Force the panel open. Header leaves this alone (hover/keyboard own the
		 * state); Storybook pins it so the panels can be reviewed side by side.
		 */
		open?: boolean;
		class?: string;
		serverData?: NavMenuData | null;
		/**
		 * True when the trigger is a <button> (no real href): Enter/Space toggles
		 * the panel. When false the trigger is a link and must navigate — the
		 * panel closes instead of toggling, so a keyboard Enter cannot fire both.
		 */
		triggerAsButton?: boolean;
		/**
		 * Render row skeletons instead of content. Kept separate from "no data":
		 * an empty column gets a placeholder, a loading one gets height-preserving
		 * bars so the panel never collapses mid-fetch.
		 */
		loading?: boolean;
		/** Home panel identity block; ignored by every other layout. */
		owner?: SiteOwner;
		ownerStatus?: OwnerStatus;
		trigger: Snippet<[TriggerState]>;
	}

	let {
		menu,
		open: forceOpen = false,
		class: className,
		serverData = null,
		triggerAsButton = false,
		loading = false,
		owner,
		ownerStatus,
		trigger
	}: Props = $props();

	const itemValue = $props.id();

	let open = $state('');
	let panelEl = $state<HTMLElement | null>(null);
	/** Horizontal correction so a wide panel cannot hang off the viewport edge. */
	let shiftX = $state(0);
	/** Gap between the trigger row and the panel; widened to clear the header bar. */
	let panelPadTop = $state(4);

	const isOpen = $derived(open === itemValue);

	// One-way pin: forcing it open is for static review only.
	$effect(() => {
		if (forceOpen) open = itemValue;
	});

	// The timeline's left column is the static filter list: those rows carry
	// `icon: Component`, so they cannot come back from the loader. Falling back
	// to the configured column is harmless for posts/notes — theirs is empty.
	const leftItems = $derived(
		serverData?.leftItems?.length ? serverData.leftItems : (menu.columns[0]?.items ?? [])
	);
	const rightItems = $derived(serverData?.rightItems ?? []);
	const footerMeta = $derived(serverData?.footerSecondaryText ?? undefined);

	const statRows = $derived([
		{ label: tLabel('nav_home_stat_posts'), value: serverData?.stats?.posts ?? 0 },
		{ label: tLabel('nav_home_stat_notes'), value: serverData?.stats?.notes ?? 0 },
		{ label: tLabel('nav_home_stat_topics'), value: serverData?.stats?.topics ?? 0 }
	]);

	const social = $derived(
		(menu.columns[0]?.items ?? []).map((child: NavChild) => ({
			href: child.href,
			label: child.label ?? tLabel(child.labelKey!),
			icon: child.icon ?? navIcon(child.iconName) ?? undefined
		}))
	);

	// ── Collision clamp ──
	//
	// bits-ui's NavigationMenu positions Content by CSS only (no floating-ui
	// middleware in the installed build), so the panel is left to its own
	// `translate-x-1/2` and would hang off the edge near the right of the bar.
	// Measure once the panel is mounted and correct.
	$effect(() => {
		if (!isOpen || !panelEl) {
			shiftX = 0;
			return;
		}
		const measure = () => {
			if (!panelEl) return;
			const rect = panelEl.getBoundingClientRect();
			// Undo the correction already applied so resize/scroll re-measures
			// the unclamped position instead of chasing its own tail.
			const left = rect.left - shiftX;
			const right = rect.right - shiftX;
			const margin = 12;
			let shift = 0;
			if (left < margin) shift = margin - left;
			else if (right > window.innerWidth - margin) shift = window.innerWidth - margin - right;
			shiftX = shift;
		};
		const raf = requestAnimationFrame(measure);
		window.addEventListener('resize', measure);
		window.addEventListener('scroll', measure, true);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', measure);
			window.removeEventListener('scroll', measure, true);
		};
	});

	// ── Vertical anchor ──
	//
	// Content is pinned to `top-full` of the nav item, and that item sits
	// inside the header bar: the panel would start mid-bar and cover the bar's
	// bottom padding and border. Measure the bar and push the panel below it.
	//
	// The offset is spent as padding on the panel's wrapper, never a transform,
	// so the gap stays inside the Content element's hover area — a transform
	// would leave a dead strip the pointer has to cross, tripping the
	// close timer on the way from the trigger into the panel.
	//
	// The item and the bar are unmounted from the Content's mount animation,
	// so their rects read steady values (the panel's own rect does not).
	const PANEL_GAP = 8;
	const PANEL_PAD_MIN = 4;

	$effect(() => {
		if (!isOpen || !panelEl) {
			panelPadTop = PANEL_PAD_MIN;
			return;
		}

		const measure = () => {
			if (!panelEl) return;
			const bar = panelEl.closest<HTMLElement>('[data-slot="site-header-bar"]');
			const item = panelEl.closest<HTMLElement>('[data-slot="navigation-menu-item"]');
			panelPadTop =
				bar && item
					? Math.max(
							PANEL_PAD_MIN,
							Math.round(
								bar.getBoundingClientRect().bottom + PANEL_GAP - item.getBoundingClientRect().bottom
							)
						)
					: PANEL_PAD_MIN;
		};

		measure();
		window.addEventListener('resize', measure);
		return () => window.removeEventListener('resize', measure);
	});

	function close() {
		open = '';
	}

	/**
	 * A linked trigger navigates. bits-ui's own click handler toggles, which
	 * would fire alongside the anchor's navigation on keyboard Enter, so it is
	 * replaced: click/Enter close the panel and let the link through.
	 */
	function mapTriggerProps(bitsProps: Record<string, unknown>): TriggerState {
		const props: Record<string, unknown> = {
			...bitsProps,
			'aria-haspopup': true
		};
		if (!triggerAsButton) {
			props.onclick = close;
			props.onkeydown = (event: KeyboardEvent) => {
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					open = itemValue;
					return;
				}
				if (event.key === 'Escape') {
					close();
				}
				// Enter/Space fall through to the anchor.
			};
		}
		return { props, toggle: () => (open = isOpen ? '' : itemValue) };
	}
</script>

<NavigationMenuPrimitive.Root
	bind:value={open}
	orientation="horizontal"
	delayDuration={200}
	skipDelayDuration={300}
>
	{#snippet child({ props: rootProps })}
		<div {...rootProps} aria-label={undefined} class={cn('relative inline-block', className)}>
			<NavigationMenu.List>
				<NavigationMenu.Item value={itemValue} openOnHover>
					<NavigationMenuPrimitive.Trigger>
						{#snippet child({ props: triggerProps })}
							{@render trigger(mapTriggerProps(triggerProps))}
						{/snippet}
					</NavigationMenuPrimitive.Trigger>

					<NavigationMenu.Content
						class={cn(
							// `md:w-max` is load-bearing: the vendored content class ends in
							// `md:absolute md:w-auto`, and a media-query rule outranks the
							// unprefixed `w-[520px]` below it — the panel would collapse to
							// content width and its `1fr` column to nothing on every
							// desktop viewport. Width now lives on the panel div instead.
							'absolute top-full left-1/2 z-50 w-max max-w-[calc(100vw-24px)] -translate-x-1/2 p-0',
							'md:w-max',
							'group-data-[viewport=false]/navigation-menu:top-full',
							'group-data-[viewport=false]/navigation-menu:mt-0',
							'group-data-[viewport=false]/navigation-menu:overflow-visible',
							'group-data-[viewport=false]/navigation-menu:rounded-none',
							'group-data-[viewport=false]/navigation-menu:bg-transparent',
							'group-data-[viewport=false]/navigation-menu:shadow-none',
							'group-data-[viewport=false]/navigation-menu:ring-0',
							'group-data-[viewport=false]/navigation-menu:p-0'
						)}
					>
						<!-- Clamp correction lives here: `style:` is not valid on a
						     component, and Content owns the centreing transform.
						     `padding-top` doubles as the hover bridge to the bar. -->
						<div
							style:padding-top={`${panelPadTop}px`}
							style:transform={shiftX ? `translateX(${shiftX}px)` : undefined}
						>
							<div
								bind:this={panelEl}
								data-slot="nav-menu-panel"
								style:min-height={`${NAV_PANEL_HEIGHT}px`}
								class={cn(
									// Column flex: the panel height is fixed (geometry.ts), so the
									// content block has to claim the slack instead of leaving a
									// dead band under the footer.
									'flex flex-col overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg',
									menu.width ?? 'w-80'
								)}
							>
								{#if menu.type === 'home'}
									<NavMenuHomeContent
										{loading}
										owner={owner ?? { name: '', avatar: '' }}
										status={ownerStatus ?? {
											enabled: false,
											kind: 'idle',
											detail: '',
											iconUrl: '',
											href: ''
										}}
										stats={statRows}
										{social}
										titleKey={menu.columns[0]?.titleKey}
										items={leftItems}
									/>
								{:else if menu.type === 'two-column'}
									<NavMenuTwoColumnContent
										{loading}
										leftTitleKey={menu.columns[0]?.titleKey}
										{leftItems}
										rightTitleKey={menu.rightColumn?.titleKey}
										{rightItems}
										footer={menu.footer}
										{footerMeta}
									/>
								{:else}
									<NavMenuSimpleContent
										columns={menu.columns}
										footer={menu.footer}
										{footerMeta}
										{loading}
									/>
								{/if}
							</div>
						</div>
					</NavigationMenu.Content>
				</NavigationMenu.Item>
			</NavigationMenu.List>
		</div>
	{/snippet}
</NavigationMenuPrimitive.Root>
