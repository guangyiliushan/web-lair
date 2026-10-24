<script lang="ts">
	import * as HoverCard from '$lib/components/ui/hover-card';
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';
	import { ownerNameTier, type OwnerPresence } from '$lib/config/owner-presence';
	import StatusTicket from './StatusTicket.svelte';
	import OwnerStatusCard from './OwnerStatusCard.svelte';

	let {
		ownerName,
		presence,
		enabled = true,
		open = $bindable(false)
	}: {
		ownerName: string;
		presence: OwnerPresence;
		enabled?: boolean;
		/** Storybook/testing hook; normal header usage leaves it alone. */
		open?: boolean;
	} = $props();

	const tier = $derived(ownerNameTier(ownerName));
	const online = $derived(presence.state === 'online');
	const canShowApp = $derived(
		presence.state !== 'unknown' && tier !== 'long' && presence.app !== null
	);
	const showTrigger = $derived(enabled && (online || canShowApp));
	const canRevealAppName = $derived(tier === 'short' && online && presence.app !== null);

	let triggerEl = $state<HTMLButtonElement | null>(null);
	let measureEl = $state<HTMLSpanElement | null>(null);
	let appNameFits = $state(false);

	$effect(() => {
		if (!canRevealAppName || triggerEl === null || measureEl === null) {
			appNameFits = false;
			return;
		}

		const trigger = triggerEl;
		const measure = measureEl;
		let frame = 0;

		const measureNow = (): void => {
			const nav = trigger
				.closest('header')
				?.querySelector<HTMLElement>('nav[aria-label="Main navigation"]');
			const navRect = nav && nav.getClientRects().length > 0 ? nav.getBoundingClientRect() : null;
			const bar = trigger.closest<HTMLElement>('[data-slot="site-header-bar"]');
			const boundary = navRect?.left ?? bar?.getBoundingClientRect().right ?? window.innerWidth;
			const available = boundary - trigger.getBoundingClientRect().right - 12;
			appNameFits = available >= measure.scrollWidth + 8;
		};

		const schedule = (): void => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measureNow);
		};

		const observer = new ResizeObserver(schedule);
		observer.observe(trigger);
		const bar = trigger.closest<HTMLElement>('[data-slot="site-header-bar"]');
		if (bar) observer.observe(bar);
		const nav = trigger
			.closest('header')
			?.querySelector<HTMLElement>('nav[aria-label="Main navigation"]');
		if (nav) observer.observe(nav);
		document.fonts?.ready.then(schedule).catch(() => {});
		schedule();

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	});

	const stateLabel = $derived(
		presence.state === 'online'
			? presence.activity === 'idle'
				? `${m.owner_status_online()} · ${m.owner_status_idle()}`
				: m.owner_status_online()
			: presence.state === 'offline'
				? m.owner_status_offline()
				: m.owner_status_unknown()
	);
	const appLabel = $derived(
		presence.state === 'online' ? m.owner_status_using() : m.owner_status_last_used()
	);
	const ariaLabel = $derived(
		presence.app && presence.state !== 'unknown'
			? `${ownerName}, ${stateLabel}, ${appLabel} ${presence.app.name}`
			: `${ownerName}, ${stateLabel}`
	);
</script>

{#if showTrigger}
	<HoverCard.Root bind:open openDelay={140} closeDelay={240}>
		<HoverCard.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					bind:this={triggerEl}
					type="button"
					class={cn(
						'group/status relative flex h-8 max-w-[11rem] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50',
						!canShowApp && 'w-6 justify-center px-0'
					)}
					aria-label={ariaLabel}
					data-slot="owner-status-trigger"
					data-state={presence.state}
				>
					<StatusTicket
						{presence}
						showAppIcon={canShowApp}
						showInlineName={appNameFits && canRevealAppName}
					/>

					{#if canRevealAppName}
						<span
							bind:this={measureEl}
							class="pointer-events-none invisible absolute top-0 left-0 text-[11px] leading-none font-medium whitespace-nowrap"
							aria-hidden="true"
						>
							{presence.app?.name}
						</span>
					{/if}
				</button>
			{/snippet}
		</HoverCard.Trigger>

		<HoverCard.Content
			side="bottom"
			align="start"
			sideOffset={10}
			class="z-[60] w-[19rem] max-w-[calc(100vw-2rem)] bg-transparent p-0 shadow-none ring-0"
		>
			<OwnerStatusCard {presence} {ownerName} />
		</HoverCard.Content>
	</HoverCard.Root>
{/if}
