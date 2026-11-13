#!/usr/bin/env bash
#
# Count the rows in the `public."user"` COPY block of a `pg_restore -a -f -`
# text dump read from stdin.
#
# Why a file: the same count guards the nightly backup (deploy/backup/backup.sh)
# and the operator rebuild/rollback procedures in deploy/RUNBOOK.md §3. One
# implementation means one place to be right.
#
# Why it never exits early: `awk ... {exit}` at the terminator closes the pipe,
# the producer dies of SIGPIPE, and under `set -o pipefail` (backup.sh runs with
# it) the whole assignment aborts — the nightly run would die at exit 141 once
# the dump has more than a pipe buffer after the `user` block. So the block end
# just flips `f` off and awk keeps draining stdin.
#
# The terminator is a line that is exactly `\.` (backslash, dot). A data row can
# never look like that: COPY text format escapes a leading backslash, so a data
# value beginning with a dot-backslash is written `\\.`.
set -euo pipefail

awk '
	/^COPY public\."user" / { f = 1; next }
	f && /^\\\.$/          { f = 0; next }
	f                      { n++ }
	END                    { print n + 0 }
'
