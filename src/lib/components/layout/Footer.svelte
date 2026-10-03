<script lang="ts">
	import { cn } from '$lib/utils';
	import { Separator } from '$lib/components/ui/separator';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import LangSwitcher from '$lib/components/layout/LangSwitcher.svelte';
	import ThemeToggle from '$lib/components/layout/ThemeToggle.svelte';
	import { IconCodeCircle2, IconRss, IconExternalLink } from '@tabler/icons-svelte-runes';

	/** Footer link item descriptor */
	interface FooterLink {
		label: string;
		href: string;
		external?: boolean;
	}

	/** Footer section descriptor */
	interface FooterSection {
		title: string;
		links: FooterLink[];
	}

	/** Footer component props */
	interface FooterProps {
		/** Optional custom navigation sections; falls back to localized defaults */
		sections?: FooterSection[];
		/** ICP 备案号 (for China-based sites) */
		icpNumber?: string;
		/** Online visitor count (optional) */
		onlineCount?: number;
		/** Default-page links for the About group (pages line P1b; layout-provided) */
		pages?: FooterLink[];
		/** Additional CSS classes appended to the root footer element */
		class?: string;
	}

	let {
		sections: sectionProp,
		icpNumber,
		onlineCount,
		pages,
		class: className
	}: FooterProps = $props();

	/** Resolved sections — user-supplied or auto-generated localized defaults */
	let sections = $derived(sectionProp ?? buildDefaultSections());

	function buildDefaultSections(): FooterSection[] {
		return [
			{
				title: m.footer_about(),
				links: pages ?? []
			},
			{
				title: m.footer_more(),
				links: [
					{ label: m.footer_gallery(), href: '/gallery' },
					{ label: m.footer_monitor(), href: '/monitor', external: true }
				]
			},
			{
				title: m.footer_contact(),
				links: [
					{ label: m.footer_guestbook(), href: '/guestbook' },
					{ label: m.footer_email(), href: 'mailto:contact@example.com' },
					{ label: 'GitHub', href: 'https://github.com', external: true }
				]
			}
		];
	}

	function isExternal(href: string): boolean {
		return href.startsWith('http') || href.startsWith('mailto');
	}
</script>

<footer
	class={cn(
		'relative w-full',
		'bg-linear-to-b from-muted/50 via-background to-background',
		'dark:from-muted/30 dark:via-background dark:to-background',
		'border-t border-border/50',
		className
	)}
	aria-label={m.footer_aria_label()}
>
	<div
		class="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-border to-transparent"
	></div>

	<div class="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
		<div class="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
			<!-- Brand -->
			<div class="flex flex-col gap-4">
				<div class="flex items-center gap-2">
					<IconCodeCircle2 class="size-6 text-primary" aria-hidden="true" />
					<span class="text-lg font-bold">Lair</span>
				</div>

				<p class="text-sm text-muted-foreground italic">
					{m.footer_tagline()}
				</p>

				<p class="text-xs text-muted-foreground/80">
					{m.footer_copyright({ year: new Date().getFullYear() })}
				</p>

				{#if onlineCount !== undefined}
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<span class="relative flex size-2">
							<span
								class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/75 opacity-75"
								aria-hidden="true"
							></span>
							<span
								class="relative inline-flex size-2 rounded-full bg-emerald-500"
								aria-hidden="true"
							></span>
						</span>
						<span>{m.footer_online_visitors({ count: onlineCount })}</span>
					</div>
				{/if}
			</div>

			<!-- Navigation sections -->
			{#each sections as section (section.title)}
				<div class="flex flex-col gap-3">
					<h3 class="text-sm font-semibold text-foreground">{section.title}</h3>
					<ul class="flex flex-col gap-2" role="list">
						{#each section.links as link (link.href)}
							<li>
								<a
									href={siteHref(link.href)}
									class={cn(
										'group inline-flex items-center gap-1 text-sm text-muted-foreground',
										'transition-colors hover:text-primary',
										'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none',
										'rounded-sm'
									)}
									target={link.external || isExternal(link.href) ? '_blank' : undefined}
									rel={link.external || isExternal(link.href) ? 'noopener noreferrer' : undefined}
								>
									{link.label}
									{#if link.external || isExternal(link.href)}
										<IconExternalLink
											class="size-3 opacity-0 transition-opacity group-hover:opacity-100"
											aria-hidden="true"
										/>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>

		<!-- Bottom bar -->
		<Separator class="my-8" />

		<div
			class="flex flex-col items-center justify-between gap-4 sm:flex-row"
			aria-label={m.footer_bottom_aria()}
		>
			<!-- RSS / Sitemap / Subscribe -->
			<div
				class="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground sm:justify-start"
			>
				<a
					href={siteHref('/rss.xml')}
					class="inline-flex items-center gap-1 rounded-sm transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
				>
					<IconRss class="size-3" aria-hidden="true" />
					<span>{m.footer_rss()}</span>
				</a>
				<span aria-hidden="true">·</span>
				<a
					href={siteHref('/sitemap.xml')}
					class="rounded-sm transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
				>
					{m.footer_sitemap()}
				</a>
				<span aria-hidden="true">·</span>
				<a
					href={siteHref('/subscribe')}
					class="rounded-sm transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
				>
					{m.footer_subscribe()}
				</a>
			</div>

			<!-- Language / theme switchers (reused from header layout) -->
			<div class="flex items-center gap-2">
				<LangSwitcher />
				<ThemeToggle />
			</div>

			<!-- ICP -->
			{#if icpNumber}
				<div class="text-xs text-muted-foreground/60">{icpNumber}</div>
			{/if}
		</div>
	</div>
</footer>
