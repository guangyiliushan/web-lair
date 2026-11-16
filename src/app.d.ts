import type { User, Session } from 'better-auth';

declare global {
	namespace App {
		interface Locals {
			user?: User;
			session?: Session;
			profile?: {
				displayName: string;
				slug: string;
				bio: string | null;
				avatarUrl: string | null;
				status: 'active' | 'deleted';
			};
			/** Derived from the better-auth admin-plugin role; null when not owner/admin. */
			admin?: {
				userId: string;
				role: 'owner' | 'admin';
			} | null;
		}
		interface PageData {
			auth?: {
				user: {
					id: string;
					name: string;
					email: string;
					emailVerified: boolean;
					image: string | null;
				} | null;
				profile: {
					displayName: string;
					avatarUrl: string | null;
				} | null;
			} | null;
			/** Page title rendered by the admin header. */
			headerTitle?: string;
			/** Action buttons rendered by the admin header. */
			headerActions?: Array<{
				label: string;
				iconName: string;
				variant?: 'default' | 'outline' | 'ghost';
				size?: 'default' | 'sm' | 'lg' | 'icon';
				href?: string;
				/** Page-registered handler id (`admin-header-actions.ts`), e.g. to open a dialog. */
				actionId?: string;
				/** Turns the button into a dropdown; items render in declaration order. */
				menu?: Array<{
					label: string;
					href?: string;
					actionId?: string;
				}>;
			}>;
			/** Absolute-origin base for head URLs; null falls back to the request origin. */
			siteOrigin?: string | null;
		}
		/** Error payload: languages offered on a missing-translation 404. */
		interface Error {
			message: string;
			available?: Array<{ lang: string; href: string }>;
		}
	}
}

export {};
