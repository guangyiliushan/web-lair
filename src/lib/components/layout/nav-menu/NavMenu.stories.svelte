<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import NavMenu from '$lib/components/layout/NavMenu.svelte';
	import { OWNER_STATUS_DEFAULT, SITE_OWNER_DEFAULT } from '$lib/config/owner-status';
	import {
		emptyData,
		homeData,
		homeMenu,
		longTitleData,
		notesData,
		notesMenu,
		postsData,
		postsMenu
	} from './fixtures';

	const { Story } = defineMeta({
		title: 'Layout/NavMenu',
		component: NavMenu,
		parameters: {
			// The panels hang below their trigger, so the canvas needs room.
			layout: 'padded'
		}
	});
</script>

<script lang="ts">
	import type { ComponentProps } from 'svelte';

	const triggerClass =
		'rounded-full px-4 py-1.5 text-sm font-medium text-muted-foreground hover:text-primary-text';
	const identity = {
		owner: SITE_OWNER_DEFAULT,
		ownerStatus: OWNER_STATUS_DEFAULT
	};
</script>

<!--
	Regression net for the nav panels. `open` is pinned so the panel renders
	without a hover; the fixtures mock the data contract only, so they survive
	render-layer changes. Light/dark comes from the Storybook toolbar.
-->
{#snippet template(args: ComponentProps<typeof NavMenu>)}
	<div class="min-h-48 pt-3">
		<NavMenu
			menu={args.menu}
			open={args.open}
			class={args.class}
			serverData={args.serverData}
			triggerAsButton={args.triggerAsButton}
			owner={args.owner}
			ownerStatus={args.ownerStatus}
		>
			{#snippet trigger({ props }: { props: Record<string, unknown> })}
				<button {...props} class={triggerClass} type="button">Menu</button>
			{/snippet}
		</NavMenu>
	</div>
{/snippet}

<Story
	name="Home"
	args={{ menu: homeMenu, serverData: homeData, open: true, ...identity }}
	{template}
/>

<!-- Away: the identity row keeps the name and drops the online light. -->
<Story
	name="Home / owner away"
	args={{
		menu: homeMenu,
		serverData: homeData,
		open: true,
		owner: SITE_OWNER_DEFAULT,
		ownerStatus: { ...OWNER_STATUS_DEFAULT, kind: 'idle' }
	}}
	{template}
/>

<Story
	name="Posts"
	args={{ menu: postsMenu, serverData: postsData, open: true, triggerAsButton: true, ...identity }}
	{template}
/>

<Story
	name="Notes"
	args={{ menu: notesMenu, serverData: notesData, open: true, triggerAsButton: true, ...identity }}
	{template}
/>

<!-- Edge case: mixed-script titles must truncate inside their own columns. -->
<Story
	name="Notes / long titles"
	args={{
		menu: notesMenu,
		serverData: longTitleData,
		open: true,
		triggerAsButton: true,
		...identity
	}}
	{template}
/>

<!-- Edge case: server data has not resolved — the panel must still lay out. -->
<Story
	name="Posts / no data"
	args={{ menu: postsMenu, serverData: emptyData, open: true, triggerAsButton: true, ...identity }}
	{template}
/>

<!-- Loading: row skeletons hold the panel's height instead of collapsing. -->
<Story
	name="Posts / loading"
	args={{
		menu: postsMenu,
		serverData: emptyData,
		open: true,
		loading: true,
		triggerAsButton: true,
		...identity
	}}
	{template}
/>

<Story
	name="Notes / loading"
	args={{
		menu: notesMenu,
		serverData: emptyData,
		open: true,
		loading: true,
		triggerAsButton: true,
		...identity
	}}
	{template}
/>
