<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as Table from '$lib/components/ui/table';
	import { cn } from '$lib/utils';
	import {
		formatPrice,
		rowsFromPricing,
		type AiPricing,
		type PriceField,
		type PricingRow
	} from '$lib/utils/pricing';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconCloudDownload from '@tabler/icons-svelte-runes/icons/cloud-download';
	import IconBraces from '@tabler/icons-svelte-runes/icons/braces';

	/**
	 * The price table, edited as rows instead of JSON.
	 *
	 * Why rows: the option is keyed `<provider>/<model>`, so the JSON document
	 * forces the operator to remember a key format and three field names; one
	 * typo silently unprices a model, and an unpriced call is indistinguishable
	 * from "never configured". A row per key also lets the table say which
	 * numbers came from models.dev and which are hand-pinned.
	 *
	 * Layout: ONE semantic table, no duplicated inputs. Below a 40rem container
	 * the table's rows become stacked cards (cells turn into labelled blocks), so
	 * nothing is submitted twice and nothing overflows horizontally.
	 */

	interface SyncDiff {
		added: string[];
		changed: string[];
		kept: string[];
		unresolved: string[];
	}

	interface Props {
		pricing: AiPricing;
		/** `<provider>/<model>` keys the app can actually call. */
		known: readonly string[];
		canManage: boolean;
		/** Row index -> the cell that failed (server validation). */
		errors?: Record<string, string> | null;
		/** Diff computed by `?/previewPricingSync`; opens the confirm dialog. */
		sync?: SyncDiff | null;
	}

	let { pricing, known, canManage, errors = null, sync = null }: Props = $props();

	interface RowDraft {
		key: string;
		input: string;
		output: string;
		chars: string;
		source?: 'catalog' | 'manual';
	}

	function toDraft(row: PricingRow): RowDraft {
		return {
			key: row.key,
			input: formatPrice(row.inputPer1M),
			output: formatPrice(row.outputPer1M),
			chars: formatPrice(row.per1MChars),
			source: row.source
		};
	}

	function draftsFrom(value: AiPricing): RowDraft[] {
		return rowsFromPricing(value).map(toDraft);
	}

	let rows = $state<RowDraft[]>(untrack(() => draftsFrom(pricing)));
	let dirty = $state(false);
	let advancedOpen = $state(false);
	let jsonText = $state(untrack(() => JSON.stringify(pricing ?? {}, null, 2)));
	let syncOpen = $state(false);

	// Re-seed from the load whenever the server hands us new data - but never
	// over unsaved edits (the page keeps its own dirty guard for the same reason).
	$effect(() => {
		const next = pricing;
		if (dirty) return;
		rows = draftsFrom(next);
		jsonText = JSON.stringify(next ?? {}, null, 2);
	});

	// A completed preview arrives as action data; the dialog is the answer to it.
	$effect(() => {
		if (sync) syncOpen = true;
	});

	const configured = $derived(new Set(known));
	const priced = $derived(new Set(rows.filter((row) => row.key).map((row) => row.key)));
	/** Configured models with no row yet - the only candidates for "add". */
	const availableKeys = $derived(known.filter((key) => !priced.has(key)));
	const orphanCount = $derived(rows.filter((row) => row.key && !configured.has(row.key)).length);
	const unpricedCount = $derived(
		known.filter((key) => !priced.has(key)).length + rows.filter((row) => !row.key).length
	);

	const COLUMNS: { field: PriceField; label: () => string }[] = [
		{ field: 'inputPer1M', label: () => m.admin_settings_ai_pricing_col_input() },
		{ field: 'outputPer1M', label: () => m.admin_settings_ai_pricing_col_output() },
		{ field: 'per1MChars', label: () => m.admin_settings_ai_pricing_col_chars() }
	];

	const CELL: Record<PriceField, keyof RowDraft> = {
		inputPer1M: 'input',
		outputPer1M: 'output',
		per1MChars: 'chars'
	};

	/**
	 * Server error for this row/cell, so the message sits next to the input. The
	 * server indexes only the rows it received, and a not-yet-picked "add" row
	 * submits nothing - hence the offset.
	 */
	function cellError(index: number, field: PriceField | 'key'): string | null {
		const submitted = rows.slice(0, index).filter((row) => row.key).length;
		const failed = errors?.[String(submitted)];
		if (!failed) return null;
		return failed === field ? m.admin_settings_ai_err_pricing_rows() : null;
	}

	function addRow(): void {
		rows = [...rows, { key: '', input: '', output: '', chars: '' }];
	}

	function pickKey(index: number, key: string): void {
		rows = rows.map((row, at) => (at === index ? { ...row, key, source: 'manual' } : row));
		dirty = true;
	}

	function removeRow(index: number): void {
		rows = rows.filter((_, at) => at !== index);
		dirty = true;
	}

	function providerOf(key: string): string {
		const at = key.indexOf('/');
		return at > 0 ? key.slice(0, at) : key;
	}

	function modelOf(key: string): string {
		const at = key.indexOf('/');
		return at > 0 ? key.slice(at + 1) : key;
	}

	function syncBadge(row: RowDraft) {
		if (!configured.has(row.key)) return m.admin_settings_ai_pricing_unknown_model();
		if (row.source === 'catalog') return m.admin_settings_ai_pricing_source_catalog();
		if (row.source === 'manual') return m.admin_settings_ai_pricing_source_manual();
		return null;
	}
</script>

<!-- `@container` makes the layout follow the CARD width, not the viewport: the
     sidebar collapse changes the available width at a fixed viewport. -->
<div class="@container rounded-lg border">
	<form
		method="post"
		action="?/savePricing"
		class="flex flex-col gap-3 p-4"
		oninput={() => (dirty = true)}
		use:enhance={() =>
			async ({ result, update }) => {
				if (result.type === 'success') dirty = false;
				await update();
			}}
	>
		<div class="flex flex-col gap-1">
			<h3 class="text-sm font-semibold">{m.admin_settings_ai_pricing()}</h3>
			<p class="text-xs text-muted-foreground">{m.admin_settings_ai_pricing_desc()}</p>
		</div>

		{#if rows.length === 0}
			<p
				class="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground"
			>
				{m.admin_settings_ai_pricing_empty()}
			</p>
		{:else}
			<Table.Root class="block text-sm @min-[40rem]:table">
				<Table.Header class="hidden @min-[40rem]:table-header-group">
					<Table.Row class="hover:bg-transparent">
						<Table.Head>{m.admin_settings_ai_pricing_row_model()}</Table.Head>
						{#each COLUMNS as column (column.field)}
							<Table.Head class="w-28 text-right">{column.label()}</Table.Head>
						{/each}
						<Table.Head class="w-10"></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body class="block @min-[40rem]:table-row-group">
					{#each rows as row, index (index)}
						{@const errorKey = cellError(index, 'key')}
						<Table.Row
							class="flex flex-col gap-2 border-b p-2 last:border-0 @min-[40rem]:table-row @min-[40rem]:p-0"
						>
							<Table.Cell class="block p-0 align-middle @min-[40rem]:table-cell @min-[40rem]:p-2">
								{#if row.key}
									<div class="flex min-w-0 flex-wrap items-center gap-1.5">
										<span class="truncate text-sm font-medium">{modelOf(row.key)}</span>
										{#if syncBadge(row)}
											<Badge variant="outline" class="shrink-0 text-[11px]">
												{syncBadge(row)}
											</Badge>
										{/if}
										<span class="w-full truncate text-xs text-muted-foreground">
											{providerOf(row.key)}
										</span>
									</div>
									<input type="hidden" name="key" value={row.key} />
								{:else}
									<!-- A row only joins the save once a model is picked: an
									     unpicked row submits nothing, so it cannot fail validation.
									     A native select on purpose - it needs no portal and its
									     `change` event is what a keyboard user produces too. -->
									<select
										class="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
										aria-label={m.admin_settings_ai_pricing_row_model()}
										onchange={(event) => pickKey(index, event.currentTarget.value)}
									>
										<option value="">{m.admin_settings_ai_pricing_row_model()}</option>
										{#each availableKeys as key (key)}
											<option value={key}>{key}</option>
										{/each}
									</select>
								{/if}
								{#if errorKey}
									<p class="mt-1 text-xs text-destructive">{errorKey}</p>
								{/if}
							</Table.Cell>

							{#each COLUMNS as column (column.field)}
								{@const field = CELL[column.field]}
								{@const error = cellError(index, column.field)}
								<Table.Cell
									class="flex items-center gap-2 p-0 align-middle @min-[40rem]:table-cell @min-[40rem]:p-2"
								>
									<!-- Compact tier: the column header is gone, so the cell
									     carries its own label instead of relying on position. -->
									<span
										class="w-24 shrink-0 text-xs text-muted-foreground @min-[40rem]:hidden"
										data-pricing-label={column.field}
									>
										{column.label()}
									</span>
									<div class="flex min-w-0 flex-1 flex-col gap-1 @min-[40rem]:block">
										<Input
											name={column.field}
											value={row[field]}
											disabled={!row.key}
											inputmode="decimal"
											autocomplete="off"
											class={cn(
												'h-8 w-full text-right font-mono text-xs tabular-nums @min-[40rem]:w-24',
												error && 'aria-invalid border-destructive'
											)}
											aria-label="{modelOf(row.key || '')} · {column.label()}"
											aria-invalid={error ? true : undefined}
											oninput={(event) => {
												const value = event.currentTarget.value;
												rows = rows.map((item, at) =>
													at === index ? { ...item, [field]: value } : item
												);
											}}
										/>
										{#if error}
											<p class="text-xs text-destructive">{error}</p>
										{/if}
									</div>
								</Table.Cell>
							{/each}

							<Table.Cell
								class="flex justify-end p-0 align-middle @min-[40rem]:table-cell @min-[40rem]:p-2"
							>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									class="text-muted-foreground hover:text-destructive"
									title={m.admin_settings_ai_pricing_remove()}
									aria-label={`${m.admin_settings_ai_pricing_remove()}: ${row.key || availableKeys[0] || ''}`}
									onclick={() => removeRow(index)}
								>
									<IconTrash />
								</Button>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#if orphanCount > 0}
			<p class="text-xs text-muted-foreground">
				{m.admin_settings_ai_pricing_orphans()}: {orphanCount} ·
				{m.admin_settings_ai_pricing_orphans_desc()}
			</p>
		{/if}

		{#if canManage}
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={availableKeys.length === 0}
						title={availableKeys.length === 0
							? m.admin_settings_ai_pricing_all_priced()
							: undefined}
						onclick={addRow}
					>
						<IconPlus data-icon="inline-start" />
						{m.admin_settings_ai_pricing_add()}
					</Button>
					{#if unpricedCount > 0}
						<span class="text-xs text-muted-foreground">
							{m.admin_settings_ai_pricing_unpriced()}: {unpricedCount}
						</span>
					{/if}
				</div>
				<Button type="submit" size="sm">
					<IconDeviceFloppy data-icon="inline-start" />
					{m.admin_settings_ai_save_pricing()}
				</Button>
			</div>
		{/if}
	</form>

	{#if canManage}
		<!-- A sibling form, not a nested one: HTML forbids nested forms, and each
		     action needs its own submit target. -->
		<form
			method="post"
			action="?/previewPricingSync"
			class="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3"
			use:enhance
		>
			<p class="min-w-0 flex-1 text-xs text-muted-foreground">
				{m.admin_settings_ai_pricing_sync_desc()}
			</p>
			<Button type="submit" variant="outline" size="sm">
				<IconCloudDownload data-icon="inline-start" />
				{m.admin_settings_ai_pricing_sync()}
			</Button>
		</form>
	{/if}

	<Collapsible.Root bind:open={advancedOpen} class="border-t">
		<Collapsible.Trigger
			class="flex w-full items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
		>
			<IconBraces class="size-3.5" />
			{m.admin_settings_ai_pricing_advanced()}
		</Collapsible.Trigger>
		<Collapsible.Content>
			<form
				method="post"
				action="?/savePricingJson"
				class="flex flex-col gap-2 px-4 pt-1 pb-4"
				use:enhance
			>
				<textarea
					name="pricing"
					rows={8}
					bind:value={jsonText}
					aria-label={m.admin_settings_ai_pricing_json()}
					class="min-h-40 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
				></textarea>
				<div class="flex justify-end">
					<Button type="submit" variant="outline" size="sm">
						{m.admin_settings_ai_pricing_advanced_save()}
					</Button>
				</div>
			</form>
		</Collapsible.Content>
	</Collapsible.Root>
</div>

{#if sync}
	<AlertDialog.Root bind:open={syncOpen}>
		<AlertDialog.Content>
			<AlertDialog.Header>
				<AlertDialog.Title>{m.admin_settings_ai_pricing_sync_preview_title()}</AlertDialog.Title>
				<AlertDialog.Description>
					<span class="block">
						{m.admin_settings_ai_pricing_sync_preview_desc({
							added: sync.added.length,
							changed: sync.changed.length,
							kept: sync.kept.length
						})}
					</span>
					{#if sync.unresolved.length > 0}
						<span class="block">
							{m.admin_settings_ai_pricing_sync_preview_unresolved({
								count: sync.unresolved.length
							})}
						</span>
					{/if}
				</AlertDialog.Description>
			</AlertDialog.Header>
			<form
				method="post"
				action="?/syncPricing"
				class="flex flex-col gap-3 px-1"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'success') syncOpen = false;
						await update();
					}}
			>
				<label class="flex items-center gap-2 text-xs">
					<Checkbox name="overwrite" />
					{m.admin_settings_ai_pricing_sync_overwrite()}
				</label>
				<AlertDialog.Footer class="px-0 pb-0">
					<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
					<!-- bits-ui's AlertDialog.Action does not close the dialog on click. -->
					<AlertDialog.Action
						type="submit"
						onclick={() => {
							syncOpen = false;
						}}
					>
						{m.admin_settings_ai_pricing_sync_apply()}
					</AlertDialog.Action>
				</AlertDialog.Footer>
			</form>
		</AlertDialog.Content>
	</AlertDialog.Root>
{/if}
