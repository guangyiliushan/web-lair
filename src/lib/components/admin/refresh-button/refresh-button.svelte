<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const refreshButtonVariants = tv({
		base: 'inline-flex shrink-0 items-center justify-center rounded-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50',
		variants: {
			size: {
				default: 'size-7 [&_svg]:size-3.5',
				sm: 'size-6 [&_svg]:size-3',
				lg: 'size-8 [&_svg]:size-4'
			}
		},
		defaultVariants: {
			size: 'default'
		}
	});

	export type RefreshButtonSize = VariantProps<typeof refreshButtonVariants>['size'];
</script>

<script lang="ts">
	import { cn } from '$lib/utils';
	import IconRefresh from '@tabler/icons-svelte-runes/icons/refresh';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { m } from '$lib/paraglide/messages';

	type Props = HTMLButtonAttributes & {
		size?: RefreshButtonSize;
		/** Show a spinning animation while refreshing */
		loading?: boolean;
		/** Accessible label for screen readers */
		label?: string;
	};

	let {
		class: className,
		size = 'default',
		loading = false,
		label = m.admin_common_refresh(),
		disabled,
		type = 'button',
		...restProps
	}: Props = $props();
</script>

<button
	{type}
	aria-label={label}
	title={label}
	disabled={disabled || loading}
	class={cn(
		refreshButtonVariants({ size }),
		'text-muted-foreground hover:bg-muted hover:text-foreground',
		className
	)}
	{...restProps}
>
	<IconRefresh class={cn(loading && 'animate-spin')} />
</button>
