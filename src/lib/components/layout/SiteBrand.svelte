<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar';
	import OwnerStatusHoverCard from '$lib/components/layout/OwnerStatusHoverCard.svelte';
	import { firstGrapheme, type OwnerPresence } from '$lib/config/owner-presence';
	import type { SiteOwner } from '$lib/config/owner-status';
	import { siteHref } from '$lib/utils/href';

	let {
		owner,
		presence
	}: {
		owner: SiteOwner;
		presence: OwnerPresence;
	} = $props();

	// Q6: the compact label never replaces the full name in aria/title/hover.
	const visibleName = $derived(owner.headerLabel?.trim() || owner.name);
	const avatarFallback = $derived(firstGrapheme(owner.name));
</script>

<div class="flex min-w-0 shrink items-center gap-2.5">
	<a
		href={siteHref('/')}
		class="flex min-w-0 items-center gap-2"
		aria-label={owner.name}
		title={owner.name}
	>
		<Avatar.Root class="size-7 shrink-0 ring-2 ring-border">
			<Avatar.Image src={owner.avatar} alt="" />
			<Avatar.Fallback>{avatarFallback}</Avatar.Fallback>
		</Avatar.Root>
		<span
			data-slot="site-brand-name"
			class="hidden max-w-[7.5rem] truncate text-[17px] font-bold tracking-tight @min-[20rem]:inline-block"
		>
			{visibleName}
		</span>
	</a>
	<!-- D4/R-4: without live presence the ticket must not render at all. -->
	{#if presence.state !== 'unknown'}
		<OwnerStatusHoverCard ownerName={owner.name} {presence} />
	{/if}
</div>
