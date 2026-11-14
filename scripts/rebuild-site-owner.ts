/**
 * owner:rebuild - repair the `site_identity` pointer and retire `site.owner`.
 *
 * M4 foundation (O-C2/OP-7): `user_profiles` is the single source for the
 * public owner persona and `site_identity` is the one-row pointer the header
 * joins through. This repair is idempotent and safe to run on every deploy:
 *
 *   - no user with role='owner'  -> leave the pointer unset, warn, and the
 *     header falls back to SITE_OWNER_DEFAULT (exit 0; one "warn" line)
 *   - pointer matches the owner  -> nothing to do
 *   - pointer missing/stale      -> point it at the owner (apply only)
 *   - `site.owner` option row    -> deleted (retired; no consumer reads it)
 *
 * Dry-run is the default. Pass `--apply` to write (one transaction).
 *
 * Usage:
 *   pnpm owner:rebuild            # dry-run
 *   pnpm owner:rebuild -- --apply # write
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('[owner:rebuild] DATABASE_URL is not set');
	process.exit(2);
}

const apply = process.argv.includes('--apply');
const sql = postgres(url, { max: 1 });

try {
	const [table] = await sql`select to_regclass('public.site_identity') as rel`;
	if (!table?.rel) {
		console.error(
			'[owner:rebuild] site_identity is missing. Run `pnpm db:migrate` first (append 0003_m4_foundation).'
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

		console.log(`[owner:rebuild] mode=${apply ? 'APPLY' : 'dry-run'}`);
		console.log(`[owner:rebuild] owner rows=${owners.length}${owner ? ` (${owner.id})` : ''}`);
		console.log(`[owner:rebuild] pointer=${pointerId ?? 'none'}`);
		console.log(`[owner:rebuild] site.owner option rows=${optionRow?.count ?? 0}`);

		if (owners.length > 1) {
			console.warn(
				`[owner:rebuild] warn: ${owners.length} users have role='owner'; using the oldest (${owner?.id})`
			);
		}

		const actions: string[] = [];
		if (!owner) {
			console.warn(
				'[owner:rebuild] warn: 0 owner rows; site_identity stays unset and the header falls back to SITE_OWNER_DEFAULT'
			);
			if (pointerId) actions.push('delete the stale site_identity row');
		} else if (pointerId !== owner.id) {
			actions.push(`${pointerId ? 'update' : 'insert'} site_identity -> ${owner.id}`);
		}
		if ((optionRow?.count ?? 0) > 0) actions.push('delete options.site.owner rows');

		if (actions.length === 0) {
			console.log('[owner:rebuild] nothing to do');
		} else {
			console.log(`[owner:rebuild] plan: ${actions.join('; ')}`);
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
				console.log('[owner:rebuild] applied');
			} else {
				console.log('[owner:rebuild] dry-run; pass --apply to write');
			}
		}
	}
} catch (error) {
	console.error('[owner:rebuild] failed:', error);
	process.exitCode = 1;
} finally {
	await sql.end();
}
