<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar';
	import OwnerStatusHoverCard from '$lib/components/layout/OwnerStatusHoverCard.svelte';
	import type { OwnerPresence } from '$lib/config/owner-presence';
	import type { SiteOwner } from '$lib/config/owner-status';
	import { siteHref } from '$lib/utils/href';

	let {
		owner,
		presence,
		enabled
	}: {
		owner: SiteOwner;
		presence: OwnerPresence;
		enabled: boolean;
	} = $props();
</script>

<div class="flex min-w-0 shrink items-center gap-2.5">
	<a href={siteHref('/')} class="flex min-w-0 items-center gap-2" aria-label={owner.name}>
		<Avatar.Root class="size-7 shrink-0 ring-2 ring-border">
			<Avatar.Image src={owner.avatar} alt="" />
			<Avatar.Fallback>{owner.name.slice(0, 1)}</Avatar.Fallback>
		</Avatar.Root>
		<span class="hidden max-w-[9rem] truncate text-[17px] font-bold tracking-tight sm:inline-block">
			{owner.name}
		</span>
	</a>
	<OwnerStatusHoverCard ownerName={owner.name} {presence} {enabled} />
</div>
