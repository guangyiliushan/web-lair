<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';
	import { policyClaims, type PolicyFacts } from './policy-facts';

	/**
	 * The full link policy, rendered from live facts. `compact` only tightens
	 * typography for the apply dialog; it never drops a clause, because the
	 * consent checkbox points at this text.
	 */
	let { facts, variant = 'page' }: { facts: PolicyFacts; variant?: 'page' | 'compact' } = $props();

	const claims = $derived(policyClaims(facts));
	const sectionTitle = $derived(
		variant === 'compact' ? 'text-xs font-medium' : 'text-sm font-medium'
	);
	const body = $derived(
		variant === 'compact' ? 'text-xs leading-relaxed' : 'text-sm leading-relaxed'
	);
</script>

<div class={variant === 'compact' ? 'grid gap-3' : 'grid gap-5'}>
	<p class={cn(body, 'max-w-prose text-muted-foreground')}>{m.friends_policy_intro()}</p>

	<section class="grid gap-1">
		<h4 class={sectionTitle}>{m.friends_policy_site_title()}</h4>
		<p class={cn(body, 'max-w-prose text-muted-foreground')}>{m.friends_policy_site_body()}</p>
		{#if claims.homepageOnly}
			<p class={cn(body, 'max-w-prose text-muted-foreground')}>
				{m.friends_policy_homepage_clause()}
			</p>
		{/if}
	</section>

	<section class="grid gap-1">
		<h4 class={sectionTitle}>{m.friends_policy_domain_title()}</h4>
		<p class={cn(body, 'max-w-prose text-muted-foreground')}>
			{m.friends_policy_domain_body()}
		</p>
		{#if claims.domainDetail}
			<details class="max-w-prose">
				<summary class="cursor-pointer text-xs text-muted-foreground">
					{m.friends_policy_blocked_summary()}
				</summary>
				<div class="mt-2 flex flex-wrap gap-1">
					{#each [...facts.blockedHostSuffixes, ...facts.blockedTlds] as suffix (suffix)}
						<code class="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px]">{suffix}</code>
					{/each}
				</div>
			</details>
		{/if}
	</section>

	<section class="grid gap-1">
		<h4 class={sectionTitle}>{m.friends_policy_backlink_title()}</h4>
		<p class={cn(body, 'max-w-prose text-muted-foreground')}>
			{m.friends_policy_backlink_body({ count: claims.backlinkStreak })}
		</p>
	</section>

	<section class="grid gap-1">
		<h4 class={sectionTitle}>{m.friends_policy_review_title()}</h4>
		<p class={cn(body, 'max-w-prose text-muted-foreground')}>
			{m.friends_policy_review_body()}
		</p>
	</section>

	<section class="grid gap-1">
		<h4 class={sectionTitle}>{m.friends_policy_checks_title()}</h4>
		{#if claims.autoCheck}
			<p class={cn(body, 'max-w-prose text-muted-foreground')}>
				{#if claims.autoPrune}
					{m.friends_policy_checks_body_prune({
						count: claims.failStreak,
						days: claims.graceDays
					})}
				{:else}
					{m.friends_policy_checks_body({ count: claims.failStreak })}
				{/if}
			</p>
		{:else}
			<p class={cn(body, 'max-w-prose text-muted-foreground')}>
				{m.friends_policy_checks_off()}
			</p>
		{/if}
	</section>

	<section class="grid gap-1">
		<h4 class={sectionTitle}>{m.friends_policy_removal_title()}</h4>
		<p class={cn(body, 'max-w-prose text-muted-foreground')}>
			{#if claims.publicBannedList}
				{m.friends_policy_removal_body_public({ days: claims.emailRetentionDays })}
			{:else}
				{m.friends_policy_removal_body({ days: claims.emailRetentionDays })}
			{/if}
		</p>
	</section>
</div>
