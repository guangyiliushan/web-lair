// Minimal barrel: the only consumer today is the posts mount (CommentsSection);
// sibling components import each other by relative path and the type surface
// comes from ./types directly - grow this on real demand (ponytail review).
export { default as CommentsSection } from './CommentsSection.svelte';
