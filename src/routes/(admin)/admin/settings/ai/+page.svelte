<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<svelte:head>
	<title>AI 设定 - Lair Admin</title>
</svelte:head>

<div class="space-y-10">
	<section class="space-y-4">
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 class="inline-flex items-center gap-2 text-base font-medium">AI 服务商</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					配置 AI 服务提供商、密钥、Endpoint 与默认模型。
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<Button type="button" variant="outline" size="sm">
					<IconPlus data-icon="inline-start" />
					添加服务商
				</Button>
			</div>
		</header>
		<div class="flex min-h-60 flex-col items-center justify-center px-4 text-center">
			<IconSettings class="size-7 text-muted-foreground/30" />
			<p class="mt-3 text-sm text-muted-foreground">暂无服务商</p>
		</div>
	</section>

	<section class="space-y-4">
		<header>
			<h2 class="inline-flex items-center gap-2 text-base font-medium">AI 摘要</h2>
			<p class="mt-1 text-xs text-muted-foreground">
				为文章自动生成摘要，可指定目标语言与触发时机。
			</p>
		</header>
		<div class="space-y-4">
			<label class="flex items-center justify-between gap-4 text-sm">
				<span class="min-w-0"><span class="block">启用 AI 摘要</span></span>
				<button
					type="button"
					role="switch"
					aria-checked={s.ai.summaryEnabled}
					aria-label="切换"
					class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
					class:bg-accent={s.ai.summaryEnabled}
					class:bg-surface-inset={!s.ai.summaryEnabled}
					onclick={() => (s.ai.summaryEnabled = !s.ai.summaryEnabled)}
				>
					<span
						class="block size-4 rounded-full bg-white shadow-xs transition-transform"
						class:translate-x-4={s.ai.summaryEnabled}
					></span>
				</button>
			</label>

			{#each [['摘要功能', 'summaryProvider'], ['精读生成', 'deepReadProvider'], ['精读翻译', 'deepReadTranslateProvider'], ['翻译功能', 'translateProvider'], ['翻译审稿', 'translateReviewProvider'], ['写作助手', 'writingProvider'], ['评论审核', 'commentReviewProvider']] as [label, providerKey] (providerKey)}
				<div class="grid items-center gap-2 text-sm md:grid-cols-[12rem_minmax(0,1fr)]">
					<div><div class="font-medium">{label}</div></div>
					<div class="grid items-center gap-2 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
						<Select.Root type="single">
							<Select.Trigger class="w-full">
								<span class="truncate text-muted-foreground">不指定</span>
							</Select.Trigger>
							<Select.Content></Select.Content>
						</Select.Root>
						<Input disabled placeholder="使用 Provider 默认模型" />
					</div>
				</div>
			{/each}

			<label class="grid gap-1.5 text-sm">
				<span class="font-medium">摘要目标语言</span>
				<div class="space-y-2">
					<div class="flex gap-2">
						<Input disabled maxlength={2} placeholder="如 en, ja, ko" />
						<Button type="button" disabled variant="outline" size="sm" class="shrink-0">新增</Button
						>
					</div>
				</div>
			</label>

			<label class="grid gap-1.5 text-sm">
				<span class="font-medium">摘要自动生成最小文本长度</span>
				<Input disabled type="number" value={s.ai.summaryMinLength} />
			</label>
		</div>
	</section>
</div>
