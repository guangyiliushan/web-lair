<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar';
	import { m } from '$lib/paraglide/messages';
	import { motion } from '@humanspeak/svelte-motion';
	import SocialRail from '$lib/components/layout/SocialRail.svelte';
	import type { SocialLinkLike } from '$lib/config/social';
	import type { SiteOwner } from '$lib/config/owner-status';
	import { firstGrapheme } from '$lib/config/owner-presence';
	import type { HeroField } from '$lib/config/home-hero';

	/**
	 * Hero view (W4.3/W4.5): copy resolved server-side from `home_hero` with
	 * the locale -> site default -> messages fallback chain. The owner avatar
	 * replaces the old dicebear placeholder; the social rail and the default
	 * `hero_title` are single-source, so changing the owner name updates both.
	 */
	let {
		owner,
		links,
		hero
	}: {
		owner: SiteOwner;
		links?: readonly SocialLinkLike[] | null;
		hero: Record<HeroField, string>;
	} = $props();

	const avatarFallback = $derived(firstGrapheme(owner.name));
</script>

<section
	class="relative flex h-[calc(100dvh-6rem)] min-h-137.5 flex-col items-center overflow-hidden px-4"
>
	<div
		class="z-10 container flex w-full max-w-5xl flex-1 flex-col-reverse items-center justify-center gap-8 sm:gap-10 lg:flex-row lg:gap-16"
	>
		<!-- 文字区域：左滑入 -->
		<motion.div
			class="flex min-w-0 flex-1 flex-col items-start"
			initial={{ opacity: 0, x: -30 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.6 }}
		>
			<h1 class="mb-4 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
				{hero.title}
			</h1>

			<h2 class="mb-6 text-2xl font-semibold sm:text-3xl lg:text-4xl">
				{hero.subtitlePrefix}
				<span class="font-mono text-primary-text">{hero.subtitleHighlight}</span>
			</h2>

			<p class="mb-10 max-w-lg text-lg text-muted-foreground">
				{hero.description}
			</p>

			<SocialRail {links} variant="hero" />
		</motion.div>

		<!-- 头像区域：弹性缩放入 -->
		<motion.div
			class="relative size-56 shrink-0 sm:size-72 md:size-80 lg:size-96"
			initial={{ opacity: 0, scale: 0.6 }}
			animate={{ opacity: 1, scale: 1 }}
			transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.3 }}
		>
			<Avatar.Root
				class="relative size-full overflow-hidden rounded-full border-4 border-background shadow-2xl"
			>
				<Avatar.Image src={owner.avatar} alt={m.hero_avatar_alt()} loading="lazy" />
				<Avatar.Fallback class="text-4xl">{avatarFallback}</Avatar.Fallback>
			</Avatar.Root>
		</motion.div>
	</div>

	<!-- 底部欢迎语：多断点响应式，shrink-0 固定于首屏底。D3=B 删除了
	     指向 `#content` 的滚动指示器与占位正文。 -->
	<div
		class="z-10 flex shrink-0 flex-col items-center gap-2 pt-2 pb-4 sm:gap-2.5 sm:pt-3 sm:pb-6 md:gap-3 md:pt-4 md:pb-8 lg:pt-6 lg:pb-10"
	>
		<p
			class="max-w-[18rem] text-center text-xs leading-relaxed text-muted-foreground sm:max-w-xs sm:text-sm md:max-w-sm md:text-base"
		>
			{hero.welcome}
		</p>
	</div>
</section>
