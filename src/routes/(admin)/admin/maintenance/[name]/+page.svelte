<script lang="ts">
	import type { PageProps } from './$types';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { DeleteConfirm } from '$lib/components/admin';
	import IconArrowLeft from '@tabler/icons-svelte-runes/icons/arrow-left';

	/**
	 * Script editor page (J-3, plan §5.6): CodeMirror behind a route-level
	 * dynamic import; the local `code`/`baseHash` pair is the optimistic-lock
	 * state and is NEVER auto-adopted from load data - after a 409 the user
	 * explicitly chooses "载入服务端最新" (drafts precedent). Mod-S submits the
	 * save form.
	 */

	let { data }: PageProps = $props();

	const editorPromise = import('$lib/components/admin/jobs/job-editor.svelte').then(
		(module) => module.default
	);

	let code = $state(data.saveCode);
	let baseHash = $state<string | null>(data.saveBaseHash);
	let saveForm: HTMLFormElement | undefined = $state();
	let deleteOpen = $state(false);
	// Cold gate loads (first save in a fresh server process) run tsc+eslint
	// module init, so the first POST can take ~10s - show a pending state
	// (J-2 review suggestion) instead of a seemingly dead button.
	let saving = $state(false);

	interface ActionResult {
		status?: number;
		message?: string;
		error?: string;
		errors?: {
			source: string;
			line: number | null;
			column: number | null;
			message: string;
			code?: string | number;
		}[];
		conflict?: boolean;
		currentHash?: string | null;
		saved?: boolean;
		created?: boolean;
		forked?: boolean;
		queued?: boolean;
		deduplicated?: boolean;
		hash?: string;
		reverted?: boolean;
		ignored?: boolean;
	}

	const form = $derived(page.form as ActionResult | null | undefined);

	// A successful save makes the server hash our new base.
	$effect(() => {
		if (form?.saved && typeof form.hash === 'string') baseHash = form.hash;
	});

	// Any action result (save / conflict / revert / ignore) ends the pending
	// window; a redirect unmounts the page entirely.
	$effect(() => {
		if (form) saving = false;
	});

	const flash = $derived.by(() => {
		if (!form) return null;
		if (form.conflict) {
			return {
				kind: 'conflict' as const,
				text: String(form.message ?? '脚本已在其他窗口更新'),
				currentHash: form.currentHash ?? null
			};
		}
		if (typeof form.status === 'number' && form.status >= 400) {
			return { kind: 'error' as const, text: String(form.message ?? form.error ?? '操作失败') };
		}
		if (form.saved) {
			const parts = ['已保存'];
			if (form.created && form.forked) parts.push('（首次保存：已创建用户副本并记录 fork 基线）');
			else if (form.created) parts.push('（新建）');
			if (form.queued) parts.push('，已排队试运行（≤1 分钟执行）');
			return { kind: 'ok' as const, text: parts.join('') };
		}
		if (form.reverted)
			return { kind: 'ok' as const, text: '已恢复内置版本（用户副本已移除，调度保留）' };
		if (form.ignored) return { kind: 'ok' as const, text: '已忽略此内置更新' };
		return null;
	});

	async function reloadFromServer(): Promise<void> {
		await invalidateAll();
		code = data.saveCode;
		baseHash = data.saveBaseHash;
	}

	function submitSave(): void {
		saving = true;
		saveForm?.requestSubmit();
	}
</script>

<svelte:head>
	<title>{`维护 · ${data.name} - Lair Admin`}</title>
</svelte:head>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex min-w-0 items-center gap-2">
			<Button variant="ghost" size="sm" href="/admin/maintenance">
				<IconArrowLeft data-icon="inline-start" />
				返回
			</Button>
			<span class="truncate font-mono text-sm font-semibold">{data.name}</span>
			<Badge variant="outline">{data.info.source === 'user' ? '用户' : '内置'}</Badge>
			{#if data.info.forked}<Badge variant="secondary">已 fork</Badge>{/if}
			{#if data.info.hasUpdate}<Badge>有更新</Badge>{/if}
			{#if data.info.dismissed}<Badge variant="outline">已忽略此版本</Badge>{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if data.info.hasUpdate}
				<form method="POST" action="?/ignoreUpdate">
					<Button type="submit" variant="outline" size="sm">忽略此版本</Button>
				</form>
			{/if}
			{#if data.info.forked}
				<form method="POST" action="?/revert">
					<Button type="submit" variant="outline" size="sm">恢复内置</Button>
				</form>
			{/if}
			{#if data.info.source === 'user' && !data.info.hasBuiltin}
				<Button variant="destructive" size="sm" onclick={() => (deleteOpen = true)}>删除</Button>
			{/if}
		</div>
	</div>

	<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
		<span class="min-w-0">{data.info.description}</span>
		<span>超时 {Math.round(data.info.timeoutMs / 1000)}s</span>
		{#if data.info.scheduleHint}<span>建议 cron：{data.info.scheduleHint}</span>{/if}
	</div>

	{#if flash}
		<div
			class="flex flex-wrap items-center gap-2 rounded-lg border px-4 py-2 text-sm {flash.kind ===
			'error'
				? 'border-destructive/40 bg-destructive/10 text-destructive'
				: flash.kind === 'conflict'
					? 'border-amber-500/40 bg-amber-500/10'
					: 'bg-muted/50 text-foreground'}"
			data-slot="maintenance-flash"
			role="status"
		>
			<span class="min-w-0">{flash.text}</span>
			{#if flash.kind === 'conflict'}
				<span class="text-xs text-muted-foreground">
					{flash.currentHash
						? `服务端 hash：${flash.currentHash.slice(0, 12)}…`
						: '服务端已无该文件（可能被删除）'}
				</span>
				<Button variant="outline" size="sm" onclick={reloadFromServer}>载入服务端最新</Button>
			{/if}
		</div>
	{/if}

	{#if form?.errors && form.errors.length > 0}
		<div
			class="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
			data-slot="gate-errors"
		>
			<p class="mb-2 text-sm font-medium text-destructive">保存被拒绝：</p>
			<ul class="space-y-1">
				{#each form.errors as gateError, index (index)}
					<li class="font-mono text-xs">
						{#if gateError.line !== null}
							<span class="text-muted-foreground">{gateError.line}:{gateError.column ?? ''}</span>
						{/if}
						<span class="text-muted-foreground">[{gateError.source}]</span>
						{gateError.message}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if data.userCode === null && data.info.hasBuiltin}
		<div class="rounded-lg border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
			尚未 fork：当前显示内置版本，首次保存将创建用户副本（sidecar 记录 fork
			基线，升级时提示而不覆盖）。
		</div>
	{/if}
	{#if data.info.hasUpdate}
		<div class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs">
			内置版本已有更新（fork 后仓库升级）。下方「内置对照」可查看差异；「忽略此版本」后不再提示。
		</div>
	{/if}

	<form method="POST" action="?/save" bind:this={saveForm} data-slot="save-form">
		<input type="hidden" name="code" value={code} />
		<input type="hidden" name="baseHash" value={baseHash ?? ''} />
		<div class="h-[30rem] min-h-0 overflow-hidden rounded-lg border" data-slot="editor-host">
			{#await editorPromise then JobEditor}
				<JobEditor
					value={code}
					onChange={(value) => (code = value)}
					onSave={submitSave}
					ariaLabel={`脚本编辑器：${data.name}`}
				/>
			{:catch}
				<p class="p-4 text-xs text-destructive">编辑器加载失败（CodeMirror 模块导入失败）。</p>
			{/await}
		</div>
		<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
			<p class="text-xs text-muted-foreground">
				Mod-S 保存 · 约定：可擦除语法（无 enum/namespace）/ import 带 .ts 后缀 / type 关键字
			</p>
			<div class="flex items-center gap-2">
				<Button
					type="submit"
					variant="outline"
					size="sm"
					onclick={(event) => {
						// A disabled flip would abort the native submit itself
						// (the submitter cannot be disabled); gate repeats by
						// canceling the click instead.
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

	{#if data.info.hasBuiltin && data.userCode !== null}
		<details class="rounded-lg border" data-slot="builtin-diff">
			<summary class="cursor-pointer px-4 py-2 text-sm font-medium select-none"
				>内置对照（只读）</summary
			>
			<div class="grid gap-2 border-t p-3 md:grid-cols-2">
				<div class="min-w-0">
					<p class="mb-1 text-xs font-medium text-muted-foreground">用户版本（当前运行）</p>
					<pre
						class="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed">{data.userCode}</pre>
				</div>
				<div class="min-w-0">
					<p class="mb-1 text-xs font-medium text-muted-foreground">内置版本（仓库）</p>
					<pre
						class="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed">{data.builtinCode}</pre>
				</div>
			</div>
		</details>
	{/if}
</div>

<DeleteConfirm
	open={deleteOpen}
	title="删除脚本"
	description={`确定删除「${data.name}」？其调度与排队中的运行会被一并清理（历史运行记录保留）。`}
	id={data.name}
	onclose={() => (deleteOpen = false)}
/>
