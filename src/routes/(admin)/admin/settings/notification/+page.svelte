<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { page } from '$app/state';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);

	// Webhooks 区块（J-3）：重投动作结果随 page.form 回显。
	const form = $derived(
		page.form as { status?: number; message?: string; retried?: boolean } | null | undefined
	);
	const retryFlash = $derived.by(() => {
		if (!form) return null;
		if (form.retried)
			return { kind: 'ok' as const, text: m.admin_settings_notification_requeued() };
		if (form.message && !form.retried) {
			// `form.status` is never set by kit (J-3 review R4-1): the
			// payload keys carry the signal.
			return { kind: 'error' as const, text: String(form.message) };
		}
		return null;
	});

	function deliveryVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'failed') return 'destructive';
		if (status === 'succeeded') return 'default';
		return 'outline';
	}
</script>

<svelte:head>
	<title>Notifications - Lair Admin</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
		<div class="flex min-w-0 items-center gap-2">
			<IconMail class="size-4 shrink-0 text-muted-foreground" />
			<h2 class="truncate text-sm font-semibold">{m.admin_settings_notification()}</h2>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm" variant="outline">
				<IconMail data-icon="inline-start" />
				{m.admin_settings_notification_send_test()}
			</Button>
			<Button size="sm">
				<IconDeviceFloppy data-icon="inline-start" />
				{m.admin_common_save()}
			</Button>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-auto">
		<div class="space-y-8 p-6">
			<!-- Email 通知 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_notification_email()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- emailEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-emailEnabled" class="text-sm"
							>{m.admin_settings_notification_email_enabled()}</label
						>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.emailEnabled)}
							aria-label={m.admin_settings_notification_email_enabled()}
							id="notif-emailEnabled"
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.emailEnabled}
							class:bg-surface-inset={!s.notification.emailEnabled}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.notification.emailEnabled}
							></span>
						</button>
					</div>

					<!-- emailProvider -->
					<div class="space-y-1.5">
						<label for="notif-emailProvider" class="text-sm"
							>{m.admin_settings_notification_provider()}</label
						>
						<Select.Root type="single" bind:value={s.notification.emailProvider as never}>
							<Select.Trigger id="notif-emailProvider" class="w-full justify-between">
								<span class="truncate">
									{#if s.notification.emailProvider === 'resend'}
										Resend
									{:else}
										SMTP
									{/if}
								</span>
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="smtp">SMTP</Select.Item>
								<Select.Item value="resend">Resend</Select.Item>
							</Select.Content>
						</Select.Root>
					</div>

					<!-- senderEmail -->
					<div class="space-y-1.5">
						<label for="notif-senderEmail" class="text-sm"
							>{m.admin_settings_notification_sender()}</label
						>
						<Input
							id="notif-senderEmail"
							bind:value={s.notification.senderEmail}
							placeholder="noreply@example.com"
						/>
					</div>

					<!-- smtpUser -->
					<div class="space-y-1.5">
						<label for="notif-smtpUser" class="text-sm"
							>{m.admin_settings_notification_smtp_user()}</label
						>
						<Input
							id="notif-smtpUser"
							bind:value={s.notification.smtpUser}
							placeholder={m.admin_settings_notification_smtp_user_ph()}
						/>
					</div>

					<!-- smtpPass -->
					<div class="space-y-1.5">
						<label for="notif-smtpPass" class="text-sm"
							>{m.admin_settings_notification_smtp_pass()}</label
						>
						<Input
							id="notif-smtpPass"
							type="password"
							bind:value={s.notification.smtpPass}
							placeholder={m.admin_settings_notification_smtp_pass_ph()}
						/>
					</div>

					<!-- smtpHost -->
					<div class="space-y-1.5">
						<label for="notif-smtpHost" class="text-sm"
							>{m.admin_settings_notification_smtp_host()}</label
						>
						<Input
							id="notif-smtpHost"
							bind:value={s.notification.smtpHost}
							placeholder="smtp.example.com"
						/>
					</div>

					<!-- smtpPort -->
					<div class="space-y-1.5">
						<label for="notif-smtpPort" class="text-sm"
							>{m.admin_settings_notification_smtp_port()}</label
						>
						<Input
							id="notif-smtpPort"
							type="number"
							bind:value={s.notification.smtpPort}
							placeholder="587"
						/>
					</div>

					<!-- smtpTls -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-smtpTls" class="text-sm">SMTP TLS</label>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.smtpTls)}
							aria-label="SMTP TLS"
							id="notif-smtpTls"
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.smtpTls}
							class:bg-surface-inset={!s.notification.smtpTls}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.notification.smtpTls}
							></span>
						</button>
					</div>

					<!-- rateLimit -->
					<div class="space-y-1.5">
						<label for="notif-rateLimit" class="text-sm"
							>{m.admin_settings_notification_rate_limit()}</label
						>
						<Input
							id="notif-rateLimit"
							type="number"
							bind:value={s.notification.rateLimit}
							placeholder="10"
						/>
					</div>

					<!-- retryCount -->
					<div class="space-y-1.5">
						<label for="notif-retryCount" class="text-sm"
							>{m.admin_settings_notification_retries()}</label
						>
						<Input
							id="notif-retryCount"
							type="number"
							bind:value={s.notification.retryCount}
							placeholder="3"
						/>
					</div>
				</div>
			</section>

			<!-- Bark 通知 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_notification_bark()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- barkEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-barkEnabled" class="text-sm"
							>{m.admin_settings_notification_bark_enabled()}</label
						>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.barkEnabled)}
							aria-label={m.admin_settings_notification_bark_enabled()}
							id="notif-barkEnabled"
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.barkEnabled}
							class:bg-surface-inset={!s.notification.barkEnabled}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.notification.barkEnabled}
							></span>
						</button>
					</div>

					<!-- barkKey -->
					<div class="space-y-1.5">
						<label for="notif-barkKey" class="text-sm">Bark Key</label>
						<Input
							id="notif-barkKey"
							type="password"
							bind:value={s.notification.barkKey}
							placeholder={m.admin_settings_notification_bark_key_ph()}
						/>
					</div>

					<!-- barkServer -->
					<div class="space-y-1.5">
						<label for="notif-barkServer" class="text-sm"
							>{m.admin_settings_notification_bark_server()}</label
						>
						<Input
							id="notif-barkServer"
							bind:value={s.notification.barkServer}
							placeholder="https://api.day.app"
						/>
					</div>

					<!-- barkCommentNotify -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-barkCommentNotify" class="text-sm"
							>{m.admin_settings_notification_comment_notify()}</label
						>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.barkCommentNotify)}
							aria-label={m.admin_settings_notification_comment_notify()}
							id="notif-barkCommentNotify"
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.barkCommentNotify}
							class:bg-surface-inset={!s.notification.barkCommentNotify}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.notification.barkCommentNotify}
							></span>
						</button>
					</div>

					<!-- barkRateLimitNotify -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-barkRateLimitNotify" class="text-sm"
							>{m.admin_settings_notification_ratelimit_notify()}</label
						>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.barkRateLimitNotify)}
							aria-label={m.admin_settings_notification_ratelimit_notify()}
							id="notif-barkRateLimitNotify"
							class="relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 outline-hidden transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.barkRateLimitNotify}
							class:bg-surface-inset={!s.notification.barkRateLimitNotify}
						>
							<span
								class="block size-4 rounded-full bg-white shadow-xs transition-transform"
								class:translate-x-4={s.notification.barkRateLimitNotify}
							></span>
						</button>
					</div>
				</div>
			</section>

			<!-- Webhooks（J-3：只读端点列表 + 投递记录 + 重投） -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">Webhooks</h3>
				<div class="space-y-4 rounded-lg border p-4">
					{#if retryFlash}
						<p
							role="status"
							class="text-sm {retryFlash.kind === 'error' ? 'text-destructive' : 'text-foreground'}"
						>
							{retryFlash.text}
						</p>
					{/if}

					<div class="space-y-2">
						<p class="text-xs font-medium text-muted-foreground">
							{m.admin_settings_notification_endpoints()}
						</p>
						{#if data.webhookEndpoints.length === 0}
							<p class="text-xs text-muted-foreground">
								{m.admin_settings_notification_no_endpoints()}
							</p>
						{:else}
							<ul class="space-y-1">
								{#each data.webhookEndpoints as endpoint (endpoint.id)}
									<li class="flex flex-wrap items-center gap-2 text-xs">
										<span class="font-medium">{endpoint.name}</span>
										<code class="text-muted-foreground">{endpoint.payloadUrl}</code>
										<Badge variant={endpoint.isEnabled ? 'default' : 'outline'}>
											{endpoint.isEnabled
												? m.admin_common_enable()
												: m.admin_common_disable()}
										</Badge>
										<span class="text-muted-foreground">{endpoint.events.join(' · ')}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					<div class="space-y-2">
						<p class="text-xs font-medium text-muted-foreground">
							{m.admin_settings_notification_recent_deliveries()}
						</p>
						{#if data.webhookDeliveries.length === 0}
							<p class="text-xs text-muted-foreground">
								{m.admin_settings_notification_no_deliveries()}
							</p>
						{:else}
							<div class="overflow-hidden rounded-md border">
								{#each data.webhookDeliveries as delivery (delivery.id)}
									<div
										class="flex flex-wrap items-center gap-2 border-b px-2 py-1.5 text-xs last:border-b-0"
										data-slot="delivery-row"
									>
										<span class="w-40 shrink-0 text-muted-foreground">{delivery.createdLabel}</span>
										<span class="font-mono">{delivery.event}</span>
										<span class="min-w-0 flex-1 truncate text-muted-foreground">
											{delivery.webhookName}
											{#if delivery.error}· {delivery.error}{/if}
										</span>
										<Badge variant={deliveryVariant(delivery.status)} class="w-fit">
											{delivery.status === 'failed'
												? m.admin_settings_notification_failed()
												: delivery.status === 'succeeded'
													? m.admin_settings_notification_succeeded()
													: m.admin_settings_notification_queued()}
										</Badge>
										{#if delivery.status === 'failed'}
											<span class="text-muted-foreground">
												{delivery.responseCode
													? `HTTP ${delivery.responseCode}`
													: m.admin_settings_notification_no_response()}
											</span>
											<form method="POST" action="?/retry">
												<input type="hidden" name="id" value={delivery.id} />
												<Button type="submit" variant="outline" size="sm"
													>{m.admin_settings_notification_requeue()}</Button
												>
											</form>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</section>
		</div>
	</div>
</div>
