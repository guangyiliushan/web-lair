<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Table from '$lib/components/ui/table';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Empty } from '$lib/components/ui/empty';
	import { RefreshButton } from '$lib/components/admin/refresh-button';
	import { Separator } from '$lib/components/ui/separator';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import IconDots from '@tabler/icons-svelte-runes/icons/dots';
	import IconChevronDown from '@tabler/icons-svelte-runes/icons/chevron-down';
	import IconArrowUpDown from '@tabler/icons-svelte-runes/icons/arrows-up-down';
	import IconArrowDown from '@tabler/icons-svelte-runes/icons/arrow-down';
	import IconBook from '@tabler/icons-svelte-runes/icons/book';
	import IconHeart from '@tabler/icons-svelte-runes/icons/heart';
	import IconHash from '@tabler/icons-svelte-runes/icons/hash';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconCloudRain from '@tabler/icons-svelte-runes/icons/cloud-rain';
	import IconMoodSmile from '@tabler/icons-svelte-runes/icons/mood-smile';

	const notes = [
		{
			id: '211',
			title: '26y: Health, Changes in the AI Industry, and Personal Reflection',
			slug: 'three-years-after-graduation-reflections-on-health-ai-industry-and-life',
			series: '',
			mood: '',
			weather: '',
			reads: 332,
			likes: 12,
			updatedAt: '2天前'
		},
		{
			id: '210',
			title: 'Wrinkles in Monotony',
			slug: 'wrinkles-in-monotony',
			series: '生活随笔',
			mood: '',
			weather: '',
			reads: 739,
			likes: 28,
			updatedAt: '1周前'
		},
		{
			id: '208',
			title: 'Spring Festival on the Keyboard',
			slug: 'spring-festival-on-the-keyboard',
			series: '',
			mood: '',
			weather: '',
			reads: 1330,
			likes: 45,
			updatedAt: '2周前'
		},
		{
			id: '207',
			title: 'Spring Festival Memories as the Flavor Fades',
			slug: 'fading-spring-festival-memories',
			series: '生活随笔',
			mood: '',
			weather: 'Overcast',
			reads: 887,
			likes: 31,
			updatedAt: '3周前'
		},
		{
			id: '206',
			title: 'Just Working: Work and Life in the AI Era',
			slug: 'just-going-to-work-ai-era-work-and-life',
			series: '技术思考',
			mood: 'Mixed Emotions',
			weather: '',
			reads: 2300,
			likes: 67,
			updatedAt: '1个月前'
		},
		{
			id: '205',
			title: '2025 - Still on the Road, Beyond the Radius',
			slug: '2025-still-on-the-road-beyond-the-radius',
			series: '',
			mood: '',
			weather: '',
			reads: 2300,
			likes: 89,
			updatedAt: '1个月前'
		},
		{
			id: '204',
			title: 'Seeking Survival in Stability',
			slug: 'seeking-survival-in-stability',
			series: '技术思考',
			mood: '',
			weather: '',
			reads: 2700,
			likes: 102,
			updatedAt: '2个月前'
		},
		{
			id: '200',
			title: 'Finding an Exit Between Anxiety and Creativity',
			slug: 'finding-outlet-between-anxiety-and-creativity',
			series: '',
			mood: 'Anxious',
			weather: '',
			reads: 2500,
			likes: 56,
			updatedAt: '2个月前'
		},
		{
			id: '199',
			title: 'A Five-Day Journey on the Edge of the Equator',
			slug: 'five-day-travel-diary-at-the-edge-of-the-equator-singapore',
			series: '旅行',
			mood: 'Happy',
			weather: 'Sunny',
			reads: 1600,
			likes: 73,
			updatedAt: '3个月前'
		},
		{
			id: '198',
			title: 'The Interweaving of Calmness and Busyness',
			slug: 'interweaving-of-calm-and-busy-life',
			series: '',
			mood: '',
			weather: '',
			reads: 1000,
			likes: 18,
			updatedAt: '3个月前'
		}
	];

	let searchQuery = $state('');
	let selectedIds = $state<string[]>([]);

	const filteredNotes = $derived(
		notes.filter((note) => note.title.toLowerCase().includes(searchQuery.toLowerCase()))
	);

	const allSelected = $derived(
		filteredNotes.length > 0 && selectedIds.length === filteredNotes.length
	);

	function toggleSelectAll() {
		if (allSelected) {
			selectedIds = [];
		} else {
			selectedIds = filteredNotes.map((n) => n.id);
		}
	}

	function toggleSelect(id: string) {
		if (selectedIds.includes(id)) {
			selectedIds = selectedIds.filter((i) => i !== id);
		} else {
			selectedIds = [...selectedIds, id];
		}
	}

	/** Format a number for compact display, e.g. 1330 → "1.3K" */
	function fmt(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
		return String(n);
	}
</script>

<svelte:head>
	<title>手记管理 - Lair Admin</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<!-- 搜索和筛选工具栏 -->
	<div class="relative flex h-10 shrink-0 items-center border-b">
		<label
			class="hidden w-10 shrink-0 cursor-pointer items-center justify-center pl-2 text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
			title="全选"
			aria-label="全选"
		>
			<input
				type="checkbox"
				class="size-4 rounded border-border bg-transparent"
				checked={allSelected}
				onchange={toggleSelectAll}
			/>
		</label>
		<form
			class="relative flex h-full min-w-0 flex-1 items-center self-stretch"
			onsubmit={(e) => e.preventDefault()}
		>
			<IconSearch
				class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="text"
				aria-label="搜索标题或正文"
				placeholder="搜索标题或正文"
				class="h-7 w-full border-0 bg-transparent pr-0 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:ring-0"
				bind:value={searchQuery}
			/>
		</form>
		<!-- 数据列占位 — 与表格 w-44 对齐 -->
		<div class="hidden w-44 xl:block"></div>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="hidden w-24 justify-between text-xs font-normal text-muted-foreground hover:text-foreground sm:inline-flex"
					>
						<span class="truncate">全部专栏</span>
						<IconChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>全部专栏</DropdownMenu.Item>
					<DropdownMenu.Item>生活随笔</DropdownMenu.Item>
					<DropdownMenu.Item>技术思考</DropdownMenu.Item>
					<DropdownMenu.Item>旅行</DropdownMenu.Item>
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="sm"
						class="hidden w-28 justify-center text-xs font-normal text-muted-foreground hover:text-foreground sm:inline-flex"
					>
						<IconArrowUpDown class="size-3.5" />
						<span class="truncate">创建时间</span>
						<IconArrowDown class="size-3" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Group>
					<DropdownMenu.Item>创建时间</DropdownMenu.Item>
					<DropdownMenu.Item>更新时间</DropdownMenu.Item>
					<DropdownMenu.Item>阅读量</DropdownMenu.Item>
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<!-- 操作列占位 — 与表格 w-20 对齐 -->
		<div class="w-20"></div>
		<!-- 分隔符和刷新按钮：绝对定位，不参与 flex 布局 -->
		<div class="absolute top-0 right-0 flex h-full items-center pr-2">
			<Separator orientation="vertical" class="h-3.5" />
			<RefreshButton
				onclick={() => {
					/* TODO */
				}}
			/>
		</div>
	</div>

	<!-- 手记列表 -->
	{#if filteredNotes.length === 0}
		<Empty class="py-12">
			<div class="flex flex-col items-center gap-1">
				<h3 class="text-lg font-semibold tracking-tight">暂无手记</h3>
				<p class="text-sm text-muted-foreground">还没有创建任何手记</p>
			</div>
		</Empty>
	{:else}
		<div class="overflow-x-auto">
			<Table.Root class="table-fixed">
				<Table.Body>
					{#each filteredNotes as note (note.id)}
						<Table.Row class="group border-border">
							<Table.Cell class="hidden w-10 sm:table-cell">
								<input
									type="checkbox"
									class="size-4 rounded border-border bg-transparent"
									checked={selectedIds.includes(note.id)}
									onchange={() => toggleSelect(note.id)}
								/>
							</Table.Cell>
							<Table.Cell class="max-w-0 whitespace-normal">
								<div class="flex min-w-0 flex-col gap-1">
									<a
										href="/admin/notes/{note.id}/edit"
										class="line-clamp-2 block max-w-lg font-medium hover:text-primary"
										>{note.title}</a
									>
									<!-- 紧凑模式元信息行：lg 以下显示，sm 以下含时间 -->
									<div
										class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground sm:gap-x-3 xl:hidden"
									>
										{#if note.series}
											<span class="font-mono">{note.series}</span>
										{:else}
											<span class="text-muted-foreground/60">-</span>
										{/if}
										<span class="inline-flex items-center gap-1"
											><IconBook class="size-3" />{fmt(note.reads)}</span
										>
										<span class="inline-flex items-center gap-1"
											><IconHeart class="size-3" />{fmt(note.likes)}</span
										>
										{#if note.weather}
											<span class="inline-flex items-center gap-1"
												><IconCloudRain class="size-3" />{note.weather}</span
											>
										{/if}
										{#if note.mood}
											<span class="inline-flex items-center gap-1"
												><IconMoodSmile class="size-3" />{note.mood}</span
											>
										{/if}
										<span class="sm:hidden">{note.updatedAt}</span>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-44 xl:table-cell">
								<div class="flex items-center gap-3 overflow-hidden text-sm text-muted-foreground">
									<span class="inline-flex items-center gap-1">
										<IconBook class="size-3.5" />
										{fmt(note.reads)}
									</span>
									<span class="inline-flex items-center gap-1">
										<IconHeart class="size-3.5" />
										{fmt(note.likes)}
									</span>
									{#if note.weather}
										<span class="inline-flex items-center gap-1">
											<IconCloudRain class="size-3.5" />
											{note.weather}
										</span>
									{/if}
									{#if note.mood}
										<span class="inline-flex items-center gap-1">
											<IconMoodSmile class="size-3.5" />
											{note.mood}
										</span>
									{/if}
								</div>
							</Table.Cell>
							<Table.Cell class="hidden w-24 xl:table-cell">
								{#if note.series}
									<Badge variant="outline" class="text-xs">{note.series}</Badge>
								{:else}
									<span class="text-xs text-muted-foreground">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden w-28 text-muted-foreground sm:table-cell"
								>{note.updatedAt}</Table.Cell
							>
							<Table.Cell class="w-20 text-right">
								<div class="flex items-center justify-end gap-1">
									<Button
										variant="ghost"
										size="icon"
										class="size-8"
										href="/admin/notes/{note.id}/edit"
										aria-label="编辑"
									>
										<IconPencil class="size-4" />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										class="size-8"
										onclick={() => window.open(`/notes/${note.slug}`, '_blank')}
										aria-label="在新窗口打开"
									>
										<IconExternalLink class="size-4" />
									</Button>
									<!-- 桌面/平板：三点菜单 -->
									<span class="hidden sm:contents">
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button
														variant="ghost"
														size="icon"
														class="size-8"
														{...props}
														aria-label="更多操作"><IconDots class="size-4" /></Button
													>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content align="end">
												<DropdownMenu.Group>
													<DropdownMenu.Item>
														{#snippet child({ props })}
															<a href="/admin/notes/{note.id}/edit" {...props}
																><IconPencil data-icon="inline-start" />编辑</a
															>
														{/snippet}
													</DropdownMenu.Item>
													<DropdownMenu.Item
														onclick={() => window.open(`/notes/${note.slug}`, '_blank')}
													>
														<IconExternalLink
															data-icon="inline-start"
														/>在新窗口打开<DropdownMenu.Shortcut>⌘↵</DropdownMenu.Shortcut>
													</DropdownMenu.Item>
												</DropdownMenu.Group>
												<DropdownMenu.Separator />
												<DropdownMenu.Group>
													<DropdownMenu.Item
														><IconCopy data-icon="inline-start" />复制链接</DropdownMenu.Item
													>
													<DropdownMenu.Item
														><IconHash data-icon="inline-start" />复制 ID</DropdownMenu.Item
													>
												</DropdownMenu.Group>
												<DropdownMenu.Separator />
												<DropdownMenu.Group>
													<DropdownMenu.Item variant="destructive"
														><IconTrash data-icon="inline-start" />删除<DropdownMenu.Shortcut
															>⌫</DropdownMenu.Shortcut
														></DropdownMenu.Item
													>
												</DropdownMenu.Group>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</span>
									<!-- 移动端：删除按钮替代三点菜单 -->
									<Button variant="ghost" size="icon" class="size-8 sm:hidden" aria-label="删除">
										<IconTrash class="size-4" />
									</Button>
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>
