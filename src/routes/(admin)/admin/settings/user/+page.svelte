<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconShield from '@tabler/icons-svelte-runes/icons/shield';
	import IconCamera from '@tabler/icons-svelte-runes/icons/camera';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
</script>

<svelte:head>
	<title>{m.admin_settings_user_title()} - Lair Admin</title>
</svelte:head>

<section class="space-y-4">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h2 class="inline-flex items-center gap-2 text-base font-medium">
				{m.admin_settings_user()}
			</h2>
			<p class="mt-1 text-xs text-muted-foreground">{m.admin_settings_user_intro()}</p>
		</div>
	</header>
	<form class="space-y-6" onsubmit={(e) => e.preventDefault()}>
		<div class="flex flex-wrap items-center gap-4">
			<button
				class="group relative flex size-20 items-center justify-center overflow-hidden rounded-full bg-muted text-lg font-semibold text-muted-foreground ring-4 ring-muted transition-all hover:ring-accent/50"
				title={m.admin_settings_user_upload_avatar()}
				type="button"
			>
				<img alt="" class="size-full object-cover" src={s.user.avatar} />
				<span
					class="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
				>
					<IconCamera class="size-5 text-white" />
				</span>
			</button>
			<div class="min-w-0 flex-1">
				<div class="truncate text-base font-semibold">{s.user.nickname}</div>
				<div class="mt-1 text-sm text-muted-foreground">@{s.user.username}</div>
				<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
					<span class="inline-flex min-w-0 items-center gap-1.5">
						<IconMail class="size-3.5 shrink-0 text-muted-foreground/60" />
						<span class="truncate">{s.user.email}</span>
					</span>
					<span class="inline-flex min-w-0 items-center gap-1.5">
						<IconShield class="size-3.5 shrink-0 text-muted-foreground/60" />
						<span>{m.admin_settings_user_last_login({ time: s.user.lastLogin })}</span>
					</span>
				</div>
			</div>
		</div>
		<Field.Group class="grid gap-4 md:grid-cols-2">
			<Field.Field>
				<Field.Label for="user-nickname">{m.admin_settings_user_nickname()}</Field.Label>
				<Input id="user-nickname" type="text" value={s.user.nickname} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="user-username">{m.admin_settings_user_username()}</Field.Label>
				<Input id="user-username" type="text" value={s.user.username} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="user-email">{m.admin_settings_user_email()}</Field.Label>
				<Input id="user-email" type="email" value={s.user.email} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="user-site">{m.admin_settings_site()}</Field.Label>
				<Input id="user-site" type="text" value={s.user.site} />
			</Field.Field>
			<Field.Field>
				<Field.Label for="user-avatar">{m.admin_settings_user_avatar()}</Field.Label>
				<Input id="user-avatar" type="text" value={s.user.avatar} />
			</Field.Field>
		</Field.Group>
		<label class="grid gap-1.5 text-sm">
			<span class="font-medium">{m.admin_settings_user_bio()}</span>
			<Textarea class="min-h-24" value={s.user.bio} />
		</label>
		<div class="space-y-3">
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-medium">{m.admin_settings_user_social()}</h3>
				<Button type="button" variant="outline" size="sm">
					<IconPlus data-icon="inline-start" />
					{m.admin_common_add()}
				</Button>
			</div>
			<p class="text-sm text-muted-foreground">{m.admin_settings_user_social_empty()}</p>
		</div>
		<div class="flex justify-end">
			<Button type="submit" size="sm">
				<IconDeviceFloppy data-icon="inline-start" />
				{m.admin_common_save()}
			</Button>
		</div>
	</form>
</section>
