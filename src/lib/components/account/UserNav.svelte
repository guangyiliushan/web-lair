<script lang="ts">
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import IconUser from '@tabler/icons-svelte-runes/icons/user';
	import IconLayoutDashboard from '@tabler/icons-svelte-runes/icons/layout-dashboard';
	import IconUserCircle from '@tabler/icons-svelte-runes/icons/user-circle';
	import IconLogout from '@tabler/icons-svelte-runes/icons/logout';
	import akkarinPng from '$lib/assets/akkarin.png';

	type AuthData = {
		user: {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			image: string | null;
		} | null;
		profile: {
			displayName: string;
			avatarUrl: string | null;
		} | null;
	} | null;

	let { auth }: { auth?: AuthData } = $props();

	// Avatar source priority: profile.avatarUrl user.image akkarin.png
	const avatarSrc = $derived(auth?.profile?.avatarUrl ?? auth?.user?.image ?? akkarinPng);
	const displayName = $derived(auth?.profile?.displayName ?? auth?.user?.name ?? '');
	const userEmail = $derived(auth?.user?.email ?? '');
	const loginHref = $derived(
		`/login?redirectTo=${encodeURIComponent(page.url.pathname + page.url.search)}`
	);
</script>

{#if auth?.user}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class="inline-flex size-10 cursor-pointer items-center justify-center rounded-full transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
			aria-label={m.nav_open_user_menu()}
		>
			<Avatar.Root size="lg">
				<Avatar.Image src={avatarSrc} alt="" />
				<Avatar.Fallback>
					<IconUser />
				</Avatar.Fallback>
			</Avatar.Root>
		</DropdownMenu.Trigger>

		<DropdownMenu.Content sideOffset={8} align="end" class="w-56">
			<div class="px-2 py-1.5">
				<p class="truncate text-sm leading-none font-medium">{displayName}</p>
				{#if userEmail}
					<p class="mt-1.5 truncate text-xs leading-none text-muted-foreground">
						{userEmail}
					</p>
				{/if}
			</div>

			<DropdownMenu.Separator />

			<DropdownMenu.Group>
				<DropdownMenu.Item>
					<a href="/admin" class="flex items-center gap-1.5">
						<IconLayoutDashboard />
						{m.nav_dashboard()}
					</a>
				</DropdownMenu.Item>
				<DropdownMenu.Item>
					<a href="/account" class="flex items-center gap-1.5">
						<IconUserCircle />
						{m.nav_account()}
					</a>
				</DropdownMenu.Item>
			</DropdownMenu.Group>

			<DropdownMenu.Separator />

			<DropdownMenu.Group>
				<DropdownMenu.Item variant="destructive">
					<button
						type="submit"
						form="user-nav-sign-out"
						class="flex w-full items-center gap-1.5 text-left"
					>
						<IconLogout />
						{m.nav_sign_out()}
					</button>
				</DropdownMenu.Item>
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{:else}
	<a
		href={loginHref}
		class="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
		aria-label={m.nav_sign_in()}
	>
		<IconUser />
	</a>
{/if}

<!-- Hidden form bound for programmatic sign-out -->
<form id="user-nav-sign-out" method="post" action="/api/auth/sign-out" class="hidden"></form>
