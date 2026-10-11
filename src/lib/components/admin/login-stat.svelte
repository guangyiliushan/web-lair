<script lang="ts">
	import { cn } from '$lib/utils';
	import IconShield from '@tabler/icons-svelte-runes/icons/shield';
	import IconWorld from '@tabler/icons-svelte-runes/icons/world';
	import { m } from '$lib/paraglide/messages';

	interface Props {
		lastLoginTime: string;
		lastLoginIp: string | null;
		class?: string;
	}

	let { lastLoginTime, lastLoginIp, class: className }: Props = $props();
</script>

<div
	class={cn(
		'grid gap-2 border-t border-border py-4 text-sm text-muted-foreground sm:grid-cols-2',
		className
	)}
>
	<div class="inline-flex min-w-0 items-center gap-2">
		<IconShield class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<span class="shrink-0">{m.admin_login_stat_time()}</span>
		<time class="min-w-0 truncate text-foreground" datetime={lastLoginTime}>
			{lastLoginTime}
		</time>
	</div>
	<div class="inline-flex min-w-0 items-center gap-2 sm:justify-end">
		<IconWorld class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<span class="shrink-0">{m.admin_login_stat_ip()}</span>
		<span class="text-foreground">
			{lastLoginIp ?? 'N/A'}
		</span>
	</div>
</div>
