<script lang="ts">
	import { enhance } from '$app/forms';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import { MarkdownEditor } from '$lib/components/markdown';
	import { untrack } from 'svelte';
	import { MOMENT_KINDS, type MomentKind } from '$lib/utils/moment-meta';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';

	let { data, form }: PageProps = $props();

	const LIST_PATH = '/admin/moments';
	const KIND_LABELS: Record<MomentKind, string> = {
		life: m.admin_moments_kind_life(),
		tech: m.admin_moments_kind_tech(),
		media: m.admin_moments_kind_media(),
		other: m.admin_moments_kind_other()
	};

	// Snapshot the loader values: the dirty check compares against them and the
	// editor reads `initialMarkdown` once at mount. `untrack` keeps the read out
	// of the reactive graph (state_referenced_locally).
	const initialContent = untrack(() => data.moment?.content ?? '');
	const initialKind = untrack(() => (data.moment?.type as MomentKind) ?? 'life');

	let content = $state(initialContent);
	let kind = $state<MomentKind>(initialKind);
	let saving = $state(false);
	// Set once a save is in flight: the action answers a redirect and the
	// unsaved-changes guard must not cancel that navigation.
	let allowLeave = $state(false);
	let leaveOpen = $state(false);
	let pendingHref = $state<string | null>(null);

	/** Compare ignoring newline style and trailing whitespace: the editor's
	 *  markdown projection may normalise both on mount, which must not read as
	 *  an edit (otherwise the page opens "unsaved" and guards every exit). */
	function normalizeDraft(value: string): string {
		return value.replace(/\r\n?/g, '\n').trim();
	}

	const isDirty = $derived(
		normalizeDraft(content) !== normalizeDraft(initialContent) || kind !== initialKind
	);
	const errorMessage = $derived(form && 'error' in form ? (form.error as string) : null);

	let formEl: HTMLFormElement | null = $state(null);

	// No drafts for moments (draft.ref_type whitelist), so an accidental leave
	// is the only way to lose work: warn on tab close and on in-app navigation.
	$effect(() => {
		const handler = (event: BeforeUnloadEvent) => {
			if (!allowLeave && isDirty) {
				event.preventDefault();
				event.returnValue = '';
			}
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	});

	beforeNavigate(({ cancel, to }) => {
		if (allowLeave || !isDirty) return;
		cancel();
		pendingHref = to?.url?.href ?? null;
		leaveOpen = true;
	});

	function leaveWithoutSaving() {
		allowLeave = true;
		leaveOpen = false;
		void goto(pendingHref ?? resolve(LIST_PATH));
	}

	function save() {
		if (saving || !content.trim()) return;
		saving = true;
		allowLeave = true;
		formEl?.requestSubmit();
	}
</script>

<svelte:head>
	<title>
		{data.moment ? m.admin_moments_edit() : m.admin_moments_new()} - Lair Admin
	</title>
</svelte:head>

<!-- Hidden submit form: the visible controls drive it (the editor owns the
     body, so the payload is mirrored into hidden inputs on every change). -->
<form
	id="moment-form"
	method="POST"
	action="?/save"
	class="hidden"
	bind:this={formEl}
	use:enhance={() => {
		return async ({ result, update }) => {
			// Always run the update: a success/redirect must navigate away, or the
			// page stays on "Saving..." forever (the enhance default was skipped).
			// Only a failure restores the leave guard - the edits are still unsaved.
			await update();
			if (result.type === 'failure' || result.type === 'error') {
				saving = false;
				allowLeave = false;
			}
		};
	}}
>
	{#if data.moment}
		<input type="hidden" name="id" value={data.moment.id} />
	{/if}
	<input type="hidden" name="content" value={content} />
	<input type="hidden" name="type" value={kind} />
</form>

<div class="flex h-full min-h-0 min-w-0 flex-col">
	<div class="flex min-h-full min-w-0 flex-col bg-background">
		<div class="mx-auto w-full max-w-5xl shrink-0 px-3 pt-8">
			<div class="mb-3 flex min-h-7 items-center justify-between gap-3">
				<div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<span class="truncate text-sm font-medium text-foreground">
						{data.moment ? m.admin_moments_edit() : m.admin_moments_new()}
					</span>
					{#if isDirty}
						<span
							class="shrink-0 rounded-sm bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-400"
						>
							{m.admin_moments_edit_unsaved_hint()}
						</span>
					{/if}
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<div
						class="flex flex-wrap items-center gap-1.5"
						role="group"
						aria-label={m.admin_moments_kind()}
					>
						{#each MOMENT_KINDS as option (option)}
							<button
								type="button"
								aria-pressed={kind === option}
								class="rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {kind ===
								option
									? 'border-primary/40 bg-primary/10 text-primary'
									: 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
								onclick={() => (kind = option)}
							>
								{KIND_LABELS[option]}
							</button>
						{/each}
					</div>
					<Button
						type="button"
						size="sm"
						class="h-7 gap-1 px-2.5 text-xs"
						onclick={save}
						disabled={saving || !content.trim()}
					>
						<IconDeviceFloppy class="size-3" />
						{saving ? m.admin_moments_edit_saving() : m.admin_common_save()}
					</Button>
				</div>
			</div>

			{#if errorMessage}
				<p
					role="alert"
					class="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
				>
					{errorMessage}
				</p>
			{/if}
		</div>

		<!-- Editor area: same shell as the posts / notes editors. -->
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="mx-auto flex w-full max-w-5xl flex-1 flex-col px-3">
				<MarkdownEditor
					initialMarkdown={initialContent}
					placeholder={m.admin_moments_content_ph()}
					stickyToolbar={true}
					borderless={true}
					class="min-h-0 flex-1"
					onChange={(detail) => {
						content = detail.markdown;
					}}
				/>
			</div>
		</div>
	</div>
</div>

<AlertDialog.Root open={leaveOpen} onOpenChange={(next) => (leaveOpen = next)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_moments_edit_unsaved_title()}</AlertDialog.Title>
			<AlertDialog.Description>{m.admin_moments_edit_unsaved_desc()}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_moments_edit_stay()}</AlertDialog.Cancel>
			<Button variant="destructive" onclick={leaveWithoutSaving}>
				{m.admin_moments_edit_leave()}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
