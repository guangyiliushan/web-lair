import Root from './select.svelte';
import Group from './select-group.svelte';
import Label from './select-label.svelte';
import Item from './select-item.svelte';
import Content from './select-content.svelte';
import Trigger from './select-trigger.svelte';
import Separator from './select-separator.svelte';
import ScrollDownButton from './select-scroll-down-button.svelte';
import ScrollUpButton from './select-scroll-up-button.svelte';
import GroupHeading from './select-group-heading.svelte';

export {
	Root,
	Group,
	Label,
	Item,
	Content,
	Trigger,
	Separator,
	ScrollDownButton,
	ScrollUpButton,
	GroupHeading,
	//
	Root as Select,
	Group as SelectGroup,
	Label as SelectLabel,
	Item as SelectItem,
	Content as SelectContent,
	Trigger as SelectTrigger,
	Separator as SelectSeparator,
	ScrollDownButton as SelectScrollDownButton,
	ScrollUpButton as SelectScrollUpButton,
	GroupHeading as SelectGroupHeading
};

// `Portal` is deliberately not exported: `Select.Content` already portals its
// layer, and a caller-side `<Select.Portal>` nests a second one (UX-1020-02).
// To move the layer inside a Sheet/Dialog, pass `portalProps` to Content.
