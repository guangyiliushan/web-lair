<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import type { PageData } from './$types';

	let { data, form }: { data: PageData; form: { success?: boolean; error?: string } | null } =
		$props();

	const LOCALES = [
		{ code: 'en', label: 'English' },
		{ code: 'zh-cn', label: '简体中文' },
		{ code: 'ja', label: '日本語' }
	] as const;

	let saved = $state(false);
</script>

<svelte:head>
	<title>编辑页面 - Lair Admin</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
	{#if form?.error}
		<div
			role="alert"
			class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{form.error}
		</div>
	{:else if saved}
		<div
			role="status"
			class="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400"
		>
			已保存。
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<Badge variant={data.page.isDefault ? 'secondary' : 'outline'} class="text-xs">
			{data.page.isDefault ? '默认页' : '额外页'}
		</Badge>
		<Badge variant="outline" class="text-xs">
			{data.page.hasContent ? 'md 页面' : 'code 页面'}
		</Badge>
		<span>slug: <span class="font-mono">{data.page.slug}</span></span>
	</div>

	<form
		method="POST"
		action="?/save"
		oninput={() => {
			saved = false;
		}}
		use:enhance={() => {
			saved = false;
			return async ({ result, update }) => {
				await update();
				if (result.type === 'success') saved = true;
			};
		}}
		class="flex flex-col gap-6"
	>
		<input type="hidden" name="id" value={data.page.id} />

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold">标题（至少一种语言）</h2>
			{#each LOCALES as locale (locale.code)}
				<label class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
					<input
						type="text"
						name="title_{locale.code}"
						value={data.page.title[locale.code] ?? ''}
						class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					/>
				</label>
			{/each}
		</section>

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold">描述（可选）</h2>
			{#each LOCALES as locale (locale.code)}
				<label class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-xs text-muted-foreground">{locale.label}</span>
					<input
						type="text"
						name="description_{locale.code}"
						value={data.page.description[locale.code] ?? ''}
						class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					/>
				</label>
			{/each}
		</section>

		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-semibold">属性</h2>
			<label class="flex items-center gap-3">
				<span class="w-20 shrink-0 text-xs text-muted-foreground">图标</span>
				<input
					type="text"
					name="icon"
					value={data.page.icon}
					placeholder="tabler 图标名（kebab，如 coffee）"
					class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
				/>
			</label>
			<label class="flex items-center gap-3">
				<span class="w-20 shrink-0 text-xs text-muted-foreground">外链</span>
				<input
					type="url"
					name="externalUrl"
					value={data.page.externalUrl}
					placeholder="https://…（留空 = 站内页面）"
					class="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
				/>
			</label>
			<label class="flex items-center gap-3">
				<span class="w-20 shrink-0 text-xs text-muted-foreground">Slug</span>
				<input
					type="text"
					name="slug"
					value={data.page.slug}
					readonly={data.page.isDefault}
					class="h-9 w-full rounded-md border bg-transparent px-3 font-mono text-sm read-only:opacity-60"
				/>
			</label>
			{#if data.page.isDefault}
				<p class="text-xs text-muted-foreground">
					默认页 Slug 不可修改（db:ensure-pages 以 slug 为种子锚点）。
				</p>
			{:else if !data.page.hasContent}
				<p class="text-xs text-amber-600 dark:text-amber-400">
					code 页面：修改 Slug 需同步代码里的显式路由，否则入口会失效。
				</p>
			{:else}
				<p class="text-xs text-muted-foreground">修改 Slug 后旧 URL 直接 404（不做重定向）。</p>
			{/if}
		</section>

		<div class="flex items-center gap-3">
			<Button type="submit">保存</Button>
			<Button variant="outline" href="/admin/pages">返回列表</Button>
		</div>
	</form>
</div>
