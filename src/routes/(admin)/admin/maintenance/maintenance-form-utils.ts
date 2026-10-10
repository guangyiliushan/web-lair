/**
 * Shared form-ingress helpers for the maintenance pages (J-3): the editor
 * forms submit multipart bodies, which normalize line endings to CRLF (HTML
 * spec; undici proves it in tests) while user files stay LF - fold back at
 * the ingress. `baseHash` rides as '' for "no user file yet" (null).
 */

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

/** Chinese labels for run/typecheck statuses (admin copy is hardcoded). */
export const RUN_LABELS: Record<string, string> = {
	queued: '排队中',
	running: '运行中',
	succeeded: '成功',
	failed: '失败',
	skipped: '跳过'
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
	if (check.status === 'failed') return '失败';
	if (check.summary?.ok) return '通过';
	if (check.status === 'succeeded') return '未通过';
	return RUN_LABELS[check.status] ?? check.status;
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
			text: `已排队：${String(form.name)}${form.deduplicated ? '（已有同任务在队列，未重复入队）' : ''}——≤1 分钟内执行`
		};
	}
	if (form.scheduleChanged) {
		const action = form.scheduleAction;
		const text =
			action === 'create'
				? '已添加调度'
				: action === 'delete'
					? '调度已删除'
					: action === 'toggle'
						? form.enabled
							? '调度已启用（水位已重置为当前时间）'
							: '调度已停用'
						: form.watermarkReset
							? '调度已更新（水位已重置为当前时间）'
							: '调度已更新';
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
