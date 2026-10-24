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
	import IconFile from '@tabler/icons-svelte-runes/icons/file';
	import IconPhoto from '@tabler/icons-svelte-runes/icons/photo';
	import IconEye from '@tabler/icons-svelte-runes/icons/eye';
	import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
	import IconQuote from '@tabler/icons-svelte-runes/icons/quote';
	import IconWriting from '@tabler/icons-svelte-runes/icons/writing';
	import IconFolders from '@tabler/icons-svelte-runes/icons/folders';
	import IconUsers from '@tabler/icons-svelte-runes/icons/users';
	import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
	import IconChartBar from '@tabler/icons-svelte-runes/icons/chart-bar';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconTool from '@tabler/icons-svelte-runes/icons/tool';
	import IconChevronRight from '@tabler/icons-svelte-runes/icons/chevron-right';
	import IconLogout from '@tabler/icons-svelte-runes/icons/logout';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import { page } from '$app/state';
	import { AdminHeader, createAdminHeaderActionRegistry } from '$lib/components/admin';
	import { m } from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { localeStore, localeLabels } from '$lib/stores/locale.svelte';

	let { children, data }: LayoutProps = $props();

	const navItems = [
		{ title: m.admin_nav_dashboard(), href: '/admin/dashboard', icon: IconDashboard },
		{ title: m.admin_nav_posts(), href: '/admin/posts', icon: IconArticle },
		{ title: m.admin_nav_notes(), href: '/admin/notes', icon: IconNotebook },
		{ title: m.admin_nav_moments(), href: '/admin/moments', icon: IconWriting },
		{ title: m.admin_nav_comments(), href: '/admin/comments', icon: IconMessage },
		{ title: m.admin_nav_pages(), href: '/admin/pages', icon: IconFileText },
		{ title: m.admin_nav_projects(), href: '/admin/projects', icon: IconFolders },
		{ title: m.admin_nav_drafts(), href: '/admin/drafts', icon: IconPencil },
		{ title: m.admin_nav_files(), href: '/admin/files', icon: IconFile },
		{ title: m.admin_nav_photos(), href: '/admin/photos', icon: IconPhoto },
		{ title: m.admin_nav_readers(), href: '/admin/readers', icon: IconEye },
		{ title: m.admin_nav_friends(), href: '/admin/friends', icon: IconUsers },
		{ title: m.admin_nav_quotes(), href: '/admin/quotes', icon: IconQuote },
		{ title: m.admin_nav_thoughts(), href: '/admin/thoughts', icon: IconBulb },
		{ title: m.admin_nav_analytics(), href: '/admin/analytics', icon: IconChartBar },
		{ title: m.admin_nav_ai(), href: '/admin/ai', icon: IconSparkles },
		{ title: m.admin_nav_settings(), href: '/admin/settings', icon: IconSettings },
		{ title: m.admin_nav_maintenance(), href: '/admin/maintenance', icon: IconTool }
	];

	/**
	 * Segment-boundary active check. `/admin` itself is exact-only: as a
	 * prefix it would match every admin route (the bug that moved the
	 * dashboard to `/admin/dashboard`).
	 */
	function isNavItemActive(pathname: string, href: string): boolean {
		if (href === '/admin') return pathname === '/admin';
		return pathname === href || pathname.startsWith(`${href}/`);
	}

	const user = $derived(data.auth?.user);
	const profile = $derived(data.auth?.profile);
	const displayName = $derived(profile?.displayName ?? user?.name ?? 'Admin');
	const email = $derived(user?.email ?? '');
	const avatarSrc = $derived(profile?.avatarUrl ?? user?.image ?? '');
	const avatarFallback = $derived(displayName.charAt(0).toUpperCase());
	const localeOptions = localeStore.available.map((tag) => ({
		value: tag,
		label: localeLabels[tag] ?? tag
	}));

	// Lets the active page bind dialog-opening header actions (see admin-header-actions.ts).
	createAdminHeaderActionRegistry();
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
							<DropdownMenu.Label>{m.ui_language()}</DropdownMenu.Label>
							<DropdownMenu.RadioGroup
								value={getLocale()}
								onValueChange={(value) => localeStore.switchTo(value)}
							>
								{#each localeOptions as { value, label } (value)}
									<DropdownMenu.RadioItem {value}>{label}</DropdownMenu.RadioItem>
								{/each}
							</DropdownMenu.RadioGroup>
							<DropdownMenu.Separator />
							<form method="post" action="/api/auth/sign-out">
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
					{@const isActive = isNavItemActive(page.url.pathname, item.href)}
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

	<Sidebar.Inset class="flex min-h-screen min-w-0 flex-col overflow-x-clip">
		<AdminHeader />

		<!-- flex-col + min-h-0 so route content can fill the shell and scroll
		     inside it. Without it `flex-1` on a child is a no-op and the whole
		     admin surface collapses to its content height, leaving dead space
		     and a page-level scrollbar beside the inner one. -->
		<main class="flex min-h-0 min-w-0 flex-1 flex-col p-4 sm:p-6 lg:p-8">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
