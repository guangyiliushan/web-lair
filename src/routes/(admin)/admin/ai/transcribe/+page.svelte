<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
	const locale = getLocale();

	const success = $derived(
		form && 'ok' in form && form.ok ? (form as { id: string; text: string; vtt: string }) : null
	);
	const error = $derived(form && 'error' in form ? String(form.error) : '');
	const errorText = $derived(
		error === 'missing'
			? m.admin_ai_transcribe_missing()
			: error === 'too_large'
				? m.admin_ai_transcribe_too_large()
				: error === 'bad_type'
					? m.admin_ai_transcribe_bad_type()
					: error === 'unavailable'
						? m.admin_ai_transcribe_unavailable()
						: error === 'rate'
							? m.admin_ai_transcribe_rate()
							: error
								? m.admin_ai_transcribe_failed()
								: ''
	);

	function formatDuration(seconds: number | null): string {
		if (seconds == null) return '—';
		const minutes = Math.floor(seconds / 60);
		const rest = seconds % 60;
		return `${minutes}:${String(rest).padStart(2, '0')}`;
	}
</script>

<svelte:head>
	<title>{m.admin_ai_transcribe_title()} - Lair Admin</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
	<div class="space-y-1">
		<h1 class="text-lg font-semibold">{m.admin_ai_transcribe_title()}</h1>
		<p class="text-sm text-muted-foreground">{m.admin_ai_transcribe_intro()}</p>
	</div>

	<form
		method="post"
		action="?/transcribe"
		enctype="multipart/form-data"
		class="space-y-3 rounded-xl border p-4"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				busy = false;
				await update();
			};
		}}
	>
		<label class="block text-sm font-medium" for="audio">{m.admin_ai_transcribe_file()}</label>
		<input
			id="audio"
			type="file"
			name="audio"
			required
			accept="audio/*,video/mp4,video/webm,video/quicktime"
			class="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
		/>
		<div class="flex flex-wrap items-end gap-3">
			<label class="space-y-1 text-sm">
				<span class="block text-muted-foreground">{m.admin_ai_transcribe_language()}</span>
				<select name="language" class="h-9 rounded-md border bg-transparent px-2 text-sm">
					<option value="auto">{m.admin_ai_transcribe_lang_auto()}</option>
					<option value="zh">{m.admin_ai_transcribe_lang_zh()}</option>
					<option value="en">{m.admin_ai_transcribe_lang_en()}</option>
					<option value="ja">{m.admin_ai_transcribe_lang_ja()}</option>
				</select>
			</label>
			<Button type="submit" disabled={busy}>
				{busy ? m.admin_ai_transcribe_running() : m.admin_ai_transcribe_submit()}
			</Button>
		</div>
	</form>

	{#if errorText}
		<p role="alert" class="text-sm text-destructive">{errorText}</p>
	{/if}

	{#if success}
		<section class="space-y-3 rounded-xl border p-4">
			<div class="flex items-center justify-between gap-2">
				<h2 class="text-sm font-medium">{m.admin_ai_transcribe_text()}</h2>
				<a
					class="text-xs underline underline-offset-4"
					download={`transcript-${success.id}.vtt`}
					href={`data:text/vtt;charset=utf-8,${encodeURIComponent(success.vtt)}`}
				>
					{m.admin_ai_transcribe_vtt()}
				</a>
			</div>
			<textarea
				readonly
				rows="8"
				class="w-full resize-y rounded-md border bg-transparent p-3 text-sm"
				value={success.text}></textarea>
			<details>
				<summary class="cursor-pointer text-xs text-muted-foreground">
					{m.admin_ai_transcribe_vtt()}
				</summary>
				<textarea
					readonly
					rows="8"
					class="mt-2 w-full resize-y rounded-md border bg-transparent p-3 font-mono text-xs"
					value={success.vtt}></textarea>
			</details>
		</section>
	{/if}

	<section class="space-y-2 rounded-xl border p-4">
		<h2 class="text-sm font-medium">{m.admin_ai_transcribe_recent()}</h2>
		{#if data.recent.length === 0}
			<p class="text-sm text-muted-foreground">{m.admin_ai_transcribe_empty()}</p>
		{:else}
			<ul class="divide-y text-sm">
				{#each data.recent as row (row.id)}
					<li class="flex items-center justify-between gap-3 py-2">
						<span class="min-w-0 truncate">{row.sourceName}</span>
						<span class="shrink-0 text-xs text-muted-foreground">
							{row.language} · {formatDuration(row.durationSeconds)} ·
							{new Date(row.createdAt).toLocaleString(locale)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
