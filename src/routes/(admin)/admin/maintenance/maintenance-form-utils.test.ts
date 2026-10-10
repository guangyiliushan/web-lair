import { describe, expect, it } from 'vitest';
import {
	buildFilterQuery,
	maintenanceFlash,
	RUN_LABELS,
	RUN_STATUSES,
	typecheckLabel,
	typecheckVariant
} from './maintenance-form-utils';

/**
 * Pure-function pins for the maintenance list page (J-3 reviews): the flash
 * wording/action dispatch (F11), the payload-key failure signal (R4-1), the
 * ledger filter suffix (P3-20 / mutation M8) and the typecheck badge mapping
 * (P2-1: a queued check must not render as a red failure).
 */

describe('buildFilterQuery', () => {
	it('is empty without filters', () => {
		expect(buildFilterQuery({ job: '', status: '' })).toBe('');
	});

	it('keeps job before status and encodes values', () => {
		expect(buildFilterQuery({ job: 'my job', status: 'failed' })).toBe(
			'&job=my%20job&status=failed'
		);
	});

	it('keeps single-sided filters', () => {
		expect(buildFilterQuery({ job: 'links.check', status: '' })).toBe('&job=links.check');
		expect(buildFilterQuery({ job: '', status: 'queued' })).toBe('&status=queued');
	});
});

describe('maintenanceFlash', () => {
	it('is null without a form result', () => {
		expect(maintenanceFlash(null)).toBeNull();
		expect(maintenanceFlash(undefined)).toBeNull();
		expect(maintenanceFlash({})).toBeNull();
	});

	it('renders an error from the payload key, not a status field (R4-1)', () => {
		expect(maintenanceFlash({ error: '该任务已有一条相同 cron 的调度' })).toEqual({
			kind: 'error',
			text: '该任务已有一条相同 cron 的调度'
		});
	});

	it('renders the queued notice with and without dedup', () => {
		expect(maintenanceFlash({ queued: true, name: 'links.check' })).toEqual({
			kind: 'ok',
			text: '已排队：links.check——≤1 分钟内执行'
		});
		expect(maintenanceFlash({ queued: true, name: 'links.check', deduplicated: true })).toEqual({
			kind: 'ok',
			text: '已排队：links.check（已有同任务在队列，未重复入队）——≤1 分钟内执行'
		});
	});

	it('renders every schedule verb; the watermark suffix appears only when reset', () => {
		expect(maintenanceFlash({ scheduleChanged: true, scheduleAction: 'create' })).toEqual({
			kind: 'ok',
			text: '已添加调度'
		});
		expect(maintenanceFlash({ scheduleChanged: true, scheduleAction: 'delete' })).toEqual({
			kind: 'ok',
			text: '调度已删除'
		});
		expect(
			maintenanceFlash({ scheduleChanged: true, scheduleAction: 'toggle', enabled: true })
		).toEqual({ kind: 'ok', text: '调度已启用（水位已重置为当前时间）' });
		expect(
			maintenanceFlash({ scheduleChanged: true, scheduleAction: 'toggle', enabled: false })
		).toEqual({ kind: 'ok', text: '调度已停用' });
		expect(
			maintenanceFlash({ scheduleChanged: true, scheduleAction: 'update', watermarkReset: true })
		).toEqual({ kind: 'ok', text: '调度已更新（水位已重置为当前时间）' });
		expect(
			maintenanceFlash({ scheduleChanged: true, scheduleAction: 'update', watermarkReset: false })
		).toEqual({ kind: 'ok', text: '调度已更新' });
	});
});

describe('typecheck badge mapping (review P2-1)', () => {
	it('queued/running are not failures', () => {
		expect(typecheckVariant({ status: 'queued', summary: null })).toBe('outline');
		expect(typecheckLabel({ status: 'queued', summary: null })).toBe('排队中');
		expect(typecheckVariant({ status: 'running', summary: null })).toBe('secondary');
		expect(typecheckLabel({ status: 'running', summary: null })).toBe('运行中');
	});

	it('a failed RUN reads 失败; a completed check reads 通过/未通过', () => {
		expect(typecheckVariant({ status: 'failed', summary: null })).toBe('destructive');
		expect(typecheckLabel({ status: 'failed', summary: null })).toBe('失败');
		expect(typecheckVariant({ status: 'succeeded', summary: { ok: true } })).toBe('default');
		expect(typecheckLabel({ status: 'succeeded', summary: { ok: true } })).toBe('通过');
		expect(typecheckVariant({ status: 'succeeded', summary: { ok: false } })).toBe('destructive');
		expect(typecheckLabel({ status: 'succeeded', summary: { ok: false } })).toBe('未通过');
	});

	it('exposes Chinese run labels for the ledger and the filter select', () => {
		expect(RUN_LABELS.queued).toBe('排队中');
		expect(RUN_LABELS.skipped).toBe('跳过');
		expect(RUN_STATUSES).toContain('failed');
	});
});
