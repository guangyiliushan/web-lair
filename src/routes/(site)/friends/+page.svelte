<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Card from '$lib/components/ui/card';
	import { m } from '$lib/paraglide/messages';

	interface Friend {
		name: string;
		description: string;
		url: string;
	}

	const friends: Friend[] = [
		{
			name: 'Web Lair',
			description: 'A quiet corner for notes, links, and experiments on the web.',
			url: 'https://web-lair.dev'
		},
		{
			name: 'Svelte',
			description: 'Cybernetically enhanced web apps with a delightful developer experience.',
			url: 'https://svelte.dev'
		},
		{
			name: 'MDN Web Docs',
			description: 'Resources for developers, by developers.',
			url: 'https://developer.mozilla.org'
		},
		{
			name: 'shadcn/ui',
			description: 'Beautifully designed components that you can copy and paste into your apps.',
			url: 'https://ui.shadcn.com'
		}
	];

	function avatarText(name: string): string {
		return name.slice(0, 1).toUpperCase();
	}
</script>

<svelte:head>
	<title>{m.friends_title()}</title>
	<meta name="description" content={m.friends_subtitle()} />
</svelte:head>

<div class="mx-auto mt-14 max-w-5xl px-4 lg:mt-20 lg:px-0 2xl:max-w-6xl">
	<header class="max-w-2xl">
		<h1 class="text-3xl font-normal tracking-tight">{m.friends_title()}</h1>
		<p class="mt-3 text-sm leading-relaxed text-muted-foreground">{m.friends_subtitle()}</p>
	</header>

	<section class="mt-8" aria-labelledby="friends-list-title">
		<h2 id="friends-list-title" class="sr-only">{m.friends_title()}</h2>
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			{#each friends as friend (friend.url)}
				<Card.Root
					class="group border-border/70 bg-card/60 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-card hover:shadow-lg hover:shadow-primary/5"
				>
					<a
						href={friend.url}
						target="_blank"
						rel="noreferrer"
						class="flex h-full gap-4 p-5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						<Avatar.Root class="size-12 shrink-0 rounded-xl">
							<Avatar.Fallback class="rounded-xl bg-primary/10 text-primary">
								{avatarText(friend.name)}
							</Avatar.Fallback>
						</Avatar.Root>
						<div class="min-w-0">
							<h3 class="font-medium transition-colors group-hover:text-primary">{friend.name}</h3>
							<p class="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
								{friend.description}
							</p>
							<p class="mt-3 truncate text-xs text-muted-foreground/70">{friend.url}</p>
						</div>
					</a>
				</Card.Root>
			{/each}
		</div>
	</section>

	<section class="mt-10 space-y-3" aria-label={m.friends_status_title()}>
		<details class="rounded-lg border border-border/60 bg-card/30 px-4 py-3">
			<summary class="cursor-pointer text-sm font-medium">{m.friends_unreachable()}</summary>
			<p class="mt-3 text-sm text-muted-foreground">{m.friends_empty()}</p>
		</details>
		<details class="rounded-lg border border-border/60 bg-card/30 px-4 py-3">
			<summary class="cursor-pointer text-sm font-medium">{m.friends_non_compliant()}</summary>
			<p class="mt-3 text-sm text-muted-foreground">{m.friends_empty()}</p>
		</details>
	</section>

	<Card.Root class="mt-10 border-dashed bg-muted/20">
		<Card.Content class="p-5">
			<h2 class="font-medium">{m.friends_apply_title()}</h2>
			<p class="mt-2 text-sm leading-relaxed text-muted-foreground">
				{m.friends_apply_description()}
			</p>
			<p class="mt-3 text-xs text-muted-foreground/70">{m.friends_site_info()}</p>
		</Card.Content>
	</Card.Root>
</div>
