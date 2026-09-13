import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BrowserBridge } from '../../../shared/browser'
import { toolsPanelStore, type ToolsPanelStore } from './toolsPanelStore'
import './webLinks.css'

export type WebLinkDestination = 'external' | 'embedded'

/** How a link click went. `message` is said beside the message when the outcome needs words. */
export interface WebLinkResult {
  readonly ok: boolean
  readonly message?: string
}

export interface WebLinkRouter {
  /** Whether links here can open in Sotto's browser: only a thread with a working folder has one. */
  readonly canEmbed: boolean
  /** Opens a vetted URL. Without `destination`, the Web links setting decides. */
  open(url: string, destination?: WebLinkDestination): Promise<WebLinkResult>
}

function bridgeBrowser(): BrowserBridge | undefined {
  return (window.sotto as { browser?: BrowserBridge } | undefined)?.browser
}

async function openSystem(url: string): Promise<WebLinkResult> {
  const open = window.sotto?.openExternalLink
  return open ? open(url).then(result => ({ ok: result.ok }), () => ({ ok: false })) : { ok: false }
}

/** Outside any thread: every link goes to the system browser or mail app. */
export const systemLinkRouter: WebLinkRouter = { canEmbed: false, open: url => openSystem(url) }

const WebLinkRouterContext = createContext<WebLinkRouter>(systemLinkRouter)

export function useWebLinkRouter(): WebLinkRouter {
  return useContext(WebLinkRouterContext)
}

/** Builds the router for one thread's transcript: web links follow the setting, or the reader's choice for one link. */
export function threadLinkRouter(threadId: string, threadTitle: string, bridge: BrowserBridge | undefined, store: ToolsPanelStore = toolsPanelStore): WebLinkRouter {
  return {
    canEmbed: bridge !== undefined,
    async open(url, destination) {
      if (!bridge || url.startsWith('mailto:')) return destination === 'embedded' ? { ok: false, message: 'Only web pages open in Sotto’s browser.' } : openSystem(url)
      try {
        const target = await store.browser.target(bridge, threadId)
        if (!target && destination === 'embedded') return { ok: false, message: 'This thread has no working folder for Sotto’s browser.' }
        const result = await bridge.openLink({ url, ...(destination ? { destination } : {}), ...(target ? { target } : {}) })
        if (!result.ok) {
          // The setting asks for embedded pages but this thread cannot hold one: the system browser still opens it.
          if (!destination && result.error.code === 'workspace-unavailable') return openSystem(url)
          return { ok: false }
        }
        if (result.value.destination === 'external' || !result.value.page) return { ok: true }
        const shown = store.showBrowserPage(result.value.page)
        return shown ? { ok: true } : { ok: true, message: `Opened in ${threadTitle}’s browser. The tools panel is pinned to another thread.` }
      } catch {
        return { ok: false }
      }
    },
  }
}

/** Gives links inside a thread's transcript that thread's browser. */
export function ThreadWebLinks({ threadId, threadTitle, children, bridge, store }: {
  readonly threadId: string; readonly threadTitle: string; readonly children: ReactNode; readonly bridge?: BrowserBridge | undefined; readonly store?: ToolsPanelStore
}): ReactNode {
  const resolved = bridge ?? bridgeBrowser()
  const router = useMemo(() => threadLinkRouter(threadId, threadTitle, resolved, store), [threadId, threadTitle, resolved, store])
  return <WebLinkRouterContext.Provider value={router}>{children}</WebLinkRouterContext.Provider>
}

export interface LinkMenuItem {
  readonly id: string
  readonly label: string
  readonly run: () => void
}

/**
 * A small menu for one link, at the pointer or beside the link. Arrow keys move, Enter or Space choose,
 * Escape or Tab close it, and focus returns to the link.
 */
export function LinkMenu({ at, items, label, onClose, returnFocus }: {
  readonly at: { readonly x: number; readonly y: number }; readonly items: readonly LinkMenuItem[]; readonly label: string
  readonly onClose: () => void; readonly returnFocus: HTMLElement | null
}): ReactNode {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = menu.current
    if (!element) return
    // Kept inside the window, flipping to the other side of the point when it would overflow.
    const { width, height } = element.getBoundingClientRect()
    const left = at.x + width + 8 > window.innerWidth ? Math.max(8, at.x - width) : at.x
    const top = at.y + height + 8 > window.innerHeight ? Math.max(8, at.y - height) : at.y
    element.style.left = `${Math.round(left)}px`
    element.style.top = `${Math.round(top)}px`
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const dismiss = (event: PointerEvent): void => { if (!element.contains(event.target as Node)) onClose() }
    const blur = (): void => onClose()
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', blur)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', blur); window.removeEventListener('resize', blur) }
  }, [at, onClose])
  const close = (restore: boolean): void => {
    onClose()
    if (restore) returnFocus?.focus()
  }
  return createPortal(<div ref={menu} className="link-menu" role="menu" aria-label={label} style={{ left: at.x, top: at.y }}
    onKeyDown={event => {
      const entries = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
      const index = entries.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (event.key === 'Tab') { event.preventDefault(); close(true); return }
      const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null
      if (next === null) return
      event.preventDefault()
      entries[(next + entries.length) % entries.length]?.focus()
    }}>
    {items.map(item => <button key={item.id} type="button" role="menuitem" className="link-menu__item" tabIndex={-1}
      onClick={() => { close(true); item.run() }}>{item.label}</button>)}
  </div>, document.body)
}
