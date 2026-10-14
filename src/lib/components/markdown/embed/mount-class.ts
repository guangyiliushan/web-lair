/**
 * Root class of the mounted embed card (EmbedCard's non-iframe branch).
 * The enhancers (link magnet, content lightbox) exclude card internals by
 * this class - one home so the three sites cannot drift (review 3d, 01 P3-4:
 * the exclusion was hand-copied per enhancer).
 */
export const EMBED_MOUNT_CLASS = 'embed-card-mount';
