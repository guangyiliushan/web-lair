import { m } from '$lib/paraglide/messages';
import { readinessMessageKeys, type AiReadinessStatus } from './ai-meta';

/**
 * Renders the readiness copy that `ai-meta.ts` names.
 *
 * It lives beside `ai-meta.ts` rather than inside it because `ai-meta.ts` is
 * reachable from the plain-Node job drain (via `ai/providers.ts`) and must not
 * import `$lib`; the job drain loads that graph with no bundler. Only the
 * surfaces - console, settings, editors - ever render copy, so only they need
 * this module.
 */

/**
 * Paraglide's `m` only exposes statically known keys, while the readiness map
 * is keyed by status. This is the one place that bridges them, so every surface
 * resolves the same strings instead of hand-writing its own status switch.
 */
export function messageByKey(key: string, params: Record<string, string | number> = {}): string {
	const fn = (m as unknown as Record<string, (p?: Record<string, unknown>) => string>)[key];
	return typeof fn === 'function' ? fn(params) : key;
}

/**
 * Verdict + reason for one status, already localized. `missing_env` names the
 * variable it is complaining about, so callers pass it - `AI_OPENAI_KEY 未设置`
 * is the shape the editors and the tests assert on.
 */
export function readinessCopy(
	status: AiReadinessStatus,
	params: Record<string, string | number> = {}
): { label: string; hint: string } {
	const keys = readinessMessageKeys(status);
	return {
		label: messageByKey(keys.label, params),
		hint: messageByKey(keys.hint, params)
	};
}

/**
 * The minimum shape a surface needs to explain a disabled control. Structural
 * rather than importing the server's `AiReadiness`, so this module stays free
 * of `src/lib/server/**`.
 */
export interface ReadinessView {
	status: AiReadinessStatus;
	envName?: string | null;
	fix?: { href: string; labelKey: string } | null;
}

/**
 * What a control says about itself.
 *
 * The rule the post editor got backwards: when the action is available the
 * title describes the **consequence** ("this overwrites the target language"),
 * and when it is not, the title gives the **reason** it cannot run. Both
 * strings were already correct - they were just attached to the wrong branch,
 * so a disabled button explained what it would have done and an enabled one
 * merely restated its own name.
 */
export function readinessTitle(view: ReadinessView, readyHint: string): string {
	if (view.status === 'ready') return readyHint;
	const copy = readinessCopy(view.status, { name: view.envName ?? '' });
	return view.fix ? `${copy.hint} · ${messageByKey(view.fix.labelKey)}` : copy.hint;
}
