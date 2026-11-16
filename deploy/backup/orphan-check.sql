-- F-22 orphan review for a restored database (M6 P2, T2.5).
--
-- Why: the manual restore path (RUNBOOK §2.1) applies a dump with
-- `SET session_replication_role = replica`, which disables FK triggers, so a
-- restore that exits 0 does not prove referential integrity. This script asks
-- PostgreSQL for every foreign key that exists in the restored database and
-- emits one count query per key; `\gexec` then runs them.
--
-- Output (psql -tA): <constraint name>|<orphan rows>. Every non-zero count is
-- an orphan group; the drill fails when the total is not 0.
--
-- Nothing here is table-specific, so a new FK is covered the day it merges.
-- Three details that matter:
--   * the NOT NULL guard implements MATCH SIMPLE: a composite FK with any NULL
--     column is not enforced, and counting those rows would report orphans the
--     database itself accepts;
--   * only `convalidated` constraints are checked. A NOT VALID constraint (the
--     usual two-step migration: add without checking, backfill later) may have
--     historical violators by design, so failing on them would be a false alarm;
--   * tables are schema-qualified (`%I.%I`). `regclass` renders a bare name for
--     anything on the search_path, and the generated query is re-parsed by the
--     drill's psql session — a same-named table in another schema would be
--     silently scanned instead.
select format(
	'select %L as fk, count(*) as orphans from %I.%I t where (%s) and not exists (select 1 from %I.%I p where %s)',
	c.conname,
	cn.nspname, ct.relname,
	(
		select string_agg(format('t.%I is not null', a.attname), ' and ')
		from generate_subscripts(c.conkey, 1) as s(i)
		join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[s.i]
	),
	pn.nspname, pt.relname,
	(
		select string_agg(format('p.%I = t.%I', pa.attname, ca.attname), ' and ')
		from generate_subscripts(c.conkey, 1) as s(i)
		join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[s.i]
		join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[s.i]
	)
)
from pg_constraint c
join pg_class ct on ct.oid = c.conrelid
join pg_namespace cn on cn.oid = ct.relnamespace
join pg_class pt on pt.oid = c.confrelid
join pg_namespace pn on pn.oid = pt.relnamespace
where c.contype = 'f'
	and c.conparentid = 0
	and c.convalidated
order by 1
\gexec
