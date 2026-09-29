import { runMediaAudit } from '../src/lib/server/services/files';

/**
 * Read-only media audit (storage line §4.6 三检, T6): orphans / broken links /
 * missing objects. Idempotent — touches nothing. `--strict` exits non-zero
 * when findings exist (for later cron/monitoring wiring).
 */
const strict = process.argv.includes('--strict');

const report = await runMediaAudit();

console.log(`media audit @ ${report.generatedAt}`);
console.log(
	`  scanned: posts=${report.scannedSources.posts} drafts=${report.scannedSources.drafts} notes=${report.scannedSources.notes}`
);
console.log(`  ① 孤儿（无引用 ∧ 非图床 ∧ 超 TTL）: ${report.orphans.length}`);
for (const row of report.orphans) {
	console.log(`      - ${row.objectKey}  (${row.fileName}, ${row.status}, ${row.ageDays}d)`);
}
console.log(`  ② 破链（内容引用 /i/<key> 但无 files 行）: ${report.brokenLinks.length}`);
for (const link of report.brokenLinks) {
	console.log(`      - ${link.key}  ← ${link.refType}:${link.refId}`);
}
console.log(`  ③ 对象缺失（DB 有行、存储缺物）: ${report.missingObjects.length}`);
for (const row of report.missingObjects) {
	console.log(`      - ${row.objectKey}  (${row.fileName})`);
}

const findings = report.orphans.length + report.brokenLinks.length + report.missingObjects.length;
if (findings === 0) {
	console.log('clean.');
} else {
	console.log(`findings: ${findings}${strict ? '' : '（--strict 时以非零退出）'}`);
	if (strict) process.exit(1);
}
