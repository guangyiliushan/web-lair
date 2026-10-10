<script lang="ts">
	import type { PageProps } from './$types';
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
			return { kind: 'ok' as const, text: '已重投：新排队行已写入，≤1 tick 内投递' };
		if (typeof form.status === 'number' && form.status >= 400) {
			return { kind: 'error' as const, text: String(form.message ?? '操作失败') };
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
			<h2 class="truncate text-sm font-semibold">通知设置</h2>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<Button size="sm" variant="outline">
				<IconMail data-icon="inline-start" />
				发送测试邮件
			</Button>
			<Button size="sm">
				<IconDeviceFloppy data-icon="inline-start" />
				保存
			</Button>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-auto">
		<div class="space-y-8 p-6">
			<!-- Email 通知 -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">邮件通知</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- emailEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-emailEnabled" class="text-sm">启用邮件通知</label>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.emailEnabled)}
							aria-label="启用邮件通知"
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
						<label for="notif-emailProvider" class="text-sm">邮件服务商</label>
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
						<label for="notif-senderEmail" class="text-sm">发件人邮箱</label>
						<Input
							id="notif-senderEmail"
							bind:value={s.notification.senderEmail}
							placeholder="noreply@example.com"
						/>
					</div>

					<!-- smtpUser -->
					<div class="space-y-1.5">
						<label for="notif-smtpUser" class="text-sm">SMTP 用户名</label>
						<Input
							id="notif-smtpUser"
							bind:value={s.notification.smtpUser}
							placeholder="smtp 用户名"
						/>
					</div>

					<!-- smtpPass -->
					<div class="space-y-1.5">
						<label for="notif-smtpPass" class="text-sm">SMTP 密码</label>
						<Input
							id="notif-smtpPass"
							type="password"
							bind:value={s.notification.smtpPass}
							placeholder="smtp 密码"
						/>
					</div>

					<!-- smtpHost -->
					<div class="space-y-1.5">
						<label for="notif-smtpHost" class="text-sm">SMTP 服务器</label>
						<Input
							id="notif-smtpHost"
							bind:value={s.notification.smtpHost}
							placeholder="smtp.example.com"
						/>
					</div>

					<!-- smtpPort -->
					<div class="space-y-1.5">
						<label for="notif-smtpPort" class="text-sm">SMTP 端口</label>
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
						<label for="notif-rateLimit" class="text-sm">频率限制（条/小时）</label>
						<Input
							id="notif-rateLimit"
							type="number"
							bind:value={s.notification.rateLimit}
							placeholder="10"
						/>
					</div>

					<!-- retryCount -->
					<div class="space-y-1.5">
						<label for="notif-retryCount" class="text-sm">重试次数</label>
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
				<h3 class="mb-4 text-sm font-semibold">Bark 通知</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- barkEnabled -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-barkEnabled" class="text-sm">启用 Bark 推送</label>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.barkEnabled)}
							aria-label="启用 Bark 推送"
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
							placeholder="Bark 设备 Key"
						/>
					</div>

					<!-- barkServer -->
					<div class="space-y-1.5">
						<label for="notif-barkServer" class="text-sm">Bark 服务器</label>
						<Input
							id="notif-barkServer"
							bind:value={s.notification.barkServer}
							placeholder="https://api.day.app"
						/>
					</div>

					<!-- barkCommentNotify -->
					<div class="flex items-center justify-between gap-4">
						<label for="notif-barkCommentNotify" class="text-sm">评论通知</label>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.barkCommentNotify)}
							aria-label="评论通知"
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
						<label for="notif-barkRateLimitNotify" class="text-sm">触发频率限制时通知</label>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.barkRateLimitNotify)}
							aria-label="触发频率限制时通知"
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
						<p class="text-xs font-medium text-muted-foreground">端点</p>
						{#if data.webhookEndpoints.length === 0}
							<p class="text-xs text-muted-foreground">尚未配置端点（端点 CRUD 属后续小批）。</p>
						{:else}
							<ul class="space-y-1">
								{#each data.webhookEndpoints as endpoint (endpoint.id)}
									<li class="flex flex-wrap items-center gap-2 text-xs">
										<span class="font-medium">{endpoint.name}</span>
										<code class="text-muted-foreground">{endpoint.payloadUrl}</code>
										<Badge variant={endpoint.isEnabled ? 'default' : 'outline'}>
											{endpoint.isEnabled ? '启用' : '停用'}
										</Badge>
										<span class="text-muted-foreground">{endpoint.events.join(' · ')}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					<div class="space-y-2">
						<p class="text-xs font-medium text-muted-foreground">最近投递（50 条）</p>
						{#if data.webhookDeliveries.length === 0}
							<p class="text-xs text-muted-foreground">暂无投递记录。</p>
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
												? '失败'
												: delivery.status === 'succeeded'
													? '成功'
													: '排队'}
										</Badge>
										{#if delivery.status === 'failed'}
											<span class="text-muted-foreground">
												{delivery.responseCode ? `HTTP ${delivery.responseCode}` : '无响应'}
											</span>
											<form method="POST" action="?/retry">
												<input type="hidden" name="id" value={delivery.id} />
												<Button type="submit" variant="outline" size="sm">重投</Button>
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
