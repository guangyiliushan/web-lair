<script lang="ts">
	import { cn } from '$lib/utils';
	import { siteHref } from '$lib/utils/href';
	import { isExternalSocialHref, socialRailItems, type SocialLinkLike } from '$lib/config/social';
	import { SOCIAL_ICONS } from './social-icons';

	/**
	 * The single social rail: the owner's `user_profiles.links`
	 * plus the fixed RSS item, rendered identically in the homepage hero, the
	 * nav home panel and the mobile menu. `links` is the whole source — never
	 * a second config list.
	 */
	let {
		links,
		variant = 'nav',
		class: className
	}: {
		links: readonly SocialLinkLike[] | null | undefined;
		variant?: 'hero' | 'nav' | 'mobile';
		class?: string;
	} = $props();

	const items = $derived(socialRailItems(links));

	const itemClass = $derived(
		variant === 'hero'
			? 'flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
			: variant === 'mobile'
				? 'flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
				: 'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
	);
	const iconClass = $derived(
		variant === 'hero' ? 'size-5' : variant === 'mobile' ? 'size-4' : 'size-3.5'
	);
</script>

<div
	class={cn('flex flex-wrap items-center', variant === 'hero' ? 'gap-3' : 'gap-0.5', className)}
	data-slot={`social-rail-${variant}`}
>
	{#each items as item (item.platform + ':' + item.href)}
		{@const Icon = SOCIAL_ICONS[item.platform]}
		{@const external = isExternalSocialHref(item.href)}
		<a
			href={item.platform === 'rss' ? siteHref(item.href) : item.href}
			aria-label={item.label}
			title={item.label}
			target={external ? '_blank' : undefined}
			rel={external ? 'noopener noreferrer' : undefined}
			class={itemClass}
		>
			<Icon class={iconClass} />
		</a>
	{/each}
</div>
