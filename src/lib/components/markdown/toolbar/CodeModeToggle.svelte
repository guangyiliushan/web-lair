<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import IconCode from '@tabler/icons-svelte-runes/icons/code';
	import IconRichText from '@tabler/icons-svelte-runes/icons/writing';
	import { m } from '$lib/paraglide/messages';

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
				aria-label={codeMode ? m.editor_switch_rich() : m.editor_switch_code()}
				title={codeMode ? m.editor_switch_rich() : m.editor_switch_code()}
			>
				{#if codeMode}
					<IconRichText data-icon="inline-start" />
				{:else}
					<IconCode data-icon="inline-start" />
				{/if}
			</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>{codeMode ? m.editor_mode_rich() : m.editor_mode_code()}</Tooltip.Content>
</Tooltip.Root>
