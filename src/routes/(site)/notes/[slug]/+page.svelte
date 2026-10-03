<script lang="ts">
	import { CommentsSection } from '$lib/components/comments';
	import { MarkdownRenderer } from '$lib/components/markdown';
	import { SeoHead } from '$lib/components/seo';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages';
	import {
		NOTE_EMOTION_LABELS,
		NOTE_MOOD_LABELS,
		noteWeatherLabel,
		type NoteLang,
		type NoteMood
	} from '$lib/utils/note-meta';
	import IconPin from '@tabler/icons-svelte-runes/icons/pin';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const lang = getLocale() as NoteLang;
	const gateClosed = $derived(data.gate.locked && !data.gate.unlocked);
	const moodLabel = $derived(
		data.note.mood ? NOTE_MOOD_LABELS[data.note.mood as NoteMood]?.[lang] : null
	);
	const emotionText = $derived(
		data.note.emotions
			? data.note.emotions
					.map(
						(token) =>
							NOTE_EMOTION_LABELS[token as keyof typeof NOTE_EMOTION_LABELS]?.[lang] ?? token
					)
					.join(' / ')
			: null
	);
	const weatherLabel = $derived(noteWeatherLabel(data.note.weatherCode, lang));
	const temperature = $derived(
		data.note.temperatureC !== null && data.note.temperatureC !== undefined
			? `${data.note.temperatureC}°C`
			: null
	);
	// The unlock failure shape ({message}) and the comment form shape are
	// different action results; pick the gate message explicitly.
	const gateMessage = $derived(
		form && 'message' in form && typeof form.message === 'string' ? form.message : null
	);
</script>

<svelte:head>
	<title>{data.note.title}</title>
	{#if gateClosed}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

<SeoHead path={data.seo.path} alternates={data.seo.alternates} />

<article class="mx-auto mt-14 max-w-3xl px-4 lg:mt-20 lg:px-0">
	<header class="border-b border-border/50 pb-6">
		<div class="flex items-center gap-2">
			<h1 class="text-3xl font-normal">{data.note.title}</h1>
			{#if !gateClosed && data.note.pinAt}
				<IconPin class="size-4 shrink-0 text-primary/70" role="img" aria-label={m.notes_pinned()} />
			{/if}
		</div>
		{#if !gateClosed}
			<div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
				<span class="whitespace-nowrap">{data.note.date}</span>
				{#if moodLabel}
					<span class="text-muted-foreground/40">·</span>
					<span>{moodLabel}</span>
				{/if}
				{#if emotionText}
					<span class="text-muted-foreground/40">·</span>
					<span>{emotionText}</span>
				{/if}
				{#if weatherLabel}
					<span class="text-muted-foreground/40">·</span>
					<span>{weatherLabel}</span>
				{/if}
				{#if temperature}
					<span class="text-muted-foreground/40">·</span>
					<span>{temperature}</span>
				{/if}
				{#if data.note.location}
					<span class="text-muted-foreground/40">·</span>
					<span>{data.note.location}</span>
				{/if}
				{#if data.note.topic}
					<span class="text-muted-foreground/40">·</span>
					<a href={localizeHref(`/notes/topics/${data.note.topic.slug}`)} class="text-primary">
						{data.note.topic.name}
					</a>
				{/if}
			</div>
		{/if}
	</header>

	{#if gateClosed}
		<section class="mt-10">
			<p class="text-sm text-muted-foreground">{m.notes_locked_hint()}</p>
			<form method="POST" action="?/unlock" class="mt-6 flex max-w-sm flex-col gap-3">
				<label class="text-xs text-muted-foreground" for="note-password">
					{m.notes_unlock_prompt()}
				</label>
				<input
					id="note-password"
					name="password"
					type="password"
					autocomplete="off"
					required
					aria-invalid={gateMessage ? true : undefined}
					aria-describedby={gateMessage ? 'note-unlock-error' : undefined}
					class="rounded-md border border-border bg-card px-3 py-2 text-sm"
				/>
				<button
					type="submit"
					class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					{m.notes_unlock_submit()}
				</button>
				{#if gateMessage}
					<p id="note-unlock-error" class="text-xs text-destructive" role="alert">
						{gateMessage}
					</p>
				{/if}
			</form>
		</section>
	{:else}
		<div class="mt-8">
			<MarkdownRenderer html={data.html} prose />
		</div>

		{#if data.discussion}
			<CommentsSection
				targetType="note"
				threads={data.discussion}
				canComment={data.viewer.canComment}
				emailVerified={data.viewer.emailVerified}
				loginUrl={data.viewer.loginUrl}
				form={form ?? null}
			/>
		{/if}
	{/if}

	<footer class="mt-16 border-t border-border/40 pt-5">
		<a
			href={localizeHref('/notes')}
			class="text-xs font-medium tracking-[2.5px] text-muted-foreground uppercase transition-colors hover:text-primary"
		>
			← {m.notes_back_to_all()}
		</a>
	</footer>
</article>
