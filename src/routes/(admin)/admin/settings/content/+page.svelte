<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { Badge } from '$lib/components/ui/badge';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);

	const commentToggles: { key: string; label: string }[] = [
		{ key: 'antiSpam', label: m.admin_settings_content_anti_spam() },
		{ key: 'aiReview', label: m.admin_settings_content_ai_review() },
		{ key: 'disableComments', label: m.admin_settings_content_disable_comments() },
		{ key: 'allowAnonymousComments', label: m.admin_settings_content_allow_anonymous() },
		{ key: 'rejectNonChinese', label: m.admin_settings_content_chinese_only() },
		{ key: 'onlyApproved', label: m.admin_settings_content_approved_only() },
		{ key: 'showCommentLocation', label: m.admin_settings_content_show_location() }
	];

	const friendLinkToggles: { key: string; label: string; description: string }[] = [
		{
			key: 'allowFriendApps',
			label: m.admin_settings_content_allow_friend_apply(),
			description: m.admin_settings_content_allow_friend_apply_desc()
		},
		{
			key: 'allowSubPathFriends',
			label: m.admin_settings_content_friend_subpaths(),
			description: m.admin_settings_content_friend_subpaths_desc()
		},
		{
			key: 'internalizeAvatars',
			label: m.admin_settings_content_localize_avatars(),
			description: m.admin_settings_content_localize_avatars_desc()
		}
	];
</script>

<svelte:head>
	<title>{m.admin_settings_content_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-10">
	<!-- Comment settings -->
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">
					{m.admin_settings_content_comments_section()}
				</h2>
				<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_content_comments_desc()}</p>
			</div>
		</header>
		<div class="space-y-5">
			{#each commentToggles as item (item.key)}
				<div class="flex items-center justify-between gap-4">
					<span class="text-sm">{item.label}</span>
					<button
						type="button"
						role="switch"
						aria-checked={Boolean(s.content[item.key as keyof typeof s.content])}
						aria-label={item.label}
						class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
						class:bg-accent={s.content[item.key as keyof typeof s.content]}
						class:bg-surface-inset={!s.content[item.key as keyof typeof s.content]}
					>
						<span
							class="block size-4 rounded-full bg-white shadow-xs transition-transform"
							class:translate-x-4={s.content[item.key as keyof typeof s.content]}
						></span>
					</button>
				</div>
			{/each}
			{#if s.content.aiReview}
				<div class="flex items-center justify-between gap-4">
					<span class="text-sm">{m.admin_settings_content_ai_mode()}</span>
					<Select.Root type="single" value={s.content.aiReviewMode}>
						<Select.Trigger class="w-32">
							{s.content.aiReviewMode === 'binary'
								? m.admin_settings_content_ai_binary()
								: m.admin_settings_content_ai_score()}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="binary">{m.admin_settings_content_ai_binary()}</Select.Item>
							<Select.Item value="score">{m.admin_settings_content_ai_score()}</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
				<div class="flex items-center justify-between gap-4">
					<span class="text-sm">{m.admin_settings_content_ai_threshold()}</span>
					<Input class="w-24" type="number" value={s.content.aiReviewThreshold} />
				</div>
			{/if}
			<div class="flex items-center justify-between gap-4">
				<span class="text-sm">{m.admin_settings_content_blocked_words()}</span>
				<div class="max-w-[60%] min-w-0 flex-1">
					<div class="flex flex-wrap gap-2">
						{#each s.content.blockedKeywords as kw (kw)}
							<Badge variant="secondary" class="gap-1">
								{kw}
								<button
									type="button"
									class="relative inline-flex size-3 items-center after:absolute after:-inset-2"
									aria-label={m.admin_settings_remove_keyword({ keyword: kw })}
									><IconX class="size-3" /></button
								>
							</Badge>
						{/each}
					</div>
					<Input class="mt-2" type="text" placeholder={m.admin_settings_keywords_placeholder()} />
				</div>
			</div>
			<div class="flex items-center justify-between gap-4">
				<span class="text-sm">{m.admin_settings_content_blocked_ips()}</span>
				<div class="max-w-[60%] min-w-0 flex-1">
					<div class="flex flex-wrap gap-2">
						{#each s.content.blockedIps as ip (ip)}
							<Badge variant="secondary" class="gap-1">
								{ip}
								<button
									type="button"
									class="relative inline-flex size-3 items-center after:absolute after:-inset-2"
									aria-label={m.admin_settings_content_remove_ip({ ip: ip })}
									><IconX class="size-3" /></button
								>
							</Badge>
						{/each}
					</div>
					<Input class="mt-2" type="text" placeholder={m.admin_settings_keywords_placeholder()} />
				</div>
			</div>
		</div>
	</section>

	<!-- Friend link settings -->
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">
					{m.admin_settings_content_friends_section()}
				</h2>
				<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_content_friends_desc()}</p>
			</div>
		</header>
		<div class="space-y-5">
			{#each friendLinkToggles as item (item.key)}
				<div class="flex items-center justify-between gap-4">
					<div class="min-w-0">
						<div class="text-sm">{item.label}</div>
						<p class="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={Boolean(s.content[item.key as keyof typeof s.content])}
						aria-label={item.label}
						class="relative inline-flex h-5 min-w-9 shrink-0 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
						class:bg-accent={s.content[item.key as keyof typeof s.content]}
						class:bg-surface-inset={!s.content[item.key as keyof typeof s.content]}
					>
						<span
							class="block size-4 rounded-full bg-white shadow-xs transition-transform"
							class:translate-x-4={s.content[item.key as keyof typeof s.content]}
						></span>
					</button>
				</div>
			{/each}
		</div>
	</section>

	<div class="flex justify-end">
		<Button type="button" size="sm">
			<IconDeviceFloppy data-icon="inline-start" />
			{m.admin_common_save()}
		</Button>
	</div>
</div>
