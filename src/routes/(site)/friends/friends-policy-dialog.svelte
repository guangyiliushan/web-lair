<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { cn } from '$lib/utils';
	import { m } from '$lib/paraglide/messages';
	import FriendsPolicy from './friends-policy.svelte';
	import type { PolicyFacts } from './policy-facts';

	/**
	 * Full link policy behind a trigger.
	 *
	 * The policy is long enough (six sections) to push the list and the form
	 * apart if it sits in the page flow, so it lives in an overlay: the page
	 * keeps one line of summary plus this link, and the text is scrollable
	 * inside the dialog. The apply form uses the same component, so the
	 * consent checkbox and the page cannot drift to different wording.
	 */
	let {
		facts,
		labelledBy = 'friends-policy-title',
		class: className
	}: {
		facts: PolicyFacts;
		/** Id of the visible heading this trigger belongs to. */
		labelledBy?: string;
		class?: string;
	} = $props();
</script>

<Dialog.Root>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<button
				type="button"
				{...props}
				aria-describedby={labelledBy}
				class={cn(
					'inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
					className
				)}
			>
				{m.friends_policy_view_full()}
			</button>
		{/snippet}
	</Dialog.Trigger>

	<Dialog.Content
		class="flex max-h-[min(80dvh,42rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
	>
		<Dialog.Header class="border-b px-5 py-4 pe-14">
			<Dialog.Title>{m.friends_policy_full_title()}</Dialog.Title>
		</Dialog.Header>
		<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
			<FriendsPolicy {facts} />
		</div>
	</Dialog.Content>
</Dialog.Root>
