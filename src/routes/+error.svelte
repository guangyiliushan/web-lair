<script lang="ts">
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { localeLabels } from '$lib/stores/locale.svelte';
	import { siteHref } from '$lib/utils/href';

	let status = $derived(page.status);
	let message = $derived(page.error?.message ?? m.error_generic_heading());
	const available = $derived(page.error?.available ?? []);

	const isNotFound = $derived(status === 404);
	const isForbidden = $derived(status === 403);
	const isUnauthorized = $derived(status === 401);
	const isServerError = $derived(status >= 500);

	const heading = $derived(
		isNotFound
			? m.error_404_heading()
			: isForbidden
				? m.error_403_heading()
				: isUnauthorized
					? m.error_401_heading()
					: isServerError
						? m.error_500_heading()
						: m.error_generic_heading()
	);

	const description = $derived(
		isNotFound
			? available.length > 0
				? message
				: m.error_404_desc()
			: isForbidden
				? m.error_403_desc()
				: isUnauthorized
					? m.error_401_desc()
					: isServerError
						? m.error_500_desc()
						: m.error_generic_desc()
	);
</script>

<svelte:head>
	<title>{status}: {heading}</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="flex min-h-screen flex-col items-center justify-center px-4 text-center">
	<div class="max-w-md space-y-6">
		<div class="space-y-2">
			<p class="text-7xl font-bold tracking-tighter text-muted-foreground/30 sm:text-8xl">
				{status}
			</p>
			<h1 class="text-2xl font-semibold tracking-tight">{heading}</h1>
			<p class="text-sm text-muted-foreground">{description}</p>
		</div>

		{#if available.length}
			<div class="space-y-3">
				<p class="text-sm text-muted-foreground">{m.error_available_in()}</p>
				<ul class="flex flex-wrap justify-center gap-2">
					{#each available as item (item.lang)}
						<li>
							<a
								href={item.href}
								class="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
							>
								{localeLabels[item.lang] ?? item.lang}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
			<a
				href={siteHref('/')}
				class="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
			>
				{m.error_back_home()}
			</a>
			{#if isUnauthorized}
				<a
					href={siteHref('/login')}
					class="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
				>
					{m.error_go_login()}
				</a>
			{/if}
		</div>

		{#if import.meta.env.DEV && page.error}
			<details class="mt-8 rounded-md border p-4 text-left text-xs">
				<summary class="cursor-pointer font-medium">Error details (dev only)</summary>
				<pre class="mt-2 overflow-x-auto text-muted-foreground">{JSON.stringify(
						page.error,
						null,
						2
					)}</pre>
			</details>
		{/if}
	</div>
</div>
