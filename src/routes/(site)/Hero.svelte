<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { mergeProps } from 'bits-ui';
	import { m } from '$lib/paraglide/messages';
	import { siteHref } from '$lib/utils/href';
	import { motion } from '@humanspeak/svelte-motion';
	import {
		IconBrandGithub,
		IconBrandTwitter,
		IconMail,
		IconRss,
		IconBrandTelegram,
		IconBrandX,
		IconChevronDown
	} from '@tabler/icons-svelte-runes';

	type SocialPlatform = 'github' | 'twitter' | 'email' | 'rss' | 'telegram' | 'x';

	interface SocialLink {
		platform: SocialPlatform;
		href: string;
		ariaLabel: string;
	}

	const socialLinks: SocialLink[] = [
		{ platform: 'github', href: 'https://github.com/guangyiliushan', ariaLabel: 'GitHub' },
		{ platform: 'twitter', href: 'https://twitter.com/guangyiliushan', ariaLabel: 'Twitter' },
		{ platform: 'email', href: 'mailto:guangyiliushan@example.com', ariaLabel: 'Email' },
		{ platform: 'rss', href: '/rss.xml', ariaLabel: 'RSS Feed' },
		{ platform: 'telegram', href: 'https://t.me/guangyiliushan', ariaLabel: 'Telegram' },
		{ platform: 'x', href: 'https://x.com/guangyiliushan', ariaLabel: 'X' }
	];

	const iconOf: Record<SocialPlatform, typeof IconBrandGithub> = {
		github: IconBrandGithub,
		twitter: IconBrandTwitter,
		email: IconMail,
		rss: IconRss,
		telegram: IconBrandTelegram,
		x: IconBrandX
	};

	// 头像配置
	const avatarConfig = {
		src: 'https://api.dicebear.com/10.x/lorelei/svg?flip=horizontal&seed=guangyiliushan',
		alt: m.hero_avatar_alt(),
		fallback: 'GL'
	};

	/** 平滑滚动 #content，兼容所有设 */
	function scrollToContent(e: MouseEvent) {
		e.preventDefault();
		const target = document.querySelector('#content');
		if (target) {
			target.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}
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
				{m.hero_title()}
			</h1>

			<h2 class="mb-6 text-2xl font-semibold sm:text-3xl lg:text-4xl">
				{m.hero_subtitle_prefix()}
				<span class="font-mono text-primary">{m.hero_subtitle_highlight()}</span>
			</h2>

			<p class="mb-10 max-w-lg text-lg text-muted-foreground">
				{m.hero_description()}
			</p>

			<div class="flex flex-wrap items-center gap-3">
				{#each socialLinks as link (link.platform)}
					{@const Icon = iconOf[link.platform]}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								{@const merged = mergeProps(props, { class: 'size-10 rounded-full' })}
								<Button
									variant="ghost"
									size="icon"
									href={siteHref(link.href)}
									target="_blank"
									rel="noopener noreferrer"
									aria-label={link.ariaLabel}
									{...merged}
								>
									<Icon data-icon="inline-start" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>
							{link.ariaLabel}
						</Tooltip.Content>
					</Tooltip.Root>
				{/each}
			</div>
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
				<Avatar.Image src={avatarConfig.src} alt={avatarConfig.alt} loading="lazy" />
				<Avatar.Fallback class="text-4xl">{avatarConfig.fallback}</Avatar.Fallback>
			</Avatar.Root>
		</motion.div>
	</div>

	<!-- 底部欢迎 + 可点击滚动指示器：多断点响应式，shrink-0 固定于首屏底 -->
	<div
		class="z-10 flex shrink-0 flex-col items-center gap-2 pt-2 pb-4 sm:gap-2.5 sm:pt-3 sm:pb-6 md:gap-3 md:pt-4 md:pb-8 lg:pt-6 lg:pb-10"
	>
		<p
			class="max-w-[18rem] text-center text-xs leading-relaxed text-muted-foreground sm:max-w-xs sm:text-sm md:max-w-sm md:text-base"
		>
			{m.hero_welcome()}
		</p>
		<a
			href="#content"
			onclick={scrollToContent}
			class="animate-bounce rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
		>
			<IconChevronDown class="size-4 sm:size-5 md:size-6" />
			<span class="sr-only">{m.hero_scroll_down()}</span>
		</a>
	</div>
</section>
