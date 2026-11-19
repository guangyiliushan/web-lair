/**
 * site rebuild-owner - repair the `site_identity` pointer and retire `site.owner`.
 *
 * Foundation: `user_profiles` is the single source for the public owner
 * persona and `site_identity` is the one-row pointer the header joins
 * through. Dry-run by default; `--apply` writes in one transaction.
 * Idempotent and safe to run on every deploy:
 *   - no user with role='owner' -> warn; header falls back to
 *     SITE_OWNER_DEFAULT, and a stale pointer row is deleted (--apply)
 *   - pointer matches the owner -> nothing to do
 *   - pointer missing/stale     -> point it at the owner (apply only)
 *   - `site.owner` option row   -> deleted (retired; no consumer reads it)
 * Usage: `pnpm ops site rebuild-owner` (dry-run); `pnpm ops site rebuild-owner --apply` writes.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('[site rebuild-owner] DATABASE_URL is not set');
	process.exit(2);
}

const apply = process.argv.includes('--apply');
const sql = postgres(url, { max: 1 });

try {
	const [table] = await sql`select to_regclass('public.site_identity') as rel`;
	if (!table?.rel) {
		console.error(
			'[site rebuild-owner] site_identity is missing. Run `pnpm db:migrate` first (append 0003_m4_foundation).'
		);
		process.exitCode = 1;
	} else {
		const owners =
			await sql`select id, email, name from "user" where role = 'owner' order by created_at asc, id asc`;
		const pointerRows = await sql`select owner_user_id from site_identity where id = 1`;
		const [optionRow] =
			await sql`select count(*)::int as count from options where name = 'site.owner'`;
		const pointerId: string | null = pointerRows[0]?.owner_user_id ?? null;
		const owner = owners[0] ?? null;

		console.log(`[site rebuild-owner] mode=${apply ? 'APPLY' : 'dry-run'}`);
		console.log(`[site rebuild-owner] owner rows=${owners.length}${owner ? ` (${owner.id})` : ''}`);
		console.log(`[site rebuild-owner] pointer=${pointerId ?? 'none'}`);
		console.log(`[site rebuild-owner] site.owner option rows=${optionRow?.count ?? 0}`);

		if (owners.length > 1) {
			console.warn(
				`[site rebuild-owner] warn: ${owners.length} users have role='owner'; using the oldest (${owner?.id})`
			);
		}

		const actions: string[] = [];
		if (!owner) {
			console.warn(
				'[site rebuild-owner] warn: 0 owner rows; site_identity stays unset and the header falls back to SITE_OWNER_DEFAULT'
			);
			if (pointerId) actions.push('delete the stale site_identity row');
		} else if (pointerId !== owner.id) {
			actions.push(`${pointerId ? 'update' : 'insert'} site_identity -> ${owner.id}`);
		}
		if ((optionRow?.count ?? 0) > 0) actions.push('delete options.site.owner rows');

		if (actions.length === 0) {
			console.log('[site rebuild-owner] nothing to do');
		} else {
			console.log(`[site rebuild-owner] plan: ${actions.join('; ')}`);
			if (apply) {
				await sql.begin(async (tx) => {
					if (!owner) {
						await tx`delete from site_identity where id = 1`;
					} else {
						await tx`
							insert into site_identity (id, owner_user_id, updated_at, updated_by)
							values (1, ${owner.id}, now(), ${owner.id})
							on conflict (id) do update
								set owner_user_id = excluded.owner_user_id,
									updated_at = now(),
									updated_by = excluded.updated_by
						`;
					}
					await tx`delete from options where name = 'site.owner'`;
				});
				console.log('[site rebuild-owner] applied');
			} else {
				console.log('[site rebuild-owner] dry-run; pass --apply to write');
			}
		}
	}
} catch (error) {
	console.error('[site rebuild-owner] failed:', error);
	process.exitCode = 1;
} finally {
	await sql.end();
}
