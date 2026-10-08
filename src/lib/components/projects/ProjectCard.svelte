<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { PROJECT_PROVIDER_LABEL_KEYS, isProjectProvider } from '$lib/utils/project-meta';
	import IconCode from '@tabler/icons-svelte-runes/icons/code';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconStar from '@tabler/icons-svelte-runes/icons/star';

	/**
	 * Public project card (plan §5.1): icon/avatar + name + one-line
	 * description + status row (provider badge, language, stars, last push)
	 * + secondary exits shown only when filled. The whole card is a single
	 * stretched link to the project URL (`noopener noreferrer`); the corner
	 * buttons sit above the overlay so they stay independently clickable.
	 */
	interface Props {
		project: {
			name: string;
			description: string | null;
			provider: string;
			projectUrl: string;
			previewUrl: string | null;
			docUrl: string | null;
			avatar: string | null;
			language: string | null;
			stars: number | null;
			pushedLabel: string | null;
			archived: boolean;
		};
	}
	let { project }: Props = $props();

	/** Platform brands are proper nouns rendered literally (meta mapping). */
	const PROVIDER_BRANDS: Record<string, string> = {
		github: 'GitHub',
		gitlab: 'GitLab',
		gitee: 'Gitee',
		bitbucket: 'Bitbucket'
	};
	const BADGE_FNS: Record<string, () => string> = {
		projects_badge_site: m.projects_badge_site,
		projects_badge_other: m.projects_badge_other
	};

	const badgeLabel = $derived.by(() => {
		const key = isProjectProvider(project.provider)
			? PROJECT_PROVIDER_LABEL_KEYS[project.provider]
			: null;
		if (key !== null) return (BADGE_FNS[key] ?? (() => project.provider))();
		return PROVIDER_BRANDS[project.provider] ?? project.provider;
	});

	const isSiteLike = $derived(project.provider === 'site' || project.provider === 'other');
	const visitLabel = $derived(isSiteLike ? m.projects_visit_site() : m.projects_visit_repo());

	/** avatar when the platform provides one; site-like rows fall back to the proxy favicon. */
	const iconSrc = $derived.by(() => {
		if (project.avatar) return project.avatar;
		if (isSiteLike) {
			try {
				return `/api/favicon?url=${encodeURIComponent(new URL(project.projectUrl).origin)}`;
			} catch {
				return null;
			}
		}
		return null;
	});
</script>

<article
	class="relative flex flex-col gap-3 rounded-lg border border-border/60 p-4 transition-colors hover:border-border hover:bg-muted/30"
>
	<div class="flex items-start gap-3">
		<div
			class="mt-0.5 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40"
		>
			{#if iconSrc}
				<img src={iconSrc} alt="" class="size-full object-cover" loading="lazy" />
			{:else}
				<IconCode class="size-4 text-muted-foreground/60" aria-hidden="true" />
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-2">
				<a
					href={project.projectUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="truncate text-base font-medium after:absolute after:inset-0 after:content-['']"
					aria-label={`${visitLabel}: ${project.name}`}
				>
					{project.name}
				</a>
				{#if project.archived}
					<span class="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
						{m.projects_badge_archived()}
					</span>
				{/if}
			</div>
			{#if project.description}
				<p class="mt-1 line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
			{/if}
			<div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
				<span class="rounded border px-1.5 py-0.5">{badgeLabel}</span>
				{#if project.language}
					<span>{project.language}</span>
				{/if}
				{#if project.stars !== null}
					<span class="inline-flex items-center gap-1">
						<IconStar class="size-3.5" aria-hidden="true" />{project.stars}
					</span>
				{/if}
				{#if project.pushedLabel}
					<span>{project.pushedLabel}</span>
				{/if}
			</div>
		</div>
		{#if project.previewUrl || project.docUrl}
			<div class="relative z-10 flex shrink-0 items-center gap-1">
				{#if project.previewUrl}
					<a
						href={project.previewUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						aria-label={`${m.projects_link_preview()}: ${project.name}`}
						title={m.projects_link_preview()}
					>
						<IconExternalLink class="size-4" aria-hidden="true" />
					</a>
				{/if}
				{#if project.docUrl}
					<a
						href={project.docUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						aria-label={`${m.projects_link_docs()}: ${project.name}`}
						title={m.projects_link_docs()}
					>
						<IconFileText class="size-4" aria-hidden="true" />
					</a>
				{/if}
			</div>
		{/if}
	</div>
</article>
