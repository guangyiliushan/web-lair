<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';
	import IconHome from '@tabler/icons-svelte-runes/icons/home';
	import { m } from '$lib/paraglide/messages';

	let status = $derived(page.status);
	let message = $derived(page.error?.message ?? m.admin_error_forbidden());

	const isNotFound = $derived(status === 404);
	const isForbidden = $derived(status === 403);
	const isServerError = $derived(status >= 500);

	const heading = $derived(
		isNotFound
			? m.admin_error_not_found()
			: isForbidden
				? m.admin_error_forbidden()
				: isServerError
					? m.admin_error_server()
					: m.admin_error_generic()
	);

	const description = $derived(
		isNotFound
			? m.admin_error_desc_not_found()
			: isForbidden
				? m.admin_error_desc_forbidden()
				: isServerError
					? m.admin_error_desc_server()
					: message
	);
</script>

<svelte:head>
	<title>{status}: {heading} — Lair Admin</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="flex min-h-[80vh] flex-col items-center justify-center px-4 text-center">
	<div class="max-w-md space-y-8">
		<div class="space-y-3">
			<p class="text-8xl font-bold tracking-tighter text-muted-foreground/20">{status}</p>
			<h1 class="text-2xl font-bold tracking-tight">{heading}</h1>
			<p class="text-base text-muted-foreground">{description}</p>
		</div>

		<div class="flex flex-col items-center justify-center gap-3 sm:flex-row">
			<Button href="/admin" size="lg">
				<IconArrowLeft data-icon="inline-start" />
				{m.admin_error_back_dashboard()}
			</Button>
			<Button href="/" variant="outline" size="lg">
				<IconHome data-icon="inline-start" />
				{m.admin_error_back_site()}
			</Button>
		</div>
	</div>
</div>
