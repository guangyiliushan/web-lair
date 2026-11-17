/**
 * Root class of the mounted embed card (EmbedCard's non-iframe branch).
 * The enhancers (link magnet, content lightbox) exclude card internals by
 * this class - one home so the three sites cannot drift (the exclusion was
 * hand-copied per enhancer before).
 */
export const EMBED_MOUNT_CLASS = 'embed-card-mount';
