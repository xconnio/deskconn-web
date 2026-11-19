import type { ComputedRef, InjectionKey, Ref } from 'vue'

/** Teleport target for an embedded app's own titlebar toolbar (see FloatingWindow.vue). */
export const floatingWindowToolbarKey: InjectionKey<Ref<HTMLElement | null>> = Symbol('floatingWindowToolbarHost')

/** Teleport target for a small set of action buttons shown beside the window controls
 * (minimize/maximize/close), independent of the full toolbar titlebar above. */
export const floatingWindowActionsKey: InjectionKey<Ref<HTMLElement | null>> = Symbol('floatingWindowActionsHost')

/** Teleport target inside the titlebar's "Menu" (hamburger) dropdown — for
 * app-specific menu content (see ScreenshotPanel). The button only shows when filled. */
export const floatingWindowMenuKey: InjectionKey<Ref<HTMLElement | null>> = Symbol('floatingWindowMenuHost')

/** True while the window renders in its phone layout (see FloatingWindow.vue's
 * mobile app bar) — lets an embedded app move some toolbar buttons up into the
 * app bar's action slot instead of cramming them all onto the toolbar row. */
export const floatingWindowMobileKey: InjectionKey<ComputedRef<boolean>> = Symbol('floatingWindowMobile')
