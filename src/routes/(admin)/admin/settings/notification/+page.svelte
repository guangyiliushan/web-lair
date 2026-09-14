<script lang="ts">
	import type { PageProps } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);
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
							class="outline-hidden relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.emailEnabled}
							class:bg-surface-inset={!s.notification.emailEnabled}
						>
							<span
								class="shadow-xs block size-4 rounded-full bg-white transition-transform"
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
						<Input id="notif-senderEmail" bind:value={s.notification.senderEmail} placeholder="noreply@example.com" />
					</div>

					<!-- smtpUser -->
					<div class="space-y-1.5">
						<label for="notif-smtpUser" class="text-sm">SMTP 用户名</label>
						<Input id="notif-smtpUser" bind:value={s.notification.smtpUser} placeholder="smtp 用户名" />
					</div>

					<!-- smtpPass -->
					<div class="space-y-1.5">
						<label for="notif-smtpPass" class="text-sm">SMTP 密码</label>
						<Input id="notif-smtpPass" type="password" bind:value={s.notification.smtpPass} placeholder="smtp 密码" />
					</div>

					<!-- smtpHost -->
					<div class="space-y-1.5">
						<label for="notif-smtpHost" class="text-sm">SMTP 服务器</label>
						<Input id="notif-smtpHost" bind:value={s.notification.smtpHost} placeholder="smtp.example.com" />
					</div>

					<!-- smtpPort -->
					<div class="space-y-1.5">
						<label for="notif-smtpPort" class="text-sm">SMTP 端口</label>
						<Input id="notif-smtpPort" type="number" bind:value={s.notification.smtpPort} placeholder="587" />
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
							class="outline-hidden relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.smtpTls}
							class:bg-surface-inset={!s.notification.smtpTls}
						>
							<span
								class="shadow-xs block size-4 rounded-full bg-white transition-transform"
								class:translate-x-4={s.notification.smtpTls}
							></span>
						</button>
					</div>

					<!-- rateLimit -->
					<div class="space-y-1.5">
						<label for="notif-rateLimit" class="text-sm">频率限制（条/小时）</label>
						<Input id="notif-rateLimit" type="number" bind:value={s.notification.rateLimit} placeholder="10" />
					</div>

					<!-- retryCount -->
					<div class="space-y-1.5">
						<label for="notif-retryCount" class="text-sm">重试次数</label>
						<Input id="notif-retryCount" type="number" bind:value={s.notification.retryCount} placeholder="3" />
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
							class="outline-hidden relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.barkEnabled}
							class:bg-surface-inset={!s.notification.barkEnabled}
						>
							<span
								class="shadow-xs block size-4 rounded-full bg-white transition-transform"
								class:translate-x-4={s.notification.barkEnabled}
							></span>
						</button>
					</div>

					<!-- barkKey -->
					<div class="space-y-1.5">
						<label for="notif-barkKey" class="text-sm">Bark Key</label>
						<Input id="notif-barkKey" type="password" bind:value={s.notification.barkKey} placeholder="Bark 设备 Key" />
					</div>

					<!-- barkServer -->
					<div class="space-y-1.5">
						<label for="notif-barkServer" class="text-sm">Bark 服务器</label>
						<Input id="notif-barkServer" bind:value={s.notification.barkServer} placeholder="https://api.day.app" />
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
							class="outline-hidden relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.barkCommentNotify}
							class:bg-surface-inset={!s.notification.barkCommentNotify}
						>
							<span
								class="shadow-xs block size-4 rounded-full bg-white transition-transform"
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
							class="outline-hidden relative inline-flex h-5 min-w-9 items-center rounded-full px-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-accent/15"
							class:bg-accent={s.notification.barkRateLimitNotify}
							class:bg-surface-inset={!s.notification.barkRateLimitNotify}
						>
							<span
								class="shadow-xs block size-4 rounded-full bg-white transition-transform"
								class:translate-x-4={s.notification.barkRateLimitNotify}
							></span>
						</button>
					</div>
				</div>
			</section>

		</div>
	</div>
</div>
