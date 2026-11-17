import { EMBED_PROVIDERS, type EmbedProviderId } from './registry';
import { parseImageTail } from '$lib/components/markdown/image/tail-attrs';

/**
 * decideImage is the embed decision for bare `!` image nodes — a pure function that
 * never touches the network.
 * It short-circuits: tail attributes saying `type=image`, then an enclosing grid in image
 * mode, then a known image extension, then a provider registry match, otherwise a generic
 * card.
 * Reason: non-web protocols (data:, javascript:, …) are never cards — the node stays an
 * image and the sanitizer strips the src, so the URL cannot leak into card text or
 * attributes either.
 * Callers enforce the other half of the contract — see `remarkImageEmbed`.
 */

export interface ImageDecisionContext {
	url: string;
	/** Raw tail-attribute text (spec 2 #7) as stored by remark-image-attr. */
	tailAttrs?: string;
	/** True when the image sits inside grid{type=images|layout=masonry|carousel}. */
	inImageContainer?: boolean;
}

export type ImageDecision =
	{ kind: 'image' } | { kind: 'embed'; provider: EmbedProviderId | 'generic' };

const IMAGE_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'svg',
	'bmp',
	'ico'
]);

/** Site-internal card paths (spec 3.4: lair posts / notes / thoughts). */
const SITE_EMBED_PATH_REGEX = /^\/(posts|notes|thoughts)\//;

/** Storage-line variant suffix (`/i/<key>@thumb|grid|preview|full`): it trails
 * the extension, so it comes off before the extension match (otherwise variant
 * URLs fall through to generic embed cards). */
const STORAGE_VARIANT_SUFFIX = /@(thumb|grid|preview|full)$/;

export function imageExtension(url: string): string | null {
	const clean = url.split(/[?#]/, 1)[0].replace(STORAGE_VARIANT_SUFFIX, '');
	const match = /\.([A-Za-z0-9]+)$/.exec(clean);
	return match ? match[1].toLowerCase() : null;
}

function matchWebProvider(parsed: URL): EmbedProviderId | null {
	for (const provider of EMBED_PROVIDERS) {
		if (provider.match(parsed)) return provider.id;
	}
	return null;
}

export function decideImage(context: ImageDecisionContext): ImageDecision {
	if (context.tailAttrs && parseImageTail(context.tailAttrs).type === 'image') {
		return { kind: 'image' };
	}
	if (context.inImageContainer) {
		return { kind: 'image' };
	}
	const extension = imageExtension(context.url);
	if (extension !== null && IMAGE_EXTENSIONS.has(extension)) {
		return { kind: 'image' };
	}

	// One URL parse drives both the non-web guard and the registry match.
	let parsed: URL | null;
	try {
		parsed = new URL(context.url);
	} catch {
		parsed = null; // site-relative path
	}
	if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { kind: 'image' };
	}
	if (parsed) {
		const provider = matchWebProvider(parsed);
		if (provider) return { kind: 'embed', provider };
	} else if (SITE_EMBED_PATH_REGEX.test(context.url)) {
		return { kind: 'embed', provider: 'lair' };
	}
	return { kind: 'embed', provider: 'generic' };
}
