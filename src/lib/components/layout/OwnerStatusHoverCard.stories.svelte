<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import OwnerStatusHoverCard from './OwnerStatusHoverCard.svelte';

	const { Story } = defineMeta({
		title: 'Layout/OwnerStatus',
		component: OwnerStatusHoverCard,
		parameters: {
			layout: 'padded'
		}
	});
</script>

<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import type { OwnerPresence } from '$lib/config/owner-presence';

	const online: OwnerPresence = {
		state: 'online',
		activity: 'coding',
		app: { name: 'Visual Studio Code', icon: '' },
		updatedAt: null,
		lastSeenAt: null
	};

	const offline: OwnerPresence = {
		...online,
		state: 'offline'
	};
</script>

{#snippet template(args: ComponentProps<typeof OwnerStatusHoverCard>)}
	<div class="flex min-h-48 items-start p-4">
		<OwnerStatusHoverCard {...args} />
	</div>
{/snippet}

<Story
	name="Short / online"
	args={{ ownerName: 'Lair', presence: online, open: true }}
	{template}
/>

<Story
	name="Medium / online"
	args={{ ownerName: 'Web Lair', presence: online, open: true }}
	{template}
/>

<Story
	name="Long / online"
	args={{ ownerName: 'guangyiliushan', presence: online, open: true }}
	{template}
/>

<Story
	name="Short / offline"
	args={{ ownerName: 'Lair', presence: offline, open: true }}
	{template}
/>
