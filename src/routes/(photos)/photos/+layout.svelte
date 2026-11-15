<script lang="ts">
	import PhotosHeader from '$lib/components/photos/PhotosHeader.svelte';
	import Footer from '$lib/components/layout/Footer.svelte';
	import { PresenceHeartbeat } from '$lib/components/presence';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { setPhotosUi } from '$lib/components/photos/photos-ui.svelte';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();

	setPhotosUi();
</script>

<svelte:head>
	<link rel="alternate" type="application/rss+xml" href={localizeHref('/rss.xml')} />
</svelte:head>

<div class="flex min-h-screen flex-col selection:bg-primary/30">
	<PhotosHeader
		auth={data.auth}
		owner={data.siteOwner}
		ownerLinks={data.ownerLinks}
		ownerStatus={data.ownerStatus}
		postsData={data.postsData}
		notesData={data.notesData}
		timelineData={data.timelineData}
		pagesData={data.pagesData}
	/>
	<div class="flex flex-1 pt-24">
		<main class="min-w-0 flex-1">
			{@render children()}
		</main>
	</div>
	<Footer pages={data.pagesData.footerDefaults} />
	<PresenceHeartbeat enabled={data.presence.enabled} />
</div>
