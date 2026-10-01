<script lang="ts">
	import { page } from '$app/state';
	import { localizeHref, locales } from '$lib/paraglide/runtime';

	/**
	 * hreflang set (P3-b R1-Q5): detail pages pass their translation group's
	 * per-language paths (slugs may differ), aggregate pages default to the
	 * same path in every locale. x-default stays deferred until a second
	 * language has published content. Canonical is always self-referencing.
	 */
	interface Alternate {
		/** Locale tag (en | zh-cn | ja). */
		lang: string;
		/** Neutral path of that locale's version. */
		path: string;
	}

	interface Props {
		/** Neutral path of this page (no locale prefix). */
		path: string;
		/** Published alternates, self included. Defaults to `path` per locale. */
		alternates?: Alternate[];
	}

	let { path, alternates }: Props = $props();

	/**
	 * Absolute-URL origin: the (site) layout provides ORIGIN when configured
	 * (single source shared with feeds/robots), otherwise the request origin
	 * is the fallback. Review finding: page.url.origin alone can advertise an
	 * internal host behind a proxy while the sitemap uses ORIGIN.
	 */
	const publicOrigin = $derived(
		(page.data as { siteOrigin?: string | null }).siteOrigin ?? page.url.origin
	);

	function absolute(href: string): string {
		return `${publicOrigin}${href}`;
	}

	const canonical = $derived(absolute(localizeHref(path)));
	const altLinks = $derived(
		(alternates ?? locales.map((lang) => ({ lang, path }))).map((alt) => ({
			lang: alt.lang,
			href: absolute(localizeHref(alt.path, { locale: alt.lang as (typeof locales)[number] }))
		}))
	);
</script>

<svelte:head>
	<link rel="canonical" href={canonical} />
	{#each altLinks as alt (alt.lang)}
		<link rel="alternate" hreflang={alt.lang} href={alt.href} />
	{/each}
</svelte:head>
