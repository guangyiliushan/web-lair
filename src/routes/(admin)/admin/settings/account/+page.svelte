<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import IconShieldLock from '@tabler/icons-svelte-runes/icons/shield-lock';
	import IconAlertCircle from '@tabler/icons-svelte-runes/icons/alert-circle';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Separator from '$lib/components/ui/separator';
	import IconShield from '@tabler/icons-svelte-runes/icons/shield';
	import IconGlobe from '@tabler/icons-svelte-runes/icons/globe';
	import IconLock from '@tabler/icons-svelte-runes/icons/lock';
	import IconKey from '@tabler/icons-svelte-runes/icons/key';
	import IconCopy from '@tabler/icons-svelte-runes/icons/copy';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconDeviceLaptop from '@tabler/icons-svelte-runes/icons/device-laptop';
	import IconBrandGithub from '@tabler/icons-svelte-runes/icons/brand-github';
	import IconBrandGoogle from '@tabler/icons-svelte-runes/icons/brand-google';

	let { data, form }: PageProps = $props();

	// The action payloads are a union (enable / activate / disable / regenerate);
	// this loose view keeps the template readable.
	const actionForm = $derived(
		form as {
			message?: string | null;
			totpURI?: string;
			backupCodes?: string[];
			step?: string;
		} | null
	);

	// The activation flow spans two submits (enable -> activate). The secret and
	// the one-time codes arrive with the first response and must survive a failed
	// activation, so they live in local state instead of being re-read from the
	// current payload - the old template dropped the secret on the first wrong
	// code and never rendered regenerated codes at all (B3.1 review). A
	// `step: 'done'` payload ends the flow and clears them.
	let pendingTotpURI = $state<string | null>(null);
	let pendingBackupCodes = $state<string[]>([]);

	$effect(() => {
		const payload = actionForm;
		if (!payload) return;
		if (payload.totpURI) pendingTotpURI = payload.totpURI;
		if (payload.backupCodes?.length) pendingBackupCodes = payload.backupCodes;
		if (payload.step === 'done') {
			pendingTotpURI = null;
			pendingBackupCodes = [];
		}
	});

	let s = $derived(data.settings);

	const devices = [
		{
			id: 1,
			name: '当前设备',
			ip: '192.168.1.100',
			ua: 'Chrome 131.0 / Windows 11',
			time: '2026-07-22 10:30',
			current: true
		},
		{
			id: 2,
			name: 'MacBook Pro',
			ip: '10.0.0.52',
			ua: 'Safari 18.2 / macOS 15.2',
			time: '2026-07-20 08:15',
			current: false
		}
	];

	let copiedGh = $state(false);
	let copiedGoogle = $state(false);

	async function copyToClipboard(text: string, which: 'gh' | 'google') {
		try {
			await navigator.clipboard.writeText(text);
			if (which === 'gh') {
				copiedGh = true;
				setTimeout(() => (copiedGh = false), 2000);
			} else {
				copiedGoogle = true;
				setTimeout(() => (copiedGoogle = false), 2000);
			}
		} catch {
			// clipboard not available
		}
	}
</script>

<div class="space-y-8">
	<!-- Section: 两步验证（真实功能 · B3）-->
	<section>
		<div class="mb-4 flex items-center justify-between">
			<div class="flex items-center gap-2">
				<IconShieldLock class="size-5 text-muted-foreground" />
				<h3 class="text-base font-semibold">{m.admin_settings_2fa_title()}</h3>
			</div>
			<Badge variant={data.twoFactorEnabled ? 'default' : 'secondary'}>
				{data.twoFactorEnabled
					? m.admin_settings_2fa_status_on()
					: m.admin_settings_2fa_status_off()}
			</Badge>
		</div>
		<p class="mb-3 text-sm text-muted-foreground">{m.admin_settings_2fa_desc()}</p>

		{#if actionForm?.message}
			<div class="mb-3 flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm" role="status">
				<IconAlertCircle class="size-4 shrink-0" />
				<span>{actionForm.message}</span>
			</div>
		{/if}

		{#if pendingTotpURI}
			<div class="space-y-3 rounded-lg border bg-background p-3">
				<p class="text-sm">{m.admin_settings_2fa_scan_hint()}</p>
				<div class="space-y-1">
					<div class="text-xs text-muted-foreground">{m.admin_settings_2fa_secret()}</div>
					<code class="block rounded bg-muted px-2 py-1 text-xs break-all">{pendingTotpURI}</code>
				</div>
				<form method="post" action="?/activate" use:enhance class="flex items-end gap-2">
					<Input
						name="code"
						type="text"
						inputmode="numeric"
						autocomplete="one-time-code"
						placeholder="123456"
						required
					/>
					<Button type="submit" size="sm">
						<IconKey data-icon="inline-start" />
						{m.admin_settings_2fa_activate()}
					</Button>
				</form>
			</div>
		{/if}

		{#if pendingBackupCodes.length}
			<div class="space-y-2 rounded-lg border bg-background p-3">
				<div class="text-xs text-muted-foreground">{m.admin_settings_2fa_backup_codes()}</div>
				<div class="grid grid-cols-2 gap-1">
					{#each pendingBackupCodes as backupCode (backupCode)}
						<code class="rounded bg-muted px-2 py-1 text-xs">{backupCode}</code>
					{/each}
				</div>
			</div>
		{/if}

		{#if data.twoFactorEnabled}
			<div class="flex flex-wrap items-end gap-2">
				<form
					method="post"
					action="?/regenerateBackupCodes"
					use:enhance
					class="flex items-end gap-2"
				>
					<Input
						name="password"
						type="password"
						autocomplete="current-password"
						placeholder={m.admin_settings_2fa_password()}
						required
					/>
					<Button type="submit" variant="outline" size="sm">
						{m.admin_settings_2fa_regenerate()}
					</Button>
				</form>
				<form method="post" action="?/disable" use:enhance class="flex items-end gap-2">
					<Input
						name="password"
						type="password"
						autocomplete="current-password"
						placeholder={m.admin_settings_2fa_password()}
						required
					/>
					<Button type="submit" variant="outline" size="sm" class="text-destructive">
						{m.admin_settings_2fa_disable()}
					</Button>
				</form>
			</div>
		{:else if !pendingTotpURI}
			<form method="post" action="?/enable" use:enhance class="flex items-end gap-2">
				<Input
					name="password"
					type="password"
					autocomplete="current-password"
					placeholder={m.admin_settings_2fa_password()}
					required
				/>
				<Button type="submit" size="sm">{m.admin_settings_2fa_enable()}</Button>
			</form>
		{/if}
	</section>

	<Separator.Root />

	<!-- Section: 登录设备 -->
	<section>
		<div class="mb-4 flex items-center justify-between">
			<div class="flex items-center gap-2">
				<IconDeviceLaptop class="size-5 text-muted-foreground" />
				<h3 class="text-base font-semibold">登录设备</h3>
			</div>
			<Button variant="outline" size="sm">踢掉其他设备</Button>
		</div>
		<div class="space-y-3">
			{#each devices as device (device.id)}
				<div
					class="flex items-center gap-3 rounded-lg border bg-background p-3 {device.current
						? 'border-emerald-500/30'
						: ''}"
				>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="truncate text-sm font-medium">{device.name}</span>
							<Badge
								variant={device.current ? 'default' : 'secondary'}
								class={device.current ? 'bg-emerald-500 text-emerald-50 hover:bg-emerald-500' : ''}
							>
								{device.current ? '当前' : '其他'}
							</Badge>
						</div>
						<div class="mt-1 space-y-0.5 text-xs text-muted-foreground">
							<div>IP: {device.ip}</div>
							<div>{device.ua}</div>
							<div>{device.time}</div>
						</div>
					</div>
					<Button variant="ghost" size="sm" class="shrink-0 text-destructive">
						{device.current ? '退出' : '踢掉'}
					</Button>
				</div>
			{/each}
		</div>
	</section>

	<Separator.Root />

	<!-- Section: 修改密码 -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconLock class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">修改密码</h3>
		</div>
		<p class="mb-3 text-sm text-muted-foreground">
			定期更换密码可以更好地保护账户安全。建议使用包含大小写字母、数字和特殊字符的强密码。
		</p>
		<Button variant="outline" size="sm">
			<IconLock data-icon="inline-start" />
			修改密码
		</Button>
	</section>

	<Separator.Root />

	<!-- Section: API Token -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconKey class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">API Token</h3>
		</div>
		<p class="mb-3 text-sm text-muted-foreground">
			管理 API 令牌，用于第三方应用或脚本访问平台接口。请妥善保管您的令牌。
		</p>
		<Button variant="outline" size="sm">管理令牌</Button>
	</section>

	<Separator.Root />

	<!-- Section: Passkey -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconShield class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">Passkey</h3>
		</div>
		<p class="mb-3 text-sm text-muted-foreground">
			使用生物识别或设备 PIN 码进行无密码登录。Passkey 比传统密码更安全、更便捷。
		</p>
		<Button variant="outline" size="sm">管理 Passkey</Button>
	</section>

	<Separator.Root />

	<!-- Section: OAuth 登录 -->
	<section>
		<div class="mb-4 flex items-center gap-2">
			<IconGlobe class="size-5 text-muted-foreground" />
			<h3 class="text-base font-semibold">OAuth 登录</h3>
		</div>

		<!-- GitHub OAuth -->
		<div class="rounded-lg border bg-background p-4">
			<div class="mb-3 flex items-center gap-3">
				<IconBrandGithub class="size-5" />
				<span class="text-sm font-medium">GitHub</span>
				<label class="relative inline-flex cursor-pointer items-center">
					<input type="checkbox" class="peer sr-only" bind:checked={s.account.github.enabled} />
					<div
						class="h-5 w-9 rounded-full bg-border transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50"
					></div>
					<div
						class="absolute inset-s-1 size-3.5 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-4"
					></div>
				</label>
			</div>
			<div class="space-y-3">
				<div class="grid gap-2 sm:grid-cols-2">
					<div>
						<label class="mb-1 block text-xs text-muted-foreground" for="github-client-id"
							>Client ID</label
						>
						<Input
							id="github-client-id"
							bind:value={s.account.github.clientId}
							placeholder="GitHub OAuth App Client ID"
						/>
					</div>
					<div>
						<label class="mb-1 block text-xs text-muted-foreground" for="github-client-secret"
							>Client Secret</label
						>
						<Input
							id="github-client-secret"
							type="password"
							bind:value={s.account.github.clientSecret}
							placeholder="GitHub OAuth App Client Secret"
						/>
					</div>
				</div>
				<div>
					<span class="mb-1 block text-xs text-muted-foreground">Callback URL</span>
					<div class="flex items-center gap-2">
						<code class="flex-1 truncate rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs">
							{s.account.github.callbackUrl}
						</code>
						<Button
							variant="ghost"
							size="icon-xs"
							onclick={() => copyToClipboard(s.account.github.callbackUrl, 'gh')}
							aria-label="复制回调地址"
						>
							{#if copiedGh}
								<span class="text-xs text-emerald-500">已复制</span>
							{:else}
								<IconCopy />
							{/if}
						</Button>
					</div>
				</div>
				<div class="flex items-center gap-2 pt-1">
					<Button variant="outline" size="sm">验证连接</Button>
					<Button variant="default" size="sm">
						<IconDeviceFloppy data-icon="inline-start" />
						保存配置
					</Button>
				</div>
			</div>
		</div>

		<!-- Google OAuth -->
		<div class="mt-4 rounded-lg border bg-background p-4">
			<div class="mb-3 flex items-center gap-3">
				<IconBrandGoogle class="size-5" />
				<span class="text-sm font-medium">Google</span>
				<label class="relative inline-flex cursor-pointer items-center">
					<input type="checkbox" class="peer sr-only" bind:checked={s.account.google.enabled} />
					<div
						class="h-5 w-9 rounded-full bg-border transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50"
					></div>
					<div
						class="absolute inset-s-1 size-3.5 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-4"
					></div>
				</label>
			</div>
			<div class="space-y-3">
				<div class="grid gap-2 sm:grid-cols-2">
					<div>
						<label class="mb-1 block text-xs text-muted-foreground" for="google-client-id"
							>Client ID</label
						>
						<Input
							id="google-client-id"
							bind:value={s.account.google.clientId}
							placeholder="Google OAuth Client ID"
						/>
					</div>
					<div>
						<label class="mb-1 block text-xs text-muted-foreground" for="google-client-secret"
							>Client Secret</label
						>
						<Input
							id="google-client-secret"
							type="password"
							bind:value={s.account.google.clientSecret}
							placeholder="Google OAuth Client Secret"
						/>
					</div>
				</div>
				<div>
					<span class="mb-1 block text-xs text-muted-foreground">Callback URL</span>
					<div class="flex items-center gap-2">
						<code class="flex-1 truncate rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs">
							{s.account.google.callbackUrl}
						</code>
						<Button
							variant="ghost"
							size="icon-xs"
							onclick={() => copyToClipboard(s.account.google.callbackUrl, 'google')}
							aria-label="复制回调地址"
						>
							{#if copiedGoogle}
								<span class="text-xs text-emerald-500">已复制</span>
							{:else}
								<IconCopy />
							{/if}
						</Button>
					</div>
				</div>
				<div class="flex items-center gap-2 pt-1">
					<Button variant="outline" size="sm">验证连接</Button>
					<Button variant="default" size="sm">
						<IconDeviceFloppy data-icon="inline-start" />
						保存配置
					</Button>
				</div>
			</div>
		</div>
	</section>
</div>
