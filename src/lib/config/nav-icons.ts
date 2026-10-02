import type { Component } from 'svelte';
import IconBook from '@tabler/icons-svelte-runes/icons/book';
import IconBike from '@tabler/icons-svelte-runes/icons/bike';
import IconBulb from '@tabler/icons-svelte-runes/icons/bulb';
import IconCake from '@tabler/icons-svelte-runes/icons/cake';
import IconCamera from '@tabler/icons-svelte-runes/icons/camera';
import IconCode from '@tabler/icons-svelte-runes/icons/code';
import IconCoffee from '@tabler/icons-svelte-runes/icons/coffee';
import IconFeather from '@tabler/icons-svelte-runes/icons/feather';
import IconFlower from '@tabler/icons-svelte-runes/icons/flower';
import IconHeart from '@tabler/icons-svelte-runes/icons/heart';
import IconHome from '@tabler/icons-svelte-runes/icons/home';
import IconLeaf from '@tabler/icons-svelte-runes/icons/leaf';
import IconMapPin from '@tabler/icons-svelte-runes/icons/map-pin';
import IconMessages from '@tabler/icons-svelte-runes/icons/messages';
import IconMoon from '@tabler/icons-svelte-runes/icons/moon';
import IconMountain from '@tabler/icons-svelte-runes/icons/mountain';
import IconMusic from '@tabler/icons-svelte-runes/icons/music';
import IconNotebook from '@tabler/icons-svelte-runes/icons/notebook';
import IconPalette from '@tabler/icons-svelte-runes/icons/palette';
import IconPlane from '@tabler/icons-svelte-runes/icons/plane';
import IconRun from '@tabler/icons-svelte-runes/icons/run';
import IconSparkles from '@tabler/icons-svelte-runes/icons/sparkles';
import IconStar from '@tabler/icons-svelte-runes/icons/star';
import IconSun from '@tabler/icons-svelte-runes/icons/sun';

/**
 * Nav icon whitelist (notes plan §8.6 / pages line "icon whitelist"): topic
 * and page rows store a tabler icon NAME (kebab), but dynamic menu data
 * crosses the load serialisation boundary where components cannot travel -
 * so the name is resolved here, client-side, against a curated set.
 *
 * Add an entry when a curated icon is genuinely needed; keep it small (every
 * entry is bundle weight and a maintenance promise).
 */
export const NAV_ICON_WHITELIST: Record<string, Component> = {
	book: IconBook,
	bike: IconBike,
	bulb: IconBulb,
	cake: IconCake,
	camera: IconCamera,
	code: IconCode,
	coffee: IconCoffee,
	feather: IconFeather,
	flower: IconFlower,
	heart: IconHeart,
	home: IconHome,
	leaf: IconLeaf,
	'map-pin': IconMapPin,
	messages: IconMessages,
	moon: IconMoon,
	mountain: IconMountain,
	music: IconMusic,
	notebook: IconNotebook,
	palette: IconPalette,
	plane: IconPlane,
	run: IconRun,
	sparkles: IconSparkles,
	star: IconStar,
	sun: IconSun
};

export const NAV_ICON_NAMES = Object.keys(NAV_ICON_WHITELIST);

/** Resolve a stored icon name; unknown/null names yield null (no crash). */
export function navIcon(name: string | null | undefined): Component | null {
	if (!name) return null;
	return NAV_ICON_WHITELIST[name] ?? null;
}
