<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	/**
	 * W6.3 (C3): the public privacy notice. Every claim mirrors the code:
	 * comments store no raw IP, country only with the site + commenter opt-in,
	 * security logs are short-lived, and token-bearing paths stay out of them.
	 * Sections are message pairs so the three locales stay in lockstep.
	 */
	const sections = [
		{ title: m.privacy_account_title, body: m.privacy_account_body },
		{ title: m.privacy_comments_title, body: m.privacy_comments_body },
		{ title: m.privacy_ip_title, body: m.privacy_ip_body },
		{ title: m.privacy_cookies_title, body: m.privacy_cookies_body },
		{ title: m.privacy_third_parties_title, body: m.privacy_third_parties_body },
		{ title: m.privacy_retention_title, body: m.privacy_retention_body },
		{ title: m.privacy_rights_title, body: m.privacy_rights_body },
		{ title: m.privacy_contact_title, body: m.privacy_contact_body }
	];
</script>

<svelte:head>
	<title>{m.privacy_title()}</title>
	<meta name="description" content={m.privacy_intro()} />
</svelte:head>

<article class="mx-auto max-w-3xl px-4 py-16">
	<h1 class="text-2xl font-semibold tracking-tight">{m.privacy_title()}</h1>
	<p class="mt-4 text-sm leading-relaxed text-muted-foreground">{m.privacy_intro()}</p>
	<p class="mt-2 text-xs text-muted-foreground">{m.privacy_updated()}</p>

	<div class="mt-10 flex flex-col gap-8">
		{#each sections as section (section.title())}
			<section>
				<h2 class="text-base font-medium">{section.title()}</h2>
				<p class="mt-2 text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
					{section.body()}
				</p>
			</section>
		{/each}
	</div>
</article>
