<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { readinessCopy } from '$lib/utils/readiness-copy';
	import {
		addableModels,
		money,
		providerBulk,
		usableProviders,
		type PoolRowView
	} from '$lib/utils/ai-pool';
	import type { AiModelEntry } from '$lib/utils/ai-meta';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconArrowUp from '@tabler/icons-svelte-runes/icons/arrow-up';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconAlertTriangle from '@tabler/icons-svelte-runes/icons/alert-triangle';
	import IconSortAscendingNumbers from '@tabler/icons-svelte-runes/icons/sort-ascending-numbers';

	/**
	 * The default pool: an ordered list of MODELS, not of providers.
	 *
	 * Each row is one model plus the providers that happen to serve it, so
	 * adding a gateway gives every model it offers a fallback with no extra
	 * configuration. The row's budget is a month-to-date cap in the budget
	 * currency; a model over its cap is skipped in favour of the next row.
	 *
	 * The whole section collapses to one summary row, because most visits are
	 * here for providers or the feature assignments - an always-open list would
	 * push those off screen.
	 */

	interface Props {
		rows: PoolRowView[];
		/** Every provider, for the add picker (enabled models only). */
		providers: readonly { id: string; name: string; models: AiModelEntry[] | null }[];
		canManage: boolean;
		/** Compact key for the failing control, from the pool actions. */
		errors?: Record<string, string> | null;
	}

	let { rows, providers, canManage, errors = null }: Props = $props();

	let sectionOpen = $state(false);

	const addable = $derived(addableModels(providers, rows));
	const bulk = $derived(providerBulk(providers, rows));
	/** Bulk target, picked from `bulk`; defaults to the first option so the
	 *  buttons show real counts instead of "0" before anything is picked. */
	let bulkProvider = $state('');
	const bulkSelected = $derived(
		bulk.find((entry) => entry.name === bulkProvider) ?? bulk[0] ?? null
	);
	const spend = $derived(rows.reduce((sum, row) => sum + row.spent, 0));

	function errorFor(marker: string): string | null {
		return errors?.[marker] ?? null;
	}

	/** Switches and budget fields post on change: a save button per row would be noise. */
	function submitForm(formId: string): void {
		const form = document.getElementById(formId) as HTMLFormElement | null;
		form?.requestSubmit();
	}

	function providerLabel(row: PoolRowView): string {
		return row.providers.map((provider) => provider.name).join(' → ');
	}

	function blockedReason(row: PoolRowView): string | null {
		if (!row.enabled) return null;
		if (row.monthlyBudget > 0 && row.spent >= row.monthlyBudget) {
			return m.admin_settings_ai_pool_over_budget();
		}
		if (usableProviders(row).length === 0) {
			const first = row.providers[0];
			return first ? readinessCopy(first.readiness, { name: first.envName ?? '' }).label : null;
		}
		return null;
	}
</script>

{#snippet toolbar()}
	{#if canManage}
		<!-- One line for both ways of filling the pool: add one model, or take
		     every enabled model a provider offers. They stay separate forms
		     because they are separate actions, but they share a row so the card
		     does not grow a second and third control band. -->
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<form
				method="post"
				action="?/addPoolModel"
				class="flex flex-wrap items-center gap-2"
				use:enhance
			>
				{#if addable.length === 0}
					<p class="text-xs text-muted-foreground">{m.admin_settings_ai_pool_all_added()}</p>
				{:else}
					<!-- Native select: the options are plain ids, and a native `change`
					     is what a keyboard user produces too. The provider suffix is
					     left out on purpose - the pool is keyed by model, so which
					     gateway happens to list it changes nothing here. -->
					<select
						name="model"
						required
						aria-label={m.admin_settings_ai_pool_add()}
						class="h-8 max-w-full min-w-40 rounded-lg border border-input bg-transparent px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						<option value="">{m.admin_settings_ai_pool_add()}</option>
						{#each addable as option (option.model)}
							<option value={option.model}>{option.model}</option>
						{/each}
					</select>
					<Button type="submit" variant="outline" size="sm">
						<IconPlus data-icon="inline-start" />
						{m.admin_settings_ai_pool_add()}
					</Button>
				{/if}
			</form>

			{#if bulk.length > 0}
				<!-- Bulk, keyed by provider: adding every model a new gateway offers is
				     one click, and so is dropping them again. Both buttons spell out
				     the count they act on, so neither is a surprise. -->
				<form
					method="post"
					action="?/bulkPoolModels"
					class="flex flex-wrap items-center gap-2"
					use:enhance
				>
					<select
						name="provider"
						required
						aria-label={m.admin_settings_ai_pool_bulk_provider()}
						class="h-8 max-w-full min-w-40 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
						value={bulkSelected?.name ?? ''}
						title={bulkSelected
							? m.admin_settings_ai_pool_bulk_counts({
									add: bulkSelected.addable.length,
									remove: bulkSelected.removable.length
								})
							: undefined}
						onchange={(event) => (bulkProvider = event.currentTarget.value)}
					>
						<!-- Name only: the counts belong to the buttons, which spell out the
						     exact number they will act on. -->
						{#each bulk as entry (entry.name)}
							<option value={entry.name}>{entry.name}</option>
						{/each}
					</select>
					<Button
						type="submit"
						name="op"
						value="add"
						variant="outline"
						size="sm"
						disabled={!bulkSelected || bulkSelected.addable.length === 0}
					>
						<IconPlus data-icon="inline-start" />
						{m.admin_settings_ai_pool_bulk_add({ count: bulkSelected?.addable.length ?? 0 })}
					</Button>
					<Button
						type="submit"
						name="op"
						value="remove"
						variant="outline"
						size="sm"
						disabled={!bulkSelected || bulkSelected.removable.length === 0}
						title={bulkSelected?.removable.join(', ')}
					>
						<IconTrash data-icon="inline-start" />
						{m.admin_settings_ai_pool_bulk_remove({ count: bulkSelected?.removable.length ?? 0 })}
					</Button>
				</form>
			{/if}

			<!-- Last in the row and only reachable with the list open: reordering the
			     chain is not something to hit by accident while reaching for the
			     expand toggle. -->
			{#if rows.length > 1}
				<form method="post" action="?/sortPoolByPrice" class="ml-auto" use:enhance>
					<Button
						type="submit"
						variant="outline"
						size="sm"
						title={m.admin_settings_ai_pool_sort_price_hint()}
					>
						<IconSortAscendingNumbers data-icon="inline-start" />
						{m.admin_settings_ai_pool_sort_price()}
					</Button>
				</form>
			{/if}
		</div>
		{#if errorFor('model')}
			<p class="mt-2 text-xs text-destructive">{errorFor('model')}</p>
		{/if}
	{/if}
{/snippet}

<section id="pool">
	<!-- One card, the same shape as a provider card: title + badges + description
	     on the left, actions on the right. Collapsed it is the height of a provider
	     row, because most visits here are for providers or the assignments. -->
	<Collapsible.Root bind:open={sectionOpen}>
		<div class="rounded-lg border">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-2">
						<h2 class="truncate text-sm font-medium">{m.admin_settings_ai_pool()}</h2>
						{#if rows.length > 0}
							<Badge variant="secondary">
								{m.admin_settings_ai_model_count({ count: rows.length })}
							</Badge>
							<Badge variant="secondary">
								{m.admin_settings_ai_pool_spent_only({ spent: money(spend) })}
							</Badge>
						{:else}
							<!-- The badge carries the state, so the empty branch does not need
							     its own explanatory line above the controls. -->
							<Badge variant="outline">{m.admin_settings_ai_pool_empty()}</Badge>
						{/if}
					</div>
					<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_ai_pool_desc()}</p>
				</div>
				<div class="flex shrink-0 flex-wrap items-center gap-2">
					{#if rows.length > 0}
						<Collapsible.Trigger
							class="inline-flex h-7 shrink-0 items-center gap-1 rounded-[min(var(--radius-md),12px)] border border-border bg-background px-2.5 text-[0.8rem] font-medium transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
						>
							<IconChevronDown
								class="size-3.5 shrink-0 text-muted-foreground transition-transform {sectionOpen
									? 'rotate-180'
									: ''}"
							/>
							{sectionOpen ? m.admin_settings_ai_pool_hide() : m.admin_settings_ai_pool_show()}
						</Collapsible.Trigger>
					{/if}
				</div>
			</div>

			{#if rows.length === 0}
				<div class="border-t p-3">{@render toolbar()}</div>
			{:else}
				<Collapsible.Content>
					<div class="divide-y border-t">
						{#each rows as row, index (row.id)}
							{@const reason = blockedReason(row)}
							<div class="@container">
								<div class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
									<span class="flex min-w-40 flex-1 items-center gap-2">
										<span
											class="w-4 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums"
										>
											{index + 1}
										</span>
										<span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
											<span
												class="truncate font-mono text-sm font-medium @max-[24rem]:break-all @max-[24rem]:whitespace-normal"
											>
												{row.model}
											</span>
											{#if !row.enabled}
												<Badge variant="outline" class="shrink-0 text-[11px]">
													{m.admin_common_disable()}
												</Badge>
											{:else if reason}
												<Badge variant="destructive" class="shrink-0 gap-1 text-[11px]">
													<IconAlertTriangle class="size-3" />
													{reason}
												</Badge>
											{/if}
										</span>
									</span>

									<!-- Providers and spend are derived, never edited: the chain is
								     every enabled provider that offers the model, in the order
								     the runtime would try them. -->
									<span
										class="flex min-w-0 basis-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground @min-[28rem]:basis-auto"
									>
										{#if row.providers.length === 0}
											<span class="text-destructive">{m.admin_settings_ai_pool_no_provider()}</span>
										{:else}
											<span class="truncate" title={providerLabel(row)}>{providerLabel(row)}</span>
										{/if}
										<span aria-hidden="true">·</span>
										<span class="whitespace-nowrap tabular-nums">
											{row.monthlyBudget > 0
												? m.admin_settings_ai_pool_spent({
														spent: money(row.spent),
														cap: money(row.monthlyBudget)
													})
												: m.admin_settings_ai_pool_spent_only({ spent: money(row.spent) })}
										</span>
									</span>

									{#if canManage}
										<span class="ml-auto flex shrink-0 items-center gap-1">
											<form
												id="pool-budget-{row.id}"
												method="post"
												action="?/savePoolBudget"
												use:enhance
											>
												<input type="hidden" name="id" value={row.id} />
												<Input
													name="monthlyBudget"
													value={row.monthlyBudget > 0 ? String(row.monthlyBudget) : ''}
													inputmode="decimal"
													autocomplete="off"
													class="h-7 w-20 text-right font-mono text-xs tabular-nums"
													placeholder={m.admin_settings_ai_pool_no_cap()}
													title={m.admin_settings_ai_pool_budget_hint()}
													aria-label={`${m.admin_settings_ai_pool_budget()}: ${row.model}`}
													onchange={() => submitForm(`pool-budget-${row.id}`)}
												/>
											</form>
											<form method="post" action="?/movePoolModel" use:enhance>
												<input type="hidden" name="id" value={row.id} />
												<input type="hidden" name="direction" value="up" />
												<Button
													type="submit"
													variant="ghost"
													size="icon-sm"
													disabled={index === 0}
													aria-label={`${m.admin_settings_ai_pool_move_up()}: ${row.model}`}
												>
													<IconArrowUp />
												</Button>
											</form>
											<form method="post" action="?/movePoolModel" use:enhance>
												<input type="hidden" name="id" value={row.id} />
												<input type="hidden" name="direction" value="down" />
												<Button
													type="submit"
													variant="ghost"
													size="icon-sm"
													disabled={index === rows.length - 1}
													aria-label={`${m.admin_settings_ai_pool_move_down()}: ${row.model}`}
												>
													<IconArrowDown />
												</Button>
											</form>
											<form
												id="pool-toggle-{row.id}"
												method="post"
												action="?/togglePoolModel"
												use:enhance
											>
												<input type="hidden" name="id" value={row.id} />
												<input type="hidden" name="enabled" value={row.enabled ? '0' : '1'} />
												<Switch
													checked={row.enabled}
													aria-label={`${m.admin_settings_ai_pool_enable()}: ${row.model}`}
													onCheckedChange={() => submitForm(`pool-toggle-${row.id}`)}
												/>
											</form>
											<form method="post" action="?/removePoolModel" use:enhance>
												<input type="hidden" name="id" value={row.id} />
												<Button
													type="submit"
													variant="ghost"
													size="icon-sm"
													class="text-muted-foreground hover:text-destructive"
													aria-label={`${m.admin_settings_ai_pool_remove()}: ${row.model}`}
												>
													<IconTrash />
												</Button>
											</form>
										</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
					<div class="border-t p-3">{@render toolbar()}</div>
				</Collapsible.Content>
			{/if}
		</div>
	</Collapsible.Root>
</section>
