import { parse as parseHtml } from 'parse5';
import { Agent, fetch as undiciFetch } from 'undici';
import {
	pinnedLookup,
	resolvePublicAddresses,
	type ResolvedAddress
} from '../security/ssrf-guard.ts';
import { fetchJson, ProjectsFetchError, type FetchJson } from './fetch.ts';
import { normalizeRepoUrl } from './normalize.ts';
import * as bitbucket from './adapters/bitbucket.ts';
import * as gitee from './adapters/gitee.ts';
import * as github from './adapters/github.ts';
import * as gitlab from './adapters/gitlab.ts';
import type { ProjectProvider } from '../../utils/project-meta.ts';
import type { RawRepoMeta, RepoIdentity, SyncFailureKind } from './types.ts';

/**
 * Single-URL import (plan §4.4): four platform URLs go through their adapter
 * (API response is the source of truth); any other https URL falls back to
 * an OpenGraph scrape. The OG path is the ONLY user-supplied outbound fetch
 * in this line, so it carries the full SSRF guard (resolution-time check +
 * connection-time pinning - security/ssrf-guard, links-line precedent);
 * adapter calls hit fixed TLS-validated hosts and skip the guard (embed-meta
 * rationale). Pure read: nothing is written here.
 */

export interface OgPrefill {
	title: string | null;
	description: string | null;
	icon: string | null;
}

export type ImportResult =
	| { ok: true; kind: 'repo'; identity: RepoIdentity; meta: RawRepoMeta }
	| { ok: true; kind: 'og'; url: string; og: OgPrefill }
	| { ok: false; reason: 'invalid-url' | 'blocked' | SyncFailureKind };

export interface ImportDeps {
	/** Adapter transport stub (tests). */
	fetchJson?: FetchJson;
	/** OG path transport stub (tests); defaults to undici's fetch. */
	fetch?: typeof undiciFetch;
	/** OG path resolver stub (tests); defaults to the SSRF guard's resolver. */
	resolveHost?: (host: string) => Promise<ResolvedAddress[] | null>;
}

const OG_TIMEOUT_MS = 10_000;
const OG_MAX_BYTES = 512 * 1024;
const OG_MAX_REDIRECTS = 5;

const ADAPTERS: Record<
	'github' | 'gitlab' | 'gitee' | 'bitbucket',
	{ fetchRepo(identity: RepoIdentity, deps: { fetchJson?: FetchJson }): Promise<RawRepoMeta> }
> = { github, gitlab, gitee, bitbucket };

/**
 * Resolve import metadata for an admin-entered URL: an adapter prefill for
 * the four platforms, an OG prefill for everything else. Failures are
 * classified with the same five kinds as the sync (plan §3.3) plus
 * `blocked` for SSRF refusals; callers surface "已存在（状态 X）" themselves
 * (that check needs the db - the A batch service owns it).
 */
export async function resolveImportMetadata(
	rawUrl: string,
	deps: ImportDeps = {}
): Promise<ImportResult> {
	const identity = normalizeRepoUrl(rawUrl);
	if (identity) {
		try {
			const meta = await ADAPTERS[identity.provider].fetchRepo(identity, {
				fetchJson: deps.fetchJson
			});
			return { ok: true, kind: 'repo', identity, meta };
		} catch (err) {
			if (err instanceof ProjectsFetchError) return { ok: false, reason: err.kind };
			throw err;
		}
	}

	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		return { ok: false, reason: 'invalid-url' };
	}
	if (parsed.protocol !== 'https:') return { ok: false, reason: 'invalid-url' };

	try {
		const page = await fetchPageHtml(parsed.href, deps);
		return { ok: true, kind: 'og', url: page.finalUrl, og: extractOpenGraph(page.html) };
	} catch (err) {
		if (err instanceof ProjectsFetchError) return { ok: false, reason: err.kind };
		if (err instanceof OgFetchError) return { ok: false, reason: err.reason };
		throw err;
	}
}

class OgFetchError extends Error {
	readonly reason: 'blocked' | 'invalid-url';

	constructor(reason: 'blocked' | 'invalid-url', message: string) {
		super(message);
		this.name = 'OgFetchError';
		this.reason = reason;
	}
}

/** Guarded single-page GET for the OG scrape (https, public hosts only). */
async function fetchPageHtml(
	rawUrl: string,
	deps: ImportDeps
): Promise<{ html: string; finalUrl: string }> {
	const doFetch = deps.fetch ?? undiciFetch;
	const resolveHost = deps.resolveHost ?? resolvePublicAddresses;
	const signal = AbortSignal.timeout(OG_TIMEOUT_MS);
	let target: URL;
	try {
		target = new URL(rawUrl);
	} catch {
		throw new OgFetchError('invalid-url', 'invalid url');
	}

	for (let redirects = 0; ;) {
		if (target.protocol !== 'https:') throw new OgFetchError('invalid-url', 'https only');
		const addresses = await resolveHost(target.hostname);
		if (!addresses || addresses.length === 0) {
			throw new OgFetchError('blocked', `host has no public address: ${target.hostname}`);
		}
		const agent = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
		let response: Awaited<ReturnType<typeof undiciFetch>>;
		try {
			response = await doFetch(target, {
				signal,
				redirect: 'manual',
				dispatcher: agent,
				headers: {
					'user-agent': 'web-lair-projects-import/0.0.1',
					accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
				}
			});
		} catch (err) {
			await agent.close().catch(() => {});
			throw new ProjectsFetchError('network', err instanceof Error ? err.message : String(err));
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			await response.body?.cancel().catch(() => {});
			await agent.close().catch(() => {});
			if (!location) throw new ProjectsFetchError('parse', 'redirect without location');
			redirects += 1;
			if (redirects > OG_MAX_REDIRECTS) {
				throw new ProjectsFetchError('network', 'too many redirects');
			}
			try {
				target = new URL(location, target);
			} catch {
				throw new ProjectsFetchError('parse', 'invalid redirect location');
			}
			continue;
		}
		if (response.status === 404 || response.status === 410) {
			await response.body?.cancel().catch(() => {});
			await agent.close().catch(() => {});
			throw new ProjectsFetchError('not_found', `HTTP ${response.status}`, response.status);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			await agent.close().catch(() => {});
			throw new ProjectsFetchError('network', `HTTP ${response.status}`, response.status);
		}
		const contentType = response.headers.get('content-type');
		if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
			await response.body?.cancel().catch(() => {});
			await agent.close().catch(() => {});
			throw new ProjectsFetchError('parse', `not an HTML page: ${contentType}`);
		}

		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (total + value.byteLength > OG_MAX_BYTES) {
					const keep = OG_MAX_BYTES - total;
					if (keep > 0) chunks.push(value.subarray(0, keep));
					await reader.cancel().catch(() => {});
					break;
				}
				chunks.push(value);
				total += value.byteLength;
			}
		}
		await agent.close().catch(() => {});
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { html: decodeHtml(bytes, contentType), finalUrl: target.href };
	}
}

/**
 * Decode with the declared charset when it is present (content-type header,
 * then a leading `<meta charset>`), UTF-8 otherwise - a garbled import
 * prefill is worse than a slow one, and GBK-era sites are still common among
 * "other" targets.
 */
function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
	let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
	if (!charset) {
		const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048));
		charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
	}
	try {
		return new TextDecoder(charset ?? 'utf-8').decode(bytes);
	} catch {
		return new TextDecoder('utf-8').decode(bytes);
	}
}

interface HtmlNode {
	nodeName: string;
	tagName?: string;
	attrs?: { name: string; value: string }[];
	childNodes?: HtmlNode[];
	value?: string;
}

/** OG extraction: `og:*` first, then `twitter:*`, then plain `<title>`. */
export function extractOpenGraph(html: string): OgPrefill {
	const document = parseHtml(html) as unknown as HtmlNode;
	const metas = new Map<string, string>();
	let title: string | null = null;
	const visit = (node: HtmlNode): void => {
		if (node.tagName === 'meta' && Array.isArray(node.attrs)) {
			const attr = (name: string): string | undefined =>
				node.attrs?.find((entry) => entry.name === name)?.value;
			const key = (attr('property') ?? attr('name') ?? '').toLowerCase();
			const content = attr('content');
			if (key && content !== undefined && content.length > 0 && !metas.has(key)) {
				metas.set(key, content);
			}
		} else if (node.tagName === 'title' && title === null) {
			const text = (node.childNodes ?? [])
				.map((child) => child.value ?? '')
				.join('')
				.replaceAll(/\s+/g, ' ')
				.trim();
			if (text.length > 0) title = text;
		}
		for (const child of node.childNodes ?? []) visit(child);
	};
	visit(document);
	const pick = (...keys: string[]): string | null => {
		for (const key of keys) {
			const value = metas.get(key);
			if (value) return value;
		}
		return null;
	};
	return {
		title: pick('og:title') ?? title,
		description: pick('og:description', 'description'),
		icon: pick('og:image', 'twitter:image')
	};
}

/** Provider label for the A batch's new-entry form default (site / other). */
export function providerForImport(result: ImportResult): ProjectProvider {
	return result.ok && result.kind === 'repo' ? result.identity.provider : 'other';
}
