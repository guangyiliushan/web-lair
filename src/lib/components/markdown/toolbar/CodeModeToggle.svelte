<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import IconCode from '@tabler/icons-svelte-runes/icons/code';
	import IconRichText from '@tabler/icons-svelte-runes/icons/writing';

	type Props = {
		/** 当前是否为代码模式 */
		codeMode: boolean;
		/** 切换模式回调 */
		onToggle: () => void;
	};

	let { codeMode, onToggle }: Props = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<Button
				variant={codeMode ? 'secondary' : 'ghost'}
				size="icon-sm"
				{...props}
				onclick={onToggle}
				aria-label={codeMode ? '切换到富文本模式' : '切换到代码模式'}
				title={codeMode ? '切换到富文本模式' : '切换到代码模式'}
			>
				{#if codeMode}
					<IconRichText data-icon="inline-start" />
				{:else}
					<IconCode data-icon="inline-start" />
				{/if}
			</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>{codeMode ? '富文本模式' : '代码模式'}</Tooltip.Content>
</Tooltip.Root>
