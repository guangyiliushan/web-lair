<script lang="ts">
	import { untrack } from 'svelte';
	import JobEditor from './job-editor.svelte';

	/**
	 * Browser-spec host for the job editor (mirrors ToolbarTestHost): drives
	 * the value prop, echoes onChange, counts onSave - so the spec can assert
	 * real DOM state instead of component internals.
	 */
	interface Props {
		initial?: string;
		readonly?: boolean;
		reloadValue?: string;
	}
	let { initial = '', readonly = false, reloadValue = 'RELOADED\n' }: Props = $props();

	// Seed-once semantics: the host takes the prop's initial value only.
	let current = $state(untrack(() => initial));
	let lastChange = $state('');
	let saveCount = $state(0);
</script>

<div>
	<button type="button" data-testid="reload" onclick={() => (current = reloadValue)}>reload</button>
	<span data-testid="change-echo">{lastChange}</span>
	<span data-testid="save-count">{saveCount}</span>
	<div class="h-40 w-full">
		<JobEditor
			value={current}
			{readonly}
			onChange={(next) => (lastChange = next)}
			onSave={() => (saveCount += 1)}
		/>
	</div>
</div>
