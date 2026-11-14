<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.admin_settings_title()} - Lair Admin</title>
</svelte:head>

<div class="space-y-6">
	<header class="space-y-1">
		<h2 class="text-base font-medium">{m.admin_settings_audit_title()}</h2>
		<p class="text-xs text-muted-foreground">{m.admin_settings_audit_hint()}</p>
	</header>

	<form method="GET" class="flex flex-wrap items-end gap-2">
		<label class="space-y-1 text-xs text-muted-foreground">
			<span class="block">{m.admin_settings_audit_filter()}</span>
			<select
				name="event"
				value={data.family}
				class="h-8 min-w-40 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
			>
				<option value="">{m.admin_settings_audit_all()}</option>
				{#each data.families as family (family)}
					<option value={family}>{family}</option>
				{/each}
			</select>
		</label>
		<Button type="submit" variant="outline" size="sm">{m.admin_settings_audit_apply()}</Button>
	</form>

	{#if data.events.length === 0}
		<p class="text-sm text-muted-foreground">{m.admin_settings_audit_empty()}</p>
	{:else}
		<ul class="divide-y overflow-hidden rounded-lg border">
			{#each data.events as event (event.id)}
				<li class="space-y-1 px-4 py-3">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<code class="text-xs">{event.event}</code>
						<time class="text-xs text-muted-foreground">{event.createdLabel}</time>
						<span class="ml-auto text-xs text-muted-foreground">
							{event.actorName ?? m.admin_settings_audit_no_actor()}
						</span>
					</div>
					{#if event.changes.length > 0}
						<ul class="space-y-0.5 text-xs text-muted-foreground">
							{#each event.changes as change (change.field)}
								<li>
									<span class="font-medium text-foreground">{change.field}</span>:
									{change.before}
									→
									{change.after}
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
