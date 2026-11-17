/**
 * attachMagnetLinks is the publish-side hover effect for inline links.
 * One delegated listener per container: mousemove sets `--mx`/`--my` (px offsets within
 * the hovered link) and stamps `data-magnet`; the stylesheet turns those into the
 * translate + spotlight + external-link arrow (the `Inline link magnet` block in
 * `src/routes/layout.css`).
 * The rAF gate coalesces mousemove bursts into one style write per frame, and custom
 * properties carry the pointer position from JS to CSS without inline transforms.
 * Purely progressive: without JS the links keep their plain underline, the effect never
 * touches layout (transform/background only), and prefers-reduced-motion disables the
 * motion in CSS.
 * Deliberately not attached inside the Lexical editor: editor-side text geometry must
 * stay stable (zero-offset rule) — link interactions there go through LinkHoverEditor
 * instead.
 */
import { EMBED_MOUNT_CLASS } from '$lib/components/markdown/embed/mount-class';

const MAGNET_SELECTOR = 'a[href^="http"]';

export function attachMagnetLinks(container: HTMLElement): () => void {
	let current: HTMLAnchorElement | null = null;
	let rafId: number | null = null;
	let pendingX = 0;
	let pendingY = 0;

	function clearStamp(): void {
		if (current) current.removeAttribute('data-magnet');
		current = null;
	}

	function onMove(event: MouseEvent): void {
		const target = (event.target as HTMLElement | null)?.closest?.(
			MAGNET_SELECTOR
		) as HTMLAnchorElement | null;
		if (!target || target.closest(`.${EMBED_MOUNT_CLASS}`)) {
			clearStamp();
			return;
		}
		if (target !== current) {
			clearStamp();
			current = target;
			current.setAttribute('data-magnet', '');
		}
		pendingX = event.clientX;
		pendingY = event.clientY;
		if (rafId !== null) return;
		rafId = requestAnimationFrame(() => {
			rafId = null;
			if (!current) return;
			const rect = current.getBoundingClientRect();
			current.style.setProperty('--mx', `${(pendingX - rect.left).toFixed(1)}px`);
			current.style.setProperty('--my', `${(pendingY - rect.top).toFixed(1)}px`);
		});
	}

	function onLeave(): void {
		clearStamp();
	}

	container.addEventListener('mousemove', onMove, { passive: true });
	container.addEventListener('mouseleave', onLeave, { passive: true });

	return () => {
		container.removeEventListener('mousemove', onMove);
		container.removeEventListener('mouseleave', onLeave);
		if (rafId !== null) cancelAnimationFrame(rafId);
		clearStamp();
	};
}
