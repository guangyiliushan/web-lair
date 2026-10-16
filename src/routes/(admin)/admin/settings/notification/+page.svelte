<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconDeviceFloppy from '@tabler/icons-svelte-runes/icons/device-floppy';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconKey from '@tabler/icons-svelte-runes/icons/key';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';

	let { data }: PageProps = $props();
	let s = $derived(data.settings);

	interface EndpointRow {
		id: string;
		name: string;
		payloadUrl: string;
		events: string[];
		isEnabled: boolean;
		secretPreview: string;
	}

	// Action results are echoed back via page.form. `op` routes dialog-scoped
	// failures into their dialog; the top flash carries success + row-level
	// outcomes. The ONE-TIME secret reveal lives in `revealedSecret` -
	// dedicated state captured from the enhance results (round-2 SY-UI-03;
	// the flash slot deliberately does NOT carry the secret any more).
	const form = $derived(
		page.form as
			| {
					status?: number;
					message?: string;
					op?: string;
					retried?: boolean;
					created?: boolean;
					updated?: boolean;
					deleted?: boolean;
					rotated?: boolean;
			  }
			| null
			| undefined
	);
	const flash = $derived.by(() => {
		if (!form) return null;
		if (form.retried)
			return { kind: 'ok' as const, text: m.admin_settings_notification_requeued() };
		if (form.created)
			return { kind: 'ok' as const, text: m.admin_settings_notification_endpoint_created() };
		if (form.updated)
			return { kind: 'ok' as const, text: m.admin_settings_notification_endpoint_updated() };
		if (form.deleted)
			return { kind: 'ok' as const, text: m.admin_settings_notification_endpoint_deleted_ok() };
		if (form.rotated)
			return { kind: 'ok' as const, text: m.admin_settings_notification_secret_rotated() };
		// Success flashes: create/update/delete/rotate/retry; the toggle relies
		// on the badge flip instead. Dialog-scoped failures render inside their
		// dialog; row-level failures (toggle) and legacy retry failures land
		// here. `form.status` is never set by kit (J-3 review R4-1): the payload
		// keys carry the signal.
		if (form.message && (form.op === undefined || form.op === 'toggle')) {
			return { kind: 'error' as const, text: String(form.message) };
		}
		return null;
	});

	function deliveryVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'failed') return 'destructive';
		if (status === 'succeeded') return 'default';
		return 'outline';
	}

	// Endpoint editor dialog (create when `editingId === null`, edit prefills).
	let endpointDialogOpen = $state(false);
	let editingId = $state<string | null>(null);
	let formName = $state('');
	let formPayloadUrl = $state('');
	let formEvents = $state<string[]>([]);
	let endpointPending = $state(false);
	// Dialog-local failure text (review round-1 SY-UI-01): rendering straight
	// from page.form leaked the previous attempt's error into a freshly
	// reopened dialog; each surface now captures its own failure.
	let editorError = $state<string | null>(null);
	let deleteError = $state<string | null>(null);
	let rotateError = $state<string | null>(null);
	// Submission epochs (review round-1 SY-UI-02): a late response must not
	// close or write into a dialog the user has since closed / re-opened.
	let editorToken = 0;
	let deleteToken = 0;
	let rotateToken = 0;

	let deleteTarget = $state<EndpointRow | null>(null);
	let deletePending = $state(false);
	let rotateTarget = $state<EndpointRow | null>(null);
	let rotatePending = $state(false);
	let retryPendingId = $state<string | null>(null);
	let togglePendingId = $state<string | null>(null);
	// One-time plaintext reveal in DEDICATED state (review round-2 SY-UI-03):
	// deriving it from the page-wide form slot meant any unrelated submission
	// (a toggle, a retry) replaced page.form and silently wiped it mid-copy.
	let revealedSecret = $state<string | null>(null);
	let copyState = $state<'idle' | 'ok' | 'failed'>('idle');
	// A failure whose dialog session moved on is surfaced here instead of
	// being dropped silently (review round-2 SY-UI-06).
	let pageNotice = $state<string | null>(null);

	function openEndpointDialog(endpoint: EndpointRow | null) {
		editorToken += 1;
		editorError = null;
		endpointPending = false;
		// A create/edit session starts clean: drop any previous reveal and the
		// last stale-failure notice.
		revealedSecret = null;
		copyState = 'idle';
		pageNotice = null;
		editingId = endpoint?.id ?? null;
		formName = endpoint?.name ?? '';
		formPayloadUrl = endpoint?.payloadUrl ?? '';
		formEvents = endpoint ? [...endpoint.events] : [];
		endpointDialogOpen = true;
	}

	function closeEndpointDialog() {
		editorToken += 1;
		editorError = null;
		endpointPending = false;
		endpointDialogOpen = false;
		editingId = null;
		formName = '';
		formPayloadUrl = '';
		formEvents = [];
	}

	function openDeleteDialog(endpoint: EndpointRow) {
		deleteToken += 1;
		deleteError = null;
		deletePending = false;
		// Stale-failure notices belong to the surface that raised them
		// (round-3 SY3-3).
		pageNotice = null;
		deleteTarget = endpoint;
	}

	function closeDeleteDialog() {
		deleteToken += 1;
		deleteError = null;
		deletePending = false;
		deleteTarget = null;
	}

	function openRotateDialog(endpoint: EndpointRow) {
		rotateToken += 1;
		rotateError = null;
		rotatePending = false;
		// Stale-failure notices belong to the surface that raised them
		// (round-3 SY3-3).
		pageNotice = null;
		rotateTarget = endpoint;
	}

	function closeRotateDialog() {
		rotateToken += 1;
		rotateError = null;
		rotatePending = false;
		rotateTarget = null;
	}

	function failureMessage(data: unknown): string | null {
		const message = (data as { message?: unknown } | null | undefined)?.message;
		return typeof message === 'string' ? message : null;
	}

	async function copySecret() {
		if (!revealedSecret) return;
		try {
			// Absent outside secure contexts (review round-2 SY-UI-01): guard
			// and report instead of an unhandled rejection with no feedback.
			if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
			await navigator.clipboard.writeText(revealedSecret);
			copyState = 'ok';
		} catch {
			copyState = 'failed';
		}
	}
</script>

<svelte:head>
	<title>{m.admin_settings_notification_title()} - Lair Admin</title>
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
			<!-- Email notifications -->
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
						<label for="notif-smtpTls" class="text-sm"
							>{m.admin_settings_notification_smtp_tls()}</label
						>
						<button
							type="button"
							role="switch"
							aria-checked={Boolean(s.notification.smtpTls)}
							aria-label={m.admin_settings_notification_smtp_tls()}
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

			<!-- Bark notifications -->
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
						<label for="notif-barkKey" class="text-sm"
							>{m.admin_settings_notification_bark_key()}</label
						>
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

			<!-- Webhooks (J-3: read-only endpoint list + delivery log + re-queue) -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_notification_webhooks()}</h3>
				<div class="space-y-4 rounded-lg border p-4">
					<!-- Persistent status region (review round-2 SY-UI-04: a live
					     region must exist before its content arrives). The one-time
					     reveal lives in dedicated state (SY-UI-03) so unrelated
					     submissions cannot wipe it. -->
					<div role="status" class="space-y-2">
						{#if flash}
							<p
								data-slot="webhook-flash"
								class="text-sm {flash.kind === 'error' ? 'text-destructive' : 'text-foreground'}"
							>
								{flash.text}
							</p>
						{/if}
						{#if pageNotice}
							<p class="text-sm text-destructive">{pageNotice}</p>
						{/if}
						{#if revealedSecret}
							<div data-slot="secret-reveal" class="space-y-1 rounded-md border border-dashed p-2">
								<p class="text-xs text-muted-foreground">
									{m.admin_settings_notification_secret_shown_once()}
								</p>
								<div class="flex items-start gap-2">
									<code class="min-w-0 flex-1 text-xs break-all">{revealedSecret}</code>
									<Button type="button" variant="outline" size="sm" onclick={copySecret}
										>{m.admin_settings_notification_copy_secret()}</Button
									>
								</div>
								{#if copyState === 'ok'}
									<p class="text-xs text-muted-foreground">
										{m.admin_settings_notification_copy_secret_done()}
									</p>
								{:else if copyState === 'failed'}
									<p class="text-xs text-destructive">
										{m.admin_settings_notification_copy_secret_failed()}
									</p>
								{/if}
							</div>
						{/if}
					</div>

					<div class="space-y-2">
						<div class="flex items-center justify-between gap-2">
							<p class="text-xs font-medium text-muted-foreground">
								{m.admin_settings_notification_endpoints()}
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onclick={() => openEndpointDialog(null)}
							>
								<IconPlus class="size-3.5" />
								{m.admin_settings_notification_add_endpoint()}
							</Button>
						</div>
						{#if data.webhookEndpoints.length === 0}
							<p class="text-xs text-muted-foreground">
								{m.admin_settings_notification_no_endpoints()}
							</p>
						{:else}
							<ul class="space-y-1">
								{#each data.webhookEndpoints as endpoint (endpoint.id)}
									<li data-slot="endpoint-row" class="flex flex-wrap items-center gap-2 text-xs">
										<span class="font-medium">{endpoint.name}</span>
										<code class="break-all text-muted-foreground">{endpoint.payloadUrl}</code>
										<Badge variant={endpoint.isEnabled ? 'default' : 'outline'}>
											{endpoint.isEnabled ? m.admin_common_enable() : m.admin_common_disable()}
										</Badge>
										<span class="text-muted-foreground">{endpoint.events.join(' · ')}</span>
										<span class="text-muted-foreground"
											>{m.admin_settings_notification_endpoint_secret()}:
											<code>{endpoint.secretPreview}</code></span
										>
										<span class="ml-auto flex items-center gap-1">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												aria-label={`${m.admin_common_edit()} (${endpoint.name})`}
												onclick={() => openEndpointDialog(endpoint)}
											>
												<IconPencil class="size-3.5" />
											</Button>
											<form
												method="POST"
												action="?/toggle"
												use:enhance={() => {
													togglePendingId = endpoint.id;
													return async ({ update }) => {
														await update();
														// Conditional clear (round-2 N3/SY-UI-05): only the
														// submitter clears its own marker, so a response for
														// one row cannot re-enable another row mid-flight.
														if (togglePendingId === endpoint.id) togglePendingId = null;
													};
												}}
											>
												<input type="hidden" name="id" value={endpoint.id} />
												<input
													type="hidden"
													name="enabled"
													value={endpoint.isEnabled ? 'false' : 'true'}
												/>
												<Button
													type="submit"
													variant="ghost"
													size="sm"
													disabled={togglePendingId === endpoint.id}
													aria-label={`${
														endpoint.isEnabled ? m.admin_common_disable() : m.admin_common_enable()
													} (${endpoint.name})`}
												>
													{endpoint.isEnabled ? m.admin_common_disable() : m.admin_common_enable()}
												</Button>
											</form>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												aria-label={`${m.admin_settings_notification_rotate_secret()} (${endpoint.name})`}
												onclick={() => openRotateDialog(endpoint)}
											>
												<IconKey class="size-3.5" />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												aria-label={`${m.admin_common_delete()} (${endpoint.name})`}
												onclick={() => openDeleteDialog(endpoint)}
											>
												<IconTrash class="size-3.5" />
											</Button>
										</span>
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
											<form
												method="POST"
												action="?/retry"
												use:enhance={() => {
													retryPendingId = delivery.id;
													return async ({ update }) => {
														await update();
														// Conditional clear (round-2 N3/SY-UI-05).
														if (retryPendingId === delivery.id) retryPendingId = null;
													};
												}}
											>
												<input type="hidden" name="id" value={delivery.id} />
												<Button
													type="submit"
													variant="outline"
													size="sm"
													disabled={retryPendingId === delivery.id}
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

<!-- Endpoint editor (create when no id; edit prefills) - SY S2 -->
<Dialog.Root open={endpointDialogOpen} onOpenChange={(open) => !open && closeEndpointDialog()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title
				>{editingId
					? m.admin_settings_notification_edit_endpoint()
					: m.admin_settings_notification_add_endpoint()}</Dialog.Title
			>
		</Dialog.Header>
		<form
			method="POST"
			action={editingId ? '?/update' : '?/create'}
			class="space-y-4"
			use:enhance={() => {
				const token = ++editorToken;
				endpointPending = true;
				return async ({ result, update }) => {
					await update();
					// The reveal lives in the page region, not the dialog: capture
					// the one-time secret even when the submitted dialog has moved
					// on (a stale-epoch success would otherwise lose the only
					// plaintext copy; review round-3 F1/SY3-1). A success also
					// supersedes any stale-failure notice.
					if (result.type === 'success') {
						const secret = (result.data as { secret?: unknown } | null)?.secret;
						if (typeof secret === 'string') {
							revealedSecret = secret;
							copyState = 'idle';
						}
						pageNotice = null;
					}
					if (token !== editorToken) {
						// The surface moved on: keep this dialog clean, but do
						// not drop the failure silently (round-2 SY-UI-06).
						if (result.type === 'failure') pageNotice = failureMessage(result.data);
						return;
					}
					endpointPending = false;
					if (result.type === 'success') closeEndpointDialog();
					else if (result.type === 'failure') editorError = failureMessage(result.data);
				};
			}}
		>
			{#if editingId}
				<input type="hidden" name="id" value={editingId} />
			{/if}
			<div class="space-y-1.5">
				<label for="hook-name" class="text-sm"
					>{m.admin_settings_notification_endpoint_name()}</label
				>
				<Input id="hook-name" name="name" bind:value={formName} required maxlength={120} />
			</div>
			<div class="space-y-1.5">
				<label for="hook-url" class="text-sm">{m.admin_settings_notification_endpoint_url()}</label>
				<Input
					id="hook-url"
					name="payloadUrl"
					bind:value={formPayloadUrl}
					required
					maxlength={2048}
					placeholder="https://example.com/hooks/lair"
				/>
			</div>
			<fieldset class="space-y-1.5">
				<legend class="text-sm">{m.admin_settings_notification_endpoint_events()}</legend>
				<div class="grid grid-cols-2 gap-1">
					{#each data.webhookEventRoster as eventName (eventName)}
						<label class="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								name="events"
								value={eventName}
								bind:group={formEvents}
								class="size-3.5 accent-primary"
							/>
							<span class="font-mono">{eventName}</span>
						</label>
					{/each}
				</div>
			</fieldset>
			{#if editorError}
				<p role="alert" class="text-sm text-destructive">{editorError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={closeEndpointDialog}
					>{m.admin_common_cancel()}</Button
				>
				<Button type="submit" disabled={endpointPending}>{m.admin_common_save()}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<!-- Delete confirm (cascades the delivery log) - SY S2 -->
<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(open) => !open && closeDeleteDialog()}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_settings_notification_delete_endpoint_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_settings_notification_delete_endpoint({ name: deleteTarget?.name ?? '' })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if deleteError}
			<p role="alert" class="text-sm text-destructive">{deleteError}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form
				method="POST"
				action="?/delete"
				use:enhance={() => {
					const token = ++deleteToken;
					deletePending = true;
					return async ({ result, update }) => {
						await update();
						if (token !== deleteToken) {
							if (result.type === 'failure') pageNotice = failureMessage(result.data);
							return;
						}
						deletePending = false;
						if (result.type === 'success') closeDeleteDialog();
						else if (result.type === 'failure') deleteError = failureMessage(result.data);
					};
				}}
			>
				<input type="hidden" name="id" value={deleteTarget?.id ?? ''} />
				<AlertDialog.Action type="submit" disabled={deletePending}
					>{m.admin_common_delete()}</AlertDialog.Action
				>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Secret rotation confirm - SY S2 -->
<AlertDialog.Root
	open={rotateTarget !== null}
	onOpenChange={(open) => !open && closeRotateDialog()}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.admin_settings_notification_rotate_secret()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.admin_settings_notification_rotate_secret_confirm({ name: rotateTarget?.name ?? '' })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if rotateError}
			<p role="alert" class="text-sm text-destructive">{rotateError}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.admin_common_cancel()}</AlertDialog.Cancel>
			<form
				method="POST"
				action="?/rotate"
				use:enhance={() => {
					const token = ++rotateToken;
					rotatePending = true;
					return async ({ result, update }) => {
						await update();
						// Capture the fresh secret even on a moved-on epoch (round-3
						// F1/SY3-1); a success supersedes any stale-failure notice.
						if (result.type === 'success') {
							const secret = (result.data as { secret?: unknown } | null)?.secret;
							if (typeof secret === 'string') {
								revealedSecret = secret;
								copyState = 'idle';
							}
							pageNotice = null;
						}
						if (token !== rotateToken) {
							if (result.type === 'failure') pageNotice = failureMessage(result.data);
							return;
						}
						rotatePending = false;
						if (result.type === 'success') closeRotateDialog();
						else if (result.type === 'failure') rotateError = failureMessage(result.data);
					};
				}}
			>
				<input type="hidden" name="id" value={rotateTarget?.id ?? ''} />
				<AlertDialog.Action type="submit" disabled={rotatePending}
					>{m.admin_settings_notification_rotate_secret()}</AlertDialog.Action
				>
			</form>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
