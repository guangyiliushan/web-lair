#!/usr/bin/env bash
# Counts the rows of the `public."user"` COPY block in a `pg_restore -a -f -`
# text dump on stdin. It lives in a file because the same count guards the
# nightly backup and the rebuild/rollback procedures in `deploy/RUNBOOK.md`
# "Rollback" — one implementation, one place to be right.
# It never exits at the terminator: closing the pipe would SIGPIPE the
# producer, and under `set -o pipefail` (backup.sh runs with it) the assignment
# aborts with 141 as soon as the dump holds more than a pipe buffer past the
# `user` block — the block end only flips `f` off, so awk keeps draining stdin.
# The terminator is a line of exactly `\.` (backslash, dot); COPY text escapes a
# leading backslash, so a data value that would look like it is written `\\.`
# and can never match.
set -euo pipefail

awk '
	/^COPY public\."user" / { f = 1; next }
	f && /^\\\.$/          { f = 0; next }
	f                      { n++ }
	END                    { print n + 0 }
'
