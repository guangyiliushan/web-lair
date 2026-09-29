import { purgeMedia } from '../src/lib/server/services/files';

/**
 * Media purge (storage line §4.6): DRY-RUN by default — pass `--yes` to
 * actually delete. TTLs come from the `media.purge` option (pending 7d /
 * detached 30d). Candidates are re-checked for references at delete time.
 */
const execute = process.argv.includes('--yes');

const outcome = await purgeMedia({ dryRun: !execute });

console.log(`purge ${execute ? 'EXECUTE' : 'dry-run'} — candidates: ${outcome.candidates.length}`);
for (const candidate of outcome.candidates) {
	console.log(
		`    - ${candidate.objectKey}  (${candidate.fileName}, ${candidate.status}, ${candidate.ageDays}d)`
	);
}
if (execute) {
	console.log(`deleted: ${outcome.deleted.length}`);
} else {
	console.log('no changes (dry-run). Re-run with --yes to delete the candidates above.');
}
