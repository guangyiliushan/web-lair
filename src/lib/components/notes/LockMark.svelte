<script lang="ts">
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import { m } from '$lib/paraglide/messages';

	/**
	 * Shared lock marker for password-gated notes (list rows, timeline,
	 * mega menu): one markup, one screen-reader label (review finding).
	 * `class` carries the call-site size and tone.
	 */
	let { class: klass = 'size-3.5 text-muted-foreground/70' }: { class?: string } = $props();
</script>

<IconLock class="shrink-0 {klass}" role="img" aria-label={m.notes_locked()} />
