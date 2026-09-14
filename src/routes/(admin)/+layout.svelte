<script lang="ts">
	import type { LayoutProps } from './$types';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import IconDashboard from '@tabler/icons-svelte-runes/icons/layout-dashboard';
	import IconArticle from '@tabler/icons-svelte-runes/icons/article';
	import IconNotebook from '@tabler/icons-svelte-runes/icons/notebook';
	import IconMessage from '@tabler/icons-svelte-runes/icons/message';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconFileText from '@tabler/icons-svelte-runes/icons/file-text';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';
	import IconFolders from '@tabler/icons-svelte-runes/icons/folders';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconChartBar from '@tabler/icons-svelte-runes/icons/chart-bar';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconPuzzle from '@tabler/icons-svelte-runes/icons/puzzle';
	import IconTool from '@tabler/icons-svelte-runes/icons/tool';
	import IconChevronRight from '@tabler/icons-svelte-runes/icons/chevron-right';
	import IconLogout from '@tabler/icons-svelte-runes/icons/logout';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import { page } from '$app/state';
	import { AdminHeader } from '$lib/components/admin';
	import { m } from '$lib/paraglide/messages';

	let { children, data }: LayoutProps = $props();

	const navItems = [
		{ title: m.admin_nav_dashboard(), href: '/admin', icon: IconDashboard },
		{ title: m.admin_nav_posts(), href: '/admin/posts', icon: IconArticle },
		{ title: m.admin_nav_notes(), href: '/admin/notes', icon: IconNotebook },
		{ title: m.admin_nav_comments(), href: '/admin/comments', icon: IconMessage },
		{ title: m.admin_nav_drafts(), href: '/admin/drafts', icon: IconPencil },
		{ title: m.admin_nav_pages(), href: '/admin/pages', icon: IconFileText },
		{ title: m.admin_nav_readers(), href: '/admin/readers', icon: IconEye },
		{ title: m.admin_nav_says(), href: '/admin/says', icon: IconQuote },
		{ title: m.admin_nav_memos(), href: '/admin/memos', icon: IconWriting },
		{ title: m.admin_nav_projects(), href: '/admin/projects', icon: IconFolders },
		{ title: m.admin_nav_friends(), href: '/admin/friends', icon: IconUsers },
		{ title: m.admin_nav_ai(), href: '/admin/ai', icon: IconSparkles },
		{ title: m.admin_nav_analytics(), href: '/admin/analytics', icon: IconChartBar },
		{ title: m.admin_nav_settings(), href: '/admin/settings', icon: IconSettings },
		{ title: m.admin_nav_addons(), href: '/admin/addons', icon: IconPuzzle },
		{ title: m.admin_nav_maintenance(), href: '/admin/maintenance', icon: IconTool }
	];

	const user = $derived(data.auth?.user);
	const profile = $derived(data.auth?.profile);
	const displayName = $derived(profile?.displayName ?? user?.name ?? 'Admin');
	const email = $derived(user?.email ?? '');
	const avatarSrc = $derived(profile?.avatarUrl ?? user?.image ?? '');
	const avatarFallback = $derived(displayName.charAt(0).toUpperCase());
</script>

<Sidebar.Provider>
	<Sidebar.Root collapsible="icon" variant="sidebar">
		<Sidebar.Header>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Sidebar.MenuButton size="lg" class="group/menu-button" {...props}>
									<span class="flex size-8 shrink-0 items-center justify-center">
										<Avatar.Root class="size-6 rounded-md">
											<Avatar.Image src={avatarSrc} alt={displayName} />
											<Avatar.Fallback
												class="rounded-md bg-primary text-xs text-primary-foreground"
											>
												{avatarFallback}
											</Avatar.Fallback>
										</Avatar.Root>
									</span>
									<div class="grid flex-1 text-left text-sm leading-tight">
										<span class="truncate font-semibold">{displayName}</span>
										<span class="truncate text-xs text-muted-foreground">{email}</span>
									</div>
									<IconChevronRight
										class="ml-auto transition-transform group-data-[state=open]/menu-button:rotate-90"
									/>
								</Sidebar.MenuButton>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" side="right" class="w-56">
							<DropdownMenu.Label>{m.admin_user_my_account()}</DropdownMenu.Label>
							<DropdownMenu.Separator />
							<DropdownMenu.Group>
								<DropdownMenu.Item>
									<IconUser data-icon="inline-start" />
									{m.admin_user_profile()}
								</DropdownMenu.Item>
								<DropdownMenu.Item onclick={() => window.open('/', '_blank')}>
									<IconExternalLink data-icon="inline-start" />
									{m.admin_user_visit_site()}
								</DropdownMenu.Item>
							</DropdownMenu.Group>
							<DropdownMenu.Separator />
							<form method="post" action="/auth/sign-out">
								<DropdownMenu.Item
									class="text-destructive focus:text-destructive"
									onclick={(e) => {
										e.currentTarget.closest('form')?.submit();
									}}
								>
									<IconLogout data-icon="inline-start" />
									{m.admin_user_sign_out()}
								</DropdownMenu.Item>
							</form>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Header>

		<Sidebar.Content class="px-2">
			<Sidebar.Menu class="gap-1">
				{#each navItems as item (item.href)}
					{@const isActive =
						page.url.pathname === item.href || page.url.pathname.startsWith(`${item.href}/`)}
					<Sidebar.MenuItem>
						<Sidebar.MenuButton {isActive} tooltipContent={item.title}>
							{#snippet child({ props })}
								<a href={item.href} {...props}>
									<span
										class="flex size-8 shrink-0 items-center justify-center group-data-[collapsible=icon]:size-4"
									>
										<item.icon />
									</span>
									<span>{item.title}</span>
								</a>
							{/snippet}
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
				{/each}
			</Sidebar.Menu>
		</Sidebar.Content>

		<Sidebar.Rail />
	</Sidebar.Root>

	<Sidebar.Inset class="flex min-h-screen flex-col overflow-x-clip min-w-0">
		<AdminHeader />

		<main class="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
