/**
 * Client (browser) project setup: loaded once per worker before any spec.
 * Chromium keeps at most 250 resource-timing entries by default; on a
 * full-suite run the dev-mode module graph alone fills that, after which
 * later entries are dropped - positive oracles then read zero (a false red:
 * the mermaid lazy-chunk counter) and negative assertions can never observe
 * a late entry (a false green: embed-card-mount's "no twitter request").
 * One raise here covers the whole project (review 3d, 03/06).
 */
performance.setResourceTimingBufferSize(2000);
