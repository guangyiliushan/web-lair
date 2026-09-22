/**
 * Link magnet (batch 3a) — publish-side hover effect for inline links.
 *
 * One delegated listener per container: mousemove sets `--mx`/`--my` (%
 * coordinates relative to the hovered link) and stamps `data-magnet`, and
 * the stylesheet turns those variables into the translate + spotlight +
 * external-link arrow. Purely progressive: without JS the links keep their
 * plain underline; the effect never touches layout (transform/background
 * only), and prefers-reduced-motion disables the motion in CSS.
 *
 * Deliberately NOT attached inside the Lexical editor: editor-side text
 * geometry must stay stable (zero-offset rule) — link interactions there
 * go through LinkHoverEditor instead.
 *
 * Official references:
 * - requestAnimationFrame schedules "before the next repaint" and is
 *   one-shot (MDN: Web/API/Window/requestAnimationFrame) — the rAF gate
 *   coalesces mousemove bursts into one style write per frame.
 * - CSS custom properties in pseudo-element styles (MDN: CSS/--*) carry
 *   the pointer position from JS to CSS without inline transforms.
 */

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
		if (!target || target.closest('.embed-card-mount')) {
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
