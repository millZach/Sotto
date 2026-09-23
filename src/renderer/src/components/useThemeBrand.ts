import { useSyncExternalStore } from 'react'

import type { ThemeAppearance } from '../../../shared/themes/palettes'
import { APP_ICON_BRAND_ATTRIBUTE, themeBrand, type ThemeBrand } from '../../../shared/themeBranding'

/**
 * The brand of whichever window this renderer is. Both windows paint the
 * selected theme's roles onto their root as `--theme-*` properties (the main
 * window through applyAppearance, including an unsaved editor draft; the
 * widget from its snapshot), so reading the root follows selection, editing
 * and mode changes live without any other plumbing.
 */

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'
const WATCHED_ATTRIBUTES = ['style', 'data-theme', 'data-theme-id', 'data-brand']

function rootMode(root: HTMLElement): ThemeAppearance {
  const painted = root.dataset.theme
  if (painted === 'light' || painted === 'dark') return painted
  const view = root.ownerDocument.defaultView
  // A root with no painted mode follows the system, dark when it cannot tell.
  if (view === null || typeof view.matchMedia !== 'function') return 'dark'
  return view.matchMedia(SYSTEM_DARK_QUERY).matches ? 'dark' : 'light'
}

function readRole(root: HTMLElement, variable: string): string {
  const inline = root.style.getPropertyValue(variable).trim()
  if (inline.length > 0) return inline
  return root.ownerDocument.defaultView?.getComputedStyle(root).getPropertyValue(variable).trim() ?? ''
}

/** The brand the root's current roles describe; unreadable roles fall back to the default theme. */
function readRootBrand(root: HTMLElement): ThemeBrand {
  return themeBrand({
    canvas: readRole(root, '--theme-canvas'),
    accent: readRole(root, '--theme-accent'),
    accentForeground: readRole(root, '--theme-accent-foreground'),
  }, rootMode(root), { appIcon: root.dataset.brand === APP_ICON_BRAND_ATTRIBUTE })
}

function brandKey(brand: ThemeBrand): string {
  return `${brand.tile}|${brand.glyph}|${brand.orb[0]}|${brand.orb[1]}`
}

interface BrandStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly snapshot: () => ThemeBrand
}

const stores = new WeakMap<HTMLElement, BrandStore>()

function brandStore(root: HTMLElement): BrandStore {
  const existing = stores.get(root)
  if (existing !== undefined) return existing
  const listeners = new Set<() => void>()
  let current: ThemeBrand | null = null
  let dirty = true
  let detach: (() => void) | null = null

  const changed = (): void => {
    dirty = true
    for (const listener of listeners) listener()
  }
  const attach = (): (() => void) => {
    const view = root.ownerDocument.defaultView
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(changed) : null
    observer?.observe(root, { attributes: true, attributeFilter: WATCHED_ATTRIBUTES })
    const media = view !== null && typeof view.matchMedia === 'function' ? view.matchMedia(SYSTEM_DARK_QUERY) : null
    media?.addEventListener('change', changed)
    return () => {
      observer?.disconnect()
      media?.removeEventListener('change', changed)
    }
  }

  const store: BrandStore = {
    subscribe(listener) {
      listeners.add(listener)
      if (detach === null) {
        // Nothing watched the root while unsubscribed, so read it afresh.
        dirty = true
        detach = attach()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && detach !== null) {
          detach()
          detach = null
          // The last read was watched; nothing watches now, so the next one must look again.
          dirty = true
        }
      }
    },
    snapshot() {
      if (dirty || current === null) {
        const next = readRootBrand(root)
        // Keep the same object while the colours hold, so consumers do not re-render for unrelated style writes.
        if (current === null || brandKey(current) !== brandKey(next)) current = next
        // Unwatched, the root can change unseen, so only a watched read is trusted.
        dirty = detach === null
      }
      return current
    },
  }
  stores.set(root, store)
  return store
}

/** The window's brand colours, re-read whenever its root's theme roles or mode change. */
export function useThemeBrand(): ThemeBrand {
  const store = brandStore(document.documentElement)
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
}
