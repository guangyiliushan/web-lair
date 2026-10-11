/**
 * Shared form-ingress helpers for the maintenance pages (J-3): the editor
 * forms submit multipart bodies, which normalize line endings to CRLF (HTML
 * spec; undici proves it in tests) while user files stay LF - fold back at
 * the ingress. `baseHash` rides as '' for "no user file yet" (null).
 */

import { m } from '$lib/paraglide/messages';

export function parseBaseHash(raw: FormDataEntryValue | null): string | null {
	const value = (raw ?? '').toString().trim();
	return value === '' ? null : value;
}

export function parseCode(form: FormData): string {
	const raw = (form.get('code') ?? '').toString();
	return raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

/** Ledger status whitelist - shared by the server load and the page (J-3
 * review P3-21: the two copies had already drifted risk). */
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped'] as const;

/** Shared run/typecheck status labels (lazy: resolved per call, never frozen). */
export const RUN_LABELS: Record<string, () => string> = {
	queued: () => m.admin_maintenance_status_queued(),
	running: () => m.admin_maintenance_status_running(),
	succeeded: () => m.admin_maintenance_status_succeeded(),
	failed: () => m.admin_maintenance_status_failed(),
	skipped: () => m.admin_maintenance_status_skipped()
};

/** Typecheck badge variant: a failed RUN is not a failed CHECK, and a
 * queued check must not render as a red failure (J-3 review P2-1). */
export function typecheckVariant(check: {
	status: string;
	summary: { ok?: boolean } | null;
}): 'default' | 'secondary' | 'destructive' | 'outline' {
	if (check.status === 'queued') return 'outline';
	if (check.status === 'running') return 'secondary';
	if (check.status === 'failed') return 'destructive';
	if (check.summary?.ok) return 'default';
	return 'destructive';
}

export function typecheckLabel(check: {
	status: string;
	summary: { ok?: boolean } | null;
}): string {
	if (check.status === 'failed') return m.admin_maintenance_status_failed();
	if (check.summary?.ok) return m.admin_maintenance_check_passed();
	if (check.status === 'succeeded') return m.admin_maintenance_check_not_passed();
	return RUN_LABELS[check.status]?.() ?? check.status;
}

/** Payload keys of the maintenance actions' fail() results. */
export interface MaintenanceFlashForm {
	error?: string;
	queued?: boolean;
	name?: string;
	deduplicated?: boolean;
	scheduleChanged?: boolean;
	scheduleAction?: string;
	enabled?: boolean;
	watermarkReset?: boolean;
}

/** Flash copy for the maintenance list page. Pure, so the wording and the
 * action dispatch are pinned by tests (J-3 review F11/R4-1: `form.status`
 * never exists - the payload keys are the only signal). */
export function maintenanceFlash(
	form: MaintenanceFlashForm | null | undefined
): { kind: 'ok' | 'error'; text: string } | null {
	if (!form) return null;
	if (typeof form.error === 'string') return { kind: 'error', text: form.error };
	if (form.queued) {
		return {
			kind: 'ok',
			text: `${m.admin_maintenance_queued({ name: String(form.name) })}${form.deduplicated ? m.admin_maintenance_queued_dedup() : ''}${m.admin_maintenance_queued_suffix()}`
		};
	}
	if (form.scheduleChanged) {
		const action = form.scheduleAction;
		const text =
			action === 'create'
				? m.admin_maintenance_flash_added()
				: action === 'delete'
					? m.admin_maintenance_flash_deleted()
					: action === 'toggle'
						? form.enabled
							? m.admin_maintenance_flash_enabled()
							: m.admin_maintenance_flash_disabled()
						: form.watermarkReset
							? m.admin_maintenance_flash_updated_reset()
							: m.admin_maintenance_flash_updated();
		return { kind: 'ok', text };
	}
	return null;
}

/** Query suffix so schedule/run actions keep the active ledger filters
 * (a bare `?/action` POST would otherwise reset them, review P3-20). */
export function buildFilterQuery(filters: { job: string; status: string }): string {
	const parts: string[] = [];
	if (filters.job) parts.push(`job=${encodeURIComponent(filters.job)}`);
	if (filters.status) parts.push(`status=${encodeURIComponent(filters.status)}`);
	return parts.length > 0 ? `&${parts.join('&')}` : '';
}
