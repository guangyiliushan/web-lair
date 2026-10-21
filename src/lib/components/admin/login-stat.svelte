<script lang="ts">
	import { cn } from '$lib/utils';
	import { formatDateTime } from '$lib/utils/i18n';
	import IconShield from '@tabler/icons-svelte-runes/icons/shield';
	import IconWorld from '@tabler/icons-svelte-runes/icons/world';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		/** ISO timestamp of the previous admin session; null when unavailable. */
		lastLoginAt: string | null;
		lastLoginIp: string | null;
		/** No previous session: the current session is shown as the first login. */
		firstLogin?: boolean;
		/** IANA zone for the displayed timestamp. */
		timeZone?: string;
		class?: string;
	}

	let {
		lastLoginAt,
		lastLoginIp,
		firstLogin = false,
		timeZone = 'UTC',
		class: className
	}: Props = $props();

	const loginLabel = $derived(firstLogin ? m.admin_login_stat_first() : m.admin_login_stat_time());
	const loginDisplay = $derived(
		lastLoginAt
			? formatDateTime(new Date(lastLoginAt), {
					timeZone,
					dateStyle: 'medium',
					timeStyle: 'short'
				})
			: '—'
	);
</script>

<div
	class={cn(
		'grid gap-2 border-t border-border py-4 text-sm text-muted-foreground sm:grid-cols-2',
		className
	)}
>
	<div class="inline-flex min-w-0 items-center gap-2">
		<IconShield class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<span class="shrink-0">{loginLabel}</span>
		{#if lastLoginAt}
			<time class="min-w-0 truncate text-foreground" datetime={lastLoginAt}>{loginDisplay}</time>
		{:else}
			<span class="min-w-0 truncate text-foreground">—</span>
		{/if}
	</div>
	<div class="inline-flex min-w-0 items-center gap-2 sm:justify-end">
		<IconWorld class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<span class="shrink-0">{m.admin_login_stat_ip()}</span>
		<span class="text-foreground">
			{lastLoginIp?.trim() ? lastLoginIp : '—'}
		</span>
	</div>
</div>
