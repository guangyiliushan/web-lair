export { default as ChartPanel } from './chart-panel.svelte';
export { default as MaintenanceCard } from './maintenance-card.svelte';
export { default as LoginStat } from './login-stat.svelte';
export { default as AdminHeader } from './admin-header.svelte';
export { default as DeleteConfirm } from './delete-confirm.svelte';
export { MediaUploadDialog } from './media-upload';
export {
	createAdminHeaderActionRegistry,
	useAdminHeaderActionRegistry,
	type AdminHeaderActionRegistry
} from './admin-header-actions';

export * as ListDetail from './list-detail';
export * as ListTable from './list-table';
// Legacy shell: topics / readers / ai / settings still use it. Remove once
// they migrate to `list-detail` (see docs/specs/2026-10-22-admin-list-detail-design.md).
export * as MasterDetail from './master-detail';
