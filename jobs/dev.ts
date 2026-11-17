// jobs/dev.ts
//
// Development worker: the same drain tick as `jobs/drain.ts`, on a loop,
// started by hand next to `vite dev`. Why it exists and the commands
// (`pnpm jobs:dev [--interval 1000]`): README "Background jobs in
// development".
//
// Environment:
//   DATABASE_URL  required - loaded from `.env` by the npm script.
//   DATA_DIR      optional - jobs data dir (default <repo>/data).
//
// Exit: SIGINT/SIGTERM stop the loop and close the pool. A failing tick is
// logged and retried; the loop never exits on its own.

import { startDevDrain } from '../src/lib/server/jobs/dev-drain.ts';

const args = process.argv.slice(2);
function intervalArg(): number | undefined {
	const index = args.findIndex((arg) => arg === '--interval' || arg === '-i');
	if (index === -1) return undefined;
	const raw = Number(args[index + 1]);
	if (!Number.isFinite(raw) || raw < 500) {
		console.error('[dev-drain] --interval must be a number of milliseconds >= 500');
		process.exit(2);
	}
	return raw;
}

const drain = startDevDrain({
	databaseUrl: process.env.DATABASE_URL,
	intervalMs: intervalArg()
});
if (!drain) process.exit(2);

console.log('[dev-drain] watching the queue - Ctrl+C to stop');

let stopping = false;
const shutdown = async (signal: string) => {
	if (stopping) return;
	stopping = true;
	console.log(`\n[dev-drain] ${signal} - stopping`);
	await drain.stop();
	process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
