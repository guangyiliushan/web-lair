<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';
	import OwnerAppIcon from './OwnerAppIcon.svelte';
	import type { OwnerPresence } from '$lib/config/owner-presence';

	let {
		presence,
		ownerName
	}: {
		presence: OwnerPresence;
		ownerName: string;
	} = $props();

	const statusLabel = $derived(
		presence.state === 'online'
			? presence.activity === 'idle'
				? `${m.owner_status_online()} · ${m.owner_status_idle()}`
				: m.owner_status_online()
			: presence.state === 'offline'
				? m.owner_status_offline()
				: m.owner_status_unknown()
	);

	const detailLabel = $derived(
		presence.state === 'offline' ? m.owner_status_last_used() : m.owner_status_using()
	);
	const showApp = $derived(presence.app !== null && presence.state !== 'unknown');
	const noActivity = $derived(presence.state === 'online' && presence.app === null);
</script>

<Card.Root size="sm" class="w-full border-0 bg-popover shadow-none" data-slot="owner-status-card">
	<Card.Header class="flex flex-row items-center justify-between gap-3">
		<span class="text-[10px] font-medium tracking-[0.24em] text-muted-foreground uppercase">
			{m.owner_status_live_desk()}
		</span>
		<Badge variant="outline" class="h-5 gap-1.5 px-2 py-0 text-[11px]">
			<span
				class={cn(
					'size-1.5 shrink-0 rounded-full',
					presence.state === 'online'
						? 'bg-emerald-500'
						: presence.state === 'offline'
							? 'bg-muted-foreground/50'
							: 'border border-muted-foreground/50'
				)}
				aria-hidden="true"
			></span>
			{statusLabel}
		</Badge>
	</Card.Header>

	<Card.Content class="min-w-0">
		{#if showApp && presence.app}
			<div class="flex min-w-0 items-center gap-3">
				<OwnerAppIcon app={presence.app} size={40} muted={presence.state === 'offline'} />
				<div class="flex min-w-0 flex-1 flex-col">
					<span class="text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
						{detailLabel}
					</span>
					<span
						class="mt-1.5 truncate text-sm leading-snug font-medium text-foreground"
						title={presence.app.name}
					>
						{presence.app.name}
					</span>
				</div>
			</div>
		{:else if noActivity}
			<p class="text-xs leading-relaxed text-muted-foreground">
				{m.owner_status_no_activity()}
			</p>
		{:else}
			<p class="text-xs leading-relaxed text-muted-foreground">
				{m.owner_status_unknown()}
			</p>
		{/if}
	</Card.Content>

	<Card.Footer class="gap-2 text-[11px] text-muted-foreground">
		<span class="min-w-0 truncate" title={ownerName}>{ownerName}</span>
	</Card.Footer>
</Card.Root>
