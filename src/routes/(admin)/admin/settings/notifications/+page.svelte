<script lang="ts">
	import type { PageProps } from './$types';
	import { m } from '$lib/paraglide/messages';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import IconMail from '@tabler/icons-svelte-runes/icons/mail';
	import IconPlus from '@tabler/icons-svelte-runes/icons/plus';
	import IconPencil from '@tabler/icons-svelte-runes/icons/pencil';
	import IconKey from '@tabler/icons-svelte-runes/icons/key';
	import IconTrash from '@tabler/icons-svelte-runes/icons/trash';
	import { SettingsProviderStatus } from '$lib/components/admin/settings';

	let { data }: PageProps = $props();

	interface EndpointRow {
		id: string;
		name: string;
		payloadUrl: string;
		events: string[];
		isEnabled: boolean;
		secretPreview: string | null;
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
					toggled?: boolean;
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
		// Success flashes: create/update/delete/rotate/retry; the toggle relies on
		// the badge flip instead. Dialog-scoped failures render inside their dialog;
		// row-level failures (toggle) and legacy retry failures land here.
		// `form.status` is never set by kit: the payload keys carry the signal.
		// A toggle success carries a message (the badge flip alone announced nothing
		// to AT users) and must render as an OK flash, not through the error branch.
		if (form.toggled && form.message) {
			return { kind: 'ok' as const, text: String(form.message) };
		}
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
	// Dialog-local failure text: rendering straight from page.form leaked the
	// previous attempt's error into a freshly reopened dialog; each surface now
	// captures its own failure.
	let editorError = $state<string | null>(null);
	let deleteError = $state<string | null>(null);
	let rotateError = $state<string | null>(null);
	// Submission epochs: a late response must not close or write into a dialog the
	// user has since closed / re-opened. Non-reactive on purpose: these counters are
	// only compared inside the enhance callbacks - never read from the template or a
	// $derived/$effect (a template read would silently pin them).
	let editorToken = 0;
	let deleteToken = 0;
	let rotateToken = 0;

	let deleteTarget = $state<EndpointRow | null>(null);
	let deletePending = $state(false);
	let rotateTarget = $state<EndpointRow | null>(null);
	let rotatePending = $state(false);
	let retryPendingId = $state<string | null>(null);
	let togglePendingId = $state<string | null>(null);
	// Mail test: the send result stays local to the Mail section; the page-wide
	// `form` slot belongs to the webhook actions.
	let mailPending = $state(false);
	let mailNotice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	// One-time plaintext reveal in DEDICATED state: deriving it from the page-wide
	// form slot meant any unrelated submission (a toggle, a retry) replaced page.form
	// and silently wiped it mid-copy.
	let revealedSecret = $state<string | null>(null);
	// Channel preferences, Bark status and the notification log are independent
	// surfaces with their own pending/notice state, so a resend cannot overwrite a
	// preferences message.
	let prefsPending = $state(false);
	let prefsNotice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let resendPendingId = $state<string | null>(null);
	let logNotice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	// Preference groups in display order; `key` matches the option's JSON keys.
	const preferenceGroups = [
		{ key: 'comment' as const, label: m.admin_settings_notification_group_comment() },
		{ key: 'job' as const, label: m.admin_settings_notification_group_job() },
		{ key: 'ops' as const, label: m.admin_settings_notification_group_ops() }
	];
	let copyState = $state<'idle' | 'ok' | 'failed'>('idle');
	// A failure whose dialog session moved on is surfaced here instead of being
	// dropped silently.
	let pageNotice = $state<string | null>(null);

	function openEndpointDialog(endpoint: EndpointRow | null) {
		editorToken += 1;
		editorError = null;
		endpointPending = false;
		// A create/edit session clears the last stale-failure notice, but the
		// one-time reveal deliberately SURVIVES opening the editor (nine-
		// dimension SY8-3: clicking Add/Edit must not destroy a secret the
		// admin has not copied yet; create/rotate successes supersede it).
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
		// The form content is kept until the next open (which re-seeds it):
		// bits-ui paints the closing animation for ~100 ms, and clearing here
		// flashed an empty "Add endpoint" frame plus swapped the form action
		// mid-exit (nine-dimension SY8-5).
		endpointDialogOpen = false;
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

	// One-time secret capture shared by the editor and rotate callbacks
	// (nine-dimension SY9-1: the round-3 fix had landed twice by hand).
	function captureSecret(data: unknown): void {
		const secret = (data as { secret?: unknown } | null)?.secret;
		if (typeof secret === 'string') {
			revealedSecret = secret;
			copyState = 'idle';
		}
		pageNotice = null;
	}

	async function copySecret() {
		if (!revealedSecret) return;
		try {
			// Absent outside secure contexts: guard and report instead of an
			// unhandled rejection with no feedback.
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
	</header>

	<div class="min-h-0 flex-1 overflow-auto">
		<div class="space-y-8 p-6">
			<!-- Mail status (read-only; SMTP stays env-only) -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_notifications_mail()}</h3>
				<div class="rounded-lg border">
					<SettingsProviderStatus
						name={m.admin_settings_notifications_mail()}
						state={data.mail.configured ? 'configured' : 'not_configured'}
						detail={data.mail.configured
							? m.admin_settings_notifications_mail_configured()
							: m.admin_settings_notifications_mail_unconfigured()}
					/>
					<dl class="grid gap-x-6 gap-y-2 border-t p-4 text-xs sm:grid-cols-2">
						<div class="flex items-baseline justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_settings_notification_mail_enabled()}</dt>
							<dd>
								{data.mail.enabled
									? m.admin_settings_notification_mail_enabled_on()
									: m.admin_settings_notification_mail_enabled_off()}
							</dd>
						</div>
						<div class="flex items-baseline justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_settings_notification_mail_host()}</dt>
							<dd class="font-mono">{data.mail.host ?? '—'}</dd>
						</div>
						<div class="flex items-baseline justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_settings_notification_mail_port()}</dt>
							<dd class="font-mono">{data.mail.port ?? '—'}</dd>
						</div>
						<div class="flex items-baseline justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_settings_notification_mail_from()}</dt>
							<dd class="font-mono break-all">{data.mail.from ?? '—'}</dd>
						</div>
						<div class="flex items-baseline justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_settings_notification_mail_tls()}</dt>
							<dd>
								{data.mail.tls === 'implicit'
									? m.admin_settings_notification_mail_tls_implicit()
									: data.mail.tls === 'starttls'
										? m.admin_settings_notification_mail_tls_starttls()
										: data.mail.tls === 'opportunistic'
											? m.admin_settings_notification_mail_tls_opportunistic()
											: '—'}
							</dd>
						</div>
						<div class="flex items-baseline justify-between gap-3">
							<dt class="text-muted-foreground">{m.admin_settings_notification_mail_dkim()}</dt>
							<dd>
								{data.mail.dkim.configured
									? m.admin_settings_notification_mail_dkim_on({
											selector: data.mail.dkim.selector ?? '',
											domain: data.mail.dkim.domain ?? ''
										})
									: m.admin_settings_notification_mail_dkim_off()}
							</dd>
						</div>
					</dl>
					<form
						method="POST"
						action="?/testMail"
						class="space-y-2 border-t p-4"
						use:enhance={() => {
							mailPending = true;
							mailNotice = null;
							return async ({ result, update }) => {
								await update();
								mailPending = false;
								if (result.type === 'success') {
									const message = (result.data as { message?: unknown } | undefined)?.message;
									mailNotice = {
										kind: 'ok',
										text: typeof message === 'string' ? message : ''
									};
								} else if (result.type === 'failure') {
									mailNotice = {
										kind: 'error',
										text: failureMessage(result.data) ?? ''
									};
								}
							};
						}}
					>
						<p class="text-xs text-muted-foreground">
							{m.admin_settings_notification_test_mail_desc()}
						</p>
						<div class="flex flex-wrap items-center gap-2">
							<Button
								type="submit"
								variant="outline"
								size="sm"
								disabled={!data.mail.configured || !data.mailEditable || mailPending}
							>
								{m.admin_settings_notification_send_test()}
							</Button>
							{#if mailNotice?.kind === 'ok' && mailNotice.text}
								<p role="status" class="text-xs text-muted-foreground">{mailNotice.text}</p>
							{:else if mailNotice?.kind === 'error' && mailNotice.text}
								<p role="alert" class="text-xs text-destructive">{mailNotice.text}</p>
							{/if}
						</div>
					</form>
				</div>
			</section>

			<!-- Webhooks (J-3: read-only endpoint list + delivery log + re-queue) -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">{m.admin_settings_notification_webhooks()}</h3>
				{#if !data.editable}
					<p class="-mt-3 mb-3 text-xs text-muted-foreground">
						{m.admin_settings_common_owner_only()}
					</p>
				{/if}
				<div class="space-y-4 rounded-lg border p-4">
					<SettingsProviderStatus
						name={m.admin_settings_notification_webhooks()}
						state={data.webhookEndpoints.length > 0 ? 'configured' : 'not_configured'}
						detail={data.webhookEndpoints.length === 0
							? m.admin_settings_notification_no_endpoints()
							: undefined}
					/>
					<!-- Persistent status region: a live region must exist before its
					     content arrives. The one-time reveal lives in dedicated state so
					     unrelated submissions cannot wipe it. -->
					<!-- The status region stays text-only: the interactive reveal
					     moved out of it (nine-dimension NOTIF-SY-05: aria-atomic
					     re-announced the credential and the button on every copy
					     state change). -->
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
					</div>
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
								<p role="status" class="text-xs text-muted-foreground">
									{m.admin_settings_notification_copy_secret_done()}
								</p>
							{:else if copyState === 'failed'}
								<p role="alert" class="text-xs text-destructive">
									{m.admin_settings_notification_copy_secret_failed()}
								</p>
							{/if}
						</div>
					{/if}

					<div class="space-y-2">
						<div class="flex items-center justify-between gap-2">
							<h4 class="text-xs font-medium text-muted-foreground">
								{m.admin_settings_notification_endpoints()}
							</h4>
							{#if data.editable}<Button
									type="button"
									variant="outline"
									size="sm"
									onclick={() => openEndpointDialog(null)}
								>
									<IconPlus class="size-3.5" />
									{m.admin_settings_notification_add_endpoint()}
								</Button>{/if}
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
											<code>{endpoint.secretPreview ?? '—'}</code></span
										>
										<span class="ml-auto flex items-center gap-1">
											{#if data.editable}<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={`${m.admin_common_edit()} (${endpoint.name})`}
													onclick={() => openEndpointDialog(endpoint)}
												>
													<IconPencil />
												</Button>{/if}
											{#if data.editable}<form
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
															endpoint.isEnabled
																? m.admin_common_disable()
																: m.admin_common_enable()
														} (${endpoint.name})`}
													>
														{endpoint.isEnabled
															? m.admin_common_disable()
															: m.admin_common_enable()}
													</Button>
												</form>{/if}
											{#if data.editable}<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={`${m.admin_settings_notification_rotate_secret()} (${endpoint.name})`}
													onclick={() => openRotateDialog(endpoint)}
												>
													<IconKey />
												</Button>{/if}
											{#if data.editable}<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={`${m.admin_common_delete()} (${endpoint.name})`}
													onclick={() => openDeleteDialog(endpoint)}
												>
													<IconTrash />
												</Button>{/if}
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					<div class="space-y-2">
						<h4 class="text-xs font-medium text-muted-foreground">
							{m.admin_settings_notification_recent_deliveries()}
						</h4>
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
										{#if delivery.status === 'queued' && delivery.attemptCount > 0}
											<span class="text-muted-foreground">
												{m.admin_settings_notification_retry_scheduled({
													attempt: delivery.attemptCount + 1,
													time: delivery.nextAttemptLabel ?? '—'
												})}
											</span>
										{:else if delivery.status === 'failed'}
											<span class="text-muted-foreground">
												{m.admin_settings_notification_attempt_count({
													count: delivery.attemptCount
												})}
											</span>
										{/if}
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

			<!-- Human channels. Preferences are owner-only; Bark credentials stay
			     env-only in this release. -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">
					{m.admin_settings_notification_prefs_title()}
				</h3>
				{#if !data.notificationPreferencesEditable}
					<p class="-mt-3 mb-3 text-xs text-muted-foreground">
						{m.admin_settings_common_owner_only()}
					</p>
				{/if}
				<form
					method="POST"
					action="?/saveNotificationPreferences"
					class="space-y-4 rounded-lg border p-4"
					use:enhance={() => {
						prefsPending = true;
						prefsNotice = null;
						return async ({ result, update }) => {
							await update();
							prefsPending = false;
							if (result.type === 'success') {
								const message = (result.data as { message?: unknown } | undefined)?.message;
								prefsNotice = {
									kind: 'ok',
									text: typeof message === 'string' ? message : ''
								};
							} else if (result.type === 'failure') {
								prefsNotice = {
									kind: 'error',
									text: failureMessage(result.data) ?? ''
								};
							}
						};
					}}
				>
					<p class="text-xs text-muted-foreground">
						{m.admin_settings_notification_prefs_desc()}
					</p>
					<div class="space-y-3">
						{#each preferenceGroups as group (group.key)}
							<div class="flex flex-wrap items-center gap-x-6 gap-y-2">
								<span class="w-32 shrink-0 text-xs font-medium">{group.label}</span>
								<label class="flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										name="{group.key}_email"
										checked={data.notificationPreferences[group.key].email}
										disabled={!data.notificationPreferencesEditable}
										class="size-4 accent-foreground"
									/>
									{m.admin_settings_notification_channel_email()}
								</label>
								<label class="flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										name="{group.key}_bark"
										checked={data.notificationPreferences[group.key].bark}
										disabled={!data.notificationPreferencesEditable}
										class="size-4 accent-foreground"
									/>
									{m.admin_settings_notification_channel_bark()}
								</label>
							</div>
						{/each}
					</div>
					<div class="flex flex-wrap items-center gap-2">
						{#if data.notificationPreferencesEditable}
							<Button type="submit" variant="outline" size="sm" disabled={prefsPending}>
								{m.admin_common_save()}
							</Button>
						{/if}
						{#if prefsNotice?.kind === 'ok' && prefsNotice.text}
							<p role="status" class="text-xs text-muted-foreground">{prefsNotice.text}</p>
						{:else if prefsNotice?.kind === 'error' && prefsNotice.text}
							<p role="alert" class="text-xs text-destructive">{prefsNotice.text}</p>
						{/if}
					</div>
				</form>
			</section>

			<section>
				<h3 class="mb-4 text-sm font-semibold">
					{m.admin_settings_notification_bark_title()}
				</h3>
				<div class="rounded-lg border">
					<SettingsProviderStatus
						name={m.admin_settings_notification_bark_title()}
						state={data.bark.configured ? 'configured' : 'not_configured'}
						detail={data.bark.configured
							? m.admin_settings_notification_bark_configured({ server: data.bark.serverUrl })
							: m.admin_settings_notification_bark_not_configured()}
					/>
					<p class="border-t p-4 text-xs text-muted-foreground">
						{m.admin_settings_notification_bark_env_hint()}
					</p>
				</div>
			</section>

			<!-- Delivery log: every outbox attempt, owner-only, resend re-queues
			     the SAME row (no copy). -->
			<section>
				<h3 class="mb-4 text-sm font-semibold">
					{m.admin_settings_notification_alerts_title()}
				</h3>
				{#if !data.notificationLogEditable}
					<p class="-mt-3 mb-3 text-xs text-muted-foreground">
						{m.admin_settings_common_owner_only()}
					</p>
				{/if}
				<div class="space-y-2 rounded-lg border p-4">
					<p class="text-xs text-muted-foreground">
						{m.admin_settings_notification_alerts_desc()}
					</p>
					{#if data.notifications.length === 0}
						<p class="text-xs text-muted-foreground">
							{m.admin_settings_notification_alerts_empty()}
						</p>
					{:else}
						<div class="overflow-hidden rounded-md border">
							{#each data.notifications as row (row.id)}
								<div
									class="flex flex-wrap items-center gap-2 border-b px-2 py-1.5 text-xs last:border-b-0"
									data-slot="notification-row"
								>
									<span class="w-40 shrink-0 text-muted-foreground">{row.createdLabel}</span>
									<span class="font-mono">{row.eventType}</span>
									<Badge variant="outline" class="w-fit">
										{row.channel === 'email'
											? m.admin_settings_notification_channel_email()
											: m.admin_settings_notification_channel_bark()}
									</Badge>
									<span class="min-w-0 flex-1 truncate text-muted-foreground">
										{row.title}
										{#if row.error}· {row.error}{/if}
									</span>
									<span class="text-muted-foreground">
										{m.admin_settings_notification_attempt_count({ count: row.attempts })}
									</span>
									<Badge
										variant={row.status === 'failed'
											? 'destructive'
											: row.status === 'sent'
												? 'default'
												: 'outline'}
										class="w-fit"
									>
										{row.status === 'failed'
											? m.admin_settings_notification_status_failed()
											: row.status === 'sent'
												? m.admin_settings_notification_status_sent()
												: m.admin_settings_notification_status_queued()}
									</Badge>
									{#if data.notificationLogEditable && (row.status === 'failed' || row.status === 'sent')}
										<form
											method="POST"
											action="?/resendNotification"
											use:enhance={() => {
												resendPendingId = row.id;
												logNotice = null;
												return async ({ result, update }) => {
													await update();
													if (resendPendingId === row.id) resendPendingId = null;
													if (result.type === 'success') {
														logNotice = {
															kind: 'ok',
															text: m.admin_settings_notification_resend_ok()
														};
													} else if (result.type === 'failure') {
														logNotice = {
															kind: 'error',
															text: failureMessage(result.data) ?? ''
														};
													}
												};
											}}
										>
											<input type="hidden" name="id" value={row.id} />
											<Button
												type="submit"
												variant="outline"
												size="sm"
												disabled={resendPendingId === row.id}
												>{m.admin_settings_notification_resend()}</Button
											>
										</form>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if logNotice?.kind === 'ok' && logNotice.text}
						<p role="status" class="text-xs text-muted-foreground">{logNotice.text}</p>
					{:else if logNotice?.kind === 'error' && logNotice.text}
						<p role="alert" class="text-xs text-destructive">{logNotice.text}</p>
					{/if}
				</div>
			</section>
		</div>
	</div>
</div>

<!-- Endpoint editor (create when no id; edit prefills) - SY S2 -->
<Dialog.Root open={endpointDialogOpen} onOpenChange={(open) => !open && closeEndpointDialog()}>
	<Dialog.Content class="sm:max-w-md" interactOutsideBehavior="ignore">
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
					// The reveal lives in the page region, not the dialog: capture the
					// one-time secret even when the submitted dialog has moved on (a
					// stale-epoch success would otherwise lose the only plaintext copy).
					if (result.type === 'success') captureSecret(result.data);
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
				<Input
					id="hook-name"
					name="name"
					bind:value={formName}
					required
					maxlength={120}
					aria-invalid={editorError ? true : undefined}
					aria-describedby={editorError ? 'endpoint-editor-error' : undefined}
				/>
			</div>
			<div class="space-y-1.5">
				<label for="hook-url" class="text-sm">{m.admin_settings_notification_endpoint_url()}</label>
				<Input
					id="hook-url"
					name="payloadUrl"
					type="url"
					bind:value={formPayloadUrl}
					required
					maxlength={2048}
					placeholder="https://example.com/hooks/lair"
					aria-invalid={editorError ? true : undefined}
					aria-describedby={editorError ? 'endpoint-editor-error' : undefined}
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
				<p id="endpoint-editor-error" role="alert" class="text-sm text-destructive">
					{editorError}
				</p>
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
				<AlertDialog.Action type="submit" variant="destructive" disabled={deletePending}
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
						// F1/SY3-1).
						if (result.type === 'success') captureSecret(result.data);
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
