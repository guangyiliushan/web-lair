<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import { formatDateTime } from './console-view';
	import IconBrain from '@tabler/icons-svelte-runes/icons/brain';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconX from '@tabler/icons-svelte-runes/icons/x';

	interface MemoryRow {
		id: string;
		content: string;
		createdAt: Date | string | null;
	}

	interface Props {
		memories: readonly MemoryRow[];
		memoryLimit: number;
	}

	let { memories, memoryLimit }: Props = $props();

	const locale = getLocale();

	let dialogOpen = $state(false);
	let editing = $state<MemoryRow | null>(null);
	let saving = $state(false);
	let content = $state('');
	let deleteTarget = $state<MemoryRow | null>(null);

	function openCreate() {
		editing = null;
		content = '';
		dialogOpen = true;
	}

	function openEdit(memory: MemoryRow) {
		editing = memory;
		content = memory.content;
		dialogOpen = true;
	}
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-xs text-muted-foreground">
			{m.admin_ai_memory_hint({ limit: memoryLimit, count: memories.length })}
		</p>
		<Button type="button" variant="outline" size="sm" onclick={openCreate}>
			<IconPlus data-icon="inline-start" />
			{m.admin_ai_memory_new()}
		</Button>
	</div>

	{#if memories.length === 0}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon">
					<IconBrain />
				</Empty.Media>
				<Empty.Title>{m.admin_ai_memory_empty()}</Empty.Title>
				<Empty.Description>{m.admin_ai_memory_empty_desc()}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			{#each memories as memory (memory.id)}
				<div class="flex flex-col gap-3 rounded-xl border p-4">
					<p class="text-sm whitespace-pre-wrap">{memory.content}</p>
					<div class="mt-auto flex items-center justify-between gap-2">
						<span class="text-xs text-muted-foreground tabular-nums">
							{formatDateTime(memory.createdAt, locale)}
						</span>
						<div class="flex items-center gap-2">
							<Button variant="outline" size="sm" onclick={() => openEdit(memory)}>
								<IconPencil data-icon="inline-start" />
								{m.admin_common_edit()}
							</Button>
							<Button
								variant="destructive"
								size="sm"
								data-testid="memory-card-delete"
								onclick={() => (deleteTarget = memory)}
							>
								<IconTrash data-icon="inline-start" />
								{m.admin_common_delete()}
							</Button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form
			method="post"
			action="?/saveMemory"
			use:enhance={() => {
				saving = true;
				return async ({ result, update }) => {
					saving = false;
					if (result.type === 'success') dialogOpen = false;
					await update({ reset: false });
				};
			}}
		>
			{#if editing}
				<input type="hidden" name="id" value={editing.id} />
			{/if}
			<div class="flex items-center justify-between gap-3 border-b px-4 pb-3">
				<Dialog.Title>
					{editing ? m.admin_ai_memory_edit() : m.admin_ai_memory_new()}
				</Dialog.Title>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button
							variant="ghost"
							size="icon"
							class="size-7"
							{...props}
							aria-label={m.admin_common_close()}
						>
							<IconX class="size-4" />
						</Button>
					{/snippet}
				</Dialog.Close>
			</div>
			<div class="px-4 py-4">
				<Field.FieldGroup>
					<Field.Field>
						<Field.FieldLabel for="memory-content">
							{m.admin_ai_memory_content()}
						</Field.FieldLabel>
						<Textarea
							id="memory-content"
							name="content"
							rows={5}
							bind:value={content}
							maxlength={2000}
							placeholder={m.admin_ai_memory_placeholder()}
						/>
					</Field.Field>
				</Field.FieldGroup>
			</div>
			<div class="flex items-center justify-end gap-2 border-t px-4 pt-3">
				<Dialog.Close>
					{#snippet child({ props })}
						<Button variant="outline" {...props}>{m.admin_common_cancel()}</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={saving}>
					{#if saving}<Spinner data-icon="inline-start" />{/if}
					{m.admin_common_save()}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => {
		if (!open) deleteTarget = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_ai_memory_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_ai_memory_delete_desc({
					preview: (deleteTarget?.content ?? '').slice(0, 40)
				})}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form
				method="post"
				action="?/deleteMemory"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'success') deleteTarget = null;
						await update({ reset: false });
					}}
			>
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<Button type="submit" variant="destructive">{m.admin_common_delete()}</Button>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
