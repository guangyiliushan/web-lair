<script lang="ts">
	import type { PageProps } from './$types';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';

	/**
	 * New user job (J-3): name + template + the same lazy CodeMirror editor.
	 * Saving goes through the J-2 gate with `baseHash: null`; a valid name
	 * creates `$DATA_DIR/jobs/<name>.ts` and the page redirects to the
	 * [name] editor (or the list, for save-and-run).
	 */

	let { data }: PageProps = $props();

	const editorPromise = import('$lib/components/admin/jobs/job-editor.svelte').then(
		(module) => module.default
	);

	let name = $state('');
	let code = $state(untrack(() => data.template));
	// The optimistic-lock token advances once a save landed, so a failed
	// save-and-run can still be retried without a fake 409 (J-3 review P3-R2-2).
	let baseHash = $state('');
	let saveForm: HTMLFormElement | undefined = $state();
	// Cold first saves run the gate's module init (~10s); pending state.
	let saving = $state(false);

	interface ActionResult {
		status?: number;
		message?: string;
		hash?: string;
		conflict?: boolean;
		currentHash?: string | null;
		errors?: {
			source: string;
			line: number | null;
			column: number | null;
			message: string;
			code?: string | number;
		}[];
	}

	const form = $derived(page.form as ActionResult | null | undefined);

	$effect(() => {
		if (form) saving = false;
		if (typeof form?.hash === 'string') baseHash = form.hash;
	});

	function submitSave(): void {
		if (saving) return;
		saving = true;
		saveForm?.requestSubmit();
	}
</script>

<svelte:head>
	<title>维护 · 新建脚本 - Lair Admin</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex min-w-0 items-center gap-2">
			<Button variant="ghost" size="sm" href="/admin/maintenance">
				<IconArrowLeft data-icon="inline-start" />
				返回
			</Button>
			<span class="text-sm font-semibold">新建脚本</span>
		</div>
	</div>

	{#if form && !form.conflict && !(form.errors && form.errors.length > 0) && typeof form.message === 'string'}
		<div
			class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
			role="status"
		>
			{String(form.message)}
		</div>
	{/if}
	{#if form?.conflict}
		<div
			class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
			role="alert"
		>
			{String(form.message ?? '同名脚本已存在')}
			<Button variant="outline" size="sm" class="ml-2" href="/admin/maintenance">返回列表</Button>
		</div>
	{/if}

	{#if form?.errors && form.errors.length > 0}
		<div
			class="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
			data-slot="gate-errors"
			role="alert"
		>
			<p class="mb-2 text-sm font-medium text-destructive">创建被拒绝：</p>
			<ul class="space-y-1">
				{#each form.errors as gateError, index (index)}
					<li class="font-mono text-xs break-all">
						{#if gateError.line !== null}
							<span class="text-muted-foreground"
								>{gateError.line}{gateError.column !== null ? `:${gateError.column}` : ''}</span
							>
						{/if}
						<span class="text-muted-foreground">[{gateError.source}]</span>
						{gateError.message}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<form method="POST" action="?/save" bind:this={saveForm} data-slot="new-form">
		<div class="mb-3 grid max-w-md gap-1">
			<label for="new-job-name" class="text-xs text-muted-foreground">
				任务名（小写字母/数字/连字符；不得与内置模块别名冲突，例如 my-task）
			</label>
			<Input
				id="new-job-name"
				name="name"
				bind:value={name}
				placeholder="my-task"
				class="font-mono"
				autocomplete="off"
			/>
		</div>
		<input type="hidden" name="code" value={code} />
		<input type="hidden" name="baseHash" value={baseHash} />
		<div class="h-[26rem] min-h-0 overflow-hidden rounded-lg border" data-slot="editor-host">
			{#await editorPromise then JobEditor}
				<JobEditor
					value={code}
					onChange={(value) => (code = value)}
					onSave={submitSave}
					ariaLabel="新建脚本编辑器"
				/>
			{:catch}
				<p class="p-4 text-xs text-destructive">编辑器加载失败（CodeMirror 模块导入失败）。</p>
			{/await}
		</div>
		<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
			<p class="text-xs text-muted-foreground">
				保存即生效（≤1 tick 执行）；保存并试运行会立即排队一次。
			</p>
			<div class="flex items-center gap-2">
				<Button
					type="submit"
					variant="outline"
					size="sm"
					onclick={(event) => {
						// Never flip `disabled` here: a disabled submitter aborts
						// the native form submission itself; gate repeats via
						// preventDefault instead.
						if (saving) {
							event.preventDefault();
							return;
						}
						saving = true;
					}}
				>
					{saving ? '保存中…' : '保存'}
				</Button>
				<Button
					type="submit"
					size="sm"
					formaction="?/saveRun"
					onclick={(event) => {
						if (saving) {
							event.preventDefault();
							return;
						}
						saving = true;
					}}
				>
					{saving ? '保存中…' : '保存并试运行'}
				</Button>
			</div>
		</div>
	</form>
</div>
