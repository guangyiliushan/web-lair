<script lang="ts">
	import type { PageProps } from './$types';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { applyAction, enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
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

	// enhance keeps the editor buffer alive across rejected saves (J-3 review
	// F1): a plain native POST reloads the page and adopts the file on disk,
	// silently discarding the user's edits. applyAction renders the result in
	// place (conflict freeze / gate errors / saved flash) and still navigates
	// on redirects; nothing is auto-adopted into the buffer. When the load
	// data flips (created, or `forked` - which reports "builtin-backed" and
	// therefore re-flips on EVERY save of such a script), refresh it FIRST
	// and re-apply the action afterwards: invalidateAll clears `page.form`
	// (sveltejs/kit#13825), so applying before it would wipe the 已保存 flash
	// (J-3 复核 v2 #1). `pristine` is the SUBMITTED snapshot, not the live
	// buffer: edits typed while the POST is in flight are not saved and must
	// keep the unsaved-changes guard armed (J-3 复核 v2 #2).
	const enhanceKeepBuffer: SubmitFunction =
		({ formData }) =>
		async ({ result }) => {
			const submittedCode = String(formData.get('code') ?? '');
			if (result.type === 'success' && (result.data?.created || result.data?.forked)) {
				await invalidateAll();
			}
			await applyAction(result);
			const landed =
				result.type === 'success' || result.type === 'failure'
					? (result.data as { hash?: string } | undefined)
					: undefined;
			if (typeof landed?.hash === 'string') {
				pristine = submittedCode;
			}
		};

	const editorPromise = import('$lib/components/admin/jobs/job-editor.svelte').then(
		(module) => module.default
	);

	let code = $state(untrack(() => data.saveCode));
	let baseHash = $state<string | null>(untrack(() => data.saveBaseHash));
	// Unsaved-changes baseline (J-3 review P3-18, drafts/edit precedent).
	let pristine = $state(untrack(() => data.saveCode));
	const dirty = $derived(code !== pristine);
	let saveForm: HTMLFormElement | undefined = $state();
	let deleteOpen = $state(false);
	let revertOpen = $state(false);
	// Cold gate loads (first save in a fresh server process) run tsc+eslint
	// module init, so the first POST can take ~10s - show a pending state
	// (J-2 review suggestion) instead of a seemingly dead button.
	let saving = $state(false);
	// Conflict freeze (J-3 review P2-6, drafts precedent): after a 409 the
	// editor keeps the buffer but saving is paused until the server state is
	// loaded explicitly - otherwise the next save just produces another 409.
	// LOCAL state is the single source for the banner; `page.form` may or may
	// not survive invalidateAll (sveltejs/kit#13825 - J-3 reviews F1/R2-1),
	// so the hash is snapshotted alongside.
	let conflicted = $state(false);
	let conflictHash = $state<string | null>(null);

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

	// The server hash becomes our new base whenever a save landed - including
	// a save-and-run whose enqueue half failed (`hash` rides the fail payload;
	// retrying against a stale token would fake a 409, J-3 review P3-R2-2).
	// `pristine` advances in the submit callback from the SUBMITTED snapshot
	// (复核 v2 #2); `reverted` rewrites both the buffer and the token: after
	// 恢复内置 the user file is gone, so the old hash can never match again
	// (review F1).
	$effect(() => {
		if (typeof form?.hash === 'string') {
			baseHash = form.hash;
		}
		if (form?.reverted) {
			code = untrack(() => data.saveCode);
			baseHash = untrack(() => data.saveBaseHash);
			pristine = untrack(() => data.saveCode);
			conflicted = false;
			conflictHash = null;
		}
	});

	// Any action result ends the pending window; a redirect unmounts the page
	// entirely. The conflict freeze stays LOCAL (single source); a successful
	// save (or revert) clears it.
	$effect(() => {
		if (form) saving = false;
		if (form?.conflict) {
			conflicted = true;
			conflictHash = form.currentHash ?? null;
		}
		if (form?.saved) {
			conflicted = false;
			conflictHash = null;
		}
	});

	// Dialog error text: an action failure the user must see inside the
	// overlay (a page banner hides behind it - DeleteConfirm contract).
	// `form.status` is never set by kit, so the payload keys are the signal
	// (J-3 review R4-1); the old generic fallback went stale across actions
	// (review P3-R2-4) - no message, no dialog text.
	const dialogError = $derived(
		form && !form.conflict && (typeof form.message === 'string' || typeof form.error === 'string')
			? String(form.message ?? form.error)
			: null
	);

	const flash = $derived.by(() => {
		if (conflicted) {
			return {
				kind: 'conflict' as const,
				text: '脚本已在其他窗口更新（乐观锁失配）',
				currentHash: conflictHash
			};
		}
		if (!form) return null;
		if (form.conflict) return null; // stale conflict payload after a reload
		if (form.errors && form.errors.length > 0) return null; // gate block speaks
		if (typeof form.error === 'string' || typeof form.message === 'string') {
			return { kind: 'error' as const, text: String(form.message ?? form.error) };
		}
		if (form.saved) {
			const parts = ['已保存'];
			if (form.created && form.forked) parts.push('（首次保存：已创建用户副本并记录 fork 基线）');
			else if (form.created) parts.push('（新建）');
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
		pristine = data.saveCode;
		saving = false;
		conflicted = false;
		conflictHash = null;
	}

	// Unsaved-changes guard (J-3 review P3-18, drafts/edit precedent).
	// `saving` exempts the editor's own submit navigation - that navigation
	// IS the save; anything else with an unpristine buffer asks first.
	$effect(() => {
		if (!dirty) return;
		const guard = (event: BeforeUnloadEvent): void => {
			if (saving) return;
			event.preventDefault();
		};
		window.addEventListener('beforeunload', guard);
		return () => window.removeEventListener('beforeunload', guard);
	});

	function submitSave(): void {
		// Re-entry guard for the Mod-S path too (J-3 review J3-7): a second
		// requestSubmit carries the stale baseHash and would surface a fake
		// conflict for a save that already landed.
		if (saving || conflicted) return;
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
				<Button variant="outline" size="sm" onclick={() => (revertOpen = true)}>恢复内置</Button>
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
						: '服务端已无该文件（可能被删除）'} · 保存已暂停
				</span>
				<Button variant="outline" size="sm" onclick={reloadFromServer}>
					载入服务端最新（放弃当前编辑）
				</Button>
			{/if}
		</div>
	{/if}

	{#if form?.errors && form.errors.length > 0}
		<div
			class="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
			data-slot="gate-errors"
			role="alert"
		>
			<p class="mb-2 text-sm font-medium text-destructive">保存被拒绝：</p>
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

	<form
		method="POST"
		action="?/save"
		use:enhance={enhanceKeepBuffer}
		bind:this={saveForm}
		data-slot="save-form"
	>
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
					disabled={conflicted}
					onclick={(event) => {
						// While `saving` repeats are canceled here (a disabled
						// flip would abort the native submit itself); the
						// conflicted freeze uses disabled - no in-flight
						// submit exists to interrupt (J-3 review F3).
						if (saving || conflicted) {
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
					disabled={conflicted}
					onclick={(event) => {
						if (saving || conflicted) {
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
	error={dialogError}
	onclose={() => (deleteOpen = false)}
/>
<DeleteConfirm
	open={revertOpen}
	title="恢复内置"
	description={`确定将「${data.name}」恢复为内置版本？用户副本将被移除（调度保留）。`}
	id={data.name}
	action="?/revert"
	confirmLabel="恢复"
	error={dialogError}
	onclose={() => (revertOpen = false)}
/>
