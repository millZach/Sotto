import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { t } from '@lingui/core/macro'
import type { BrowserBridge, BrowserPage } from '../../../shared/browser'
import type { FilesBridge, FilesError } from '../../../shared/files'
import { fileDownloads } from './fileDownloads'
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
  /** Shows a page that already opened in this thread's browser, such as a question's page main opened there (ADR-0108). */
  show?(page: BrowserPage): WebLinkResult
  /** Shows a file a message links to in Finder or File Explorer. Only a thread's transcript can: a relative path is read from its folder. */
  revealFile?(path: string): Promise<WebLinkResult>
  /** Opens a Markdown file a message links to in the side panel (ADR-0120, November 3 amendment). Only a thread's transcript can. */
  openFile?(path: string): void
  /**
   * Opens a file a message links to in its own app, or its folder (ADR-0120, November 12 amendment). `shown` says it was a
   * program, which is never opened and was shown in its folder instead.
   */
  openInApp?(path: string): Promise<WebLinkResult & { readonly shown?: boolean }>
  /** Whether a link's file is on a paired host, where a press shows it in Files and nothing here can open it. */
  fileOnHost?(path: string): boolean
  /** Shows a file on a paired host in Files, selected, or alone when it is outside the thread's folder; with `download`, saves it to this computer too. */
  showHostFile?(path: string, download?: boolean): Promise<WebLinkResult>
}

/** Why a file on a paired host could not be shown, in the interface's language: the host's own service answers in English. */
function hostFileRefusal(error: FilesError): string {
  switch (error.code) {
    case 'path-unavailable': return t`This file is not on the computer this thread runs on, or it has moved. Nothing was opened.`
    case 'path-outside-workspace': return t`This link points outside the thread’s folder. Nothing was opened.`
    case 'thread-unavailable': case 'workspace-unavailable': return t`This thread’s folder is not available on its computer. Nothing was opened.`
    case 'busy': return t`Files is busy. Nothing was opened. Try again shortly.`
    default: return error.message || t`Sotto could not show this file. Nothing was opened.`
  }
}

function bridgeBrowser(): BrowserBridge | undefined {
  return (window.sotto as { browser?: BrowserBridge } | undefined)?.browser
}

async function openSystem(url: string): Promise<WebLinkResult> {
  const open = window.sotto?.openExternalLink ?? window.sottoPopup?.openExternalLink
  return open ? open(url).then(result => ({ ok: result.ok }), () => ({ ok: false })) : { ok: false }
}

/** Outside any thread: every link goes to the system browser or mail app. */
const systemLinkRouter: WebLinkRouter = { canEmbed: false, open: url => openSystem(url) }

const WebLinkRouterContext = createContext<WebLinkRouter>(systemLinkRouter)

export function useWebLinkRouter(): WebLinkRouter {
  return useContext(WebLinkRouterContext)
}

/**
 * Where a page opened in a thread's own browser is shown, for a page with no Tools panel beside its panes (Watcher's
 * room). Left unset, Tools > Browser beside the panes shows it. A function takes the page where it can be seen and
 * says so when that needs words. `null` means the thread's browser cannot be shown from anywhere, so its links open
 * in the system browser and Open in Sotto browser is not offered.
 */
export type BrowserPageRoute = ((page: BrowserPage) => WebLinkResult) | null
export const BrowserPageRouteContext = createContext<BrowserPageRoute | undefined>(undefined)

/**
 * Where a Markdown file a message linked opens, for a page with no Tools panel beside its panes (Watcher's room). Left
 * unset, Tools > Files beside the panes shows it. `readerOf` names the thread whose machine a link's path is on, which is
 * not always the thread whose message names it.
 */
export interface LinkedFileRoute {
  open(threadId: string, path: string): void
  readerOf(threadId: string, path: string): string
  /** Whether a thread runs on a paired host, so its files are there and not on this computer. */
  onPairedHost?(threadId: string): boolean
}
export const LinkedFileRouteContext = createContext<LinkedFileRoute | undefined>(undefined)

/**
 * Builds the router for one thread's transcript: web links follow the setting, or the reader's choice for one link.
 * `focused` is whether this is the focused pane (split view can show more than one); an unfocused pane's own click
 * still opens the page, but never pulls the focused thread's Tools open onto a thread the user is not looking at (#331).
 * `show`, when given, takes an opened page where it can be seen instead of Tools beside the panes.
 */
export function threadLinkRouter(threadId: string, threadTitle: string, bridge: BrowserBridge | undefined, store: ToolsPanelStore = toolsPanelStore, focused = true,
  show?: (page: BrowserPage) => WebLinkResult, showFile?: LinkedFileRoute, onPairedHost = false): WebLinkRouter {
  const filesBridge = (): FilesBridge | undefined => (window.sotto as { files?: FilesBridge } | undefined)?.files
  const readerOf = (path: string): string => showFile?.readerOf(threadId, path) ?? threadId
  const fileOnHost = (path: string): boolean => { const reader = readerOf(path); return reader === threadId ? onPairedHost : showFile?.onPairedHost?.(reader) ?? false }
  const showPage = (page: BrowserPage): WebLinkResult => {
    if (show) return show(page)
    const shown = store.showBrowserPage(page, focused)
    if (shown === 'opened') return { ok: true }
    // Pinned elsewhere: the page opened here, but Tools is looking at another thread, not this one.
    if (shown === 'pinned-elsewhere') return { ok: true, message: t({ message: `Opened in ${threadTitle}’s browser, and Tools is pinned to another thread. Unpin it to see the page.`, comment: '{threadTitle} is a thread\'s title.' }) }
    return { ok: true, message: t({ message: `Opened in ${threadTitle}’s browser. Open Tools > Browser in that thread to see it.`, comment: '{threadTitle} is a thread\'s title.' }) }
  }
  return {
    show: showPage,
    openFile(path) {
      if (showFile) showFile.open(threadId, path)
      else store.showLinkedFile(threadId, path, focused)
    },
    fileOnHost,
    async openInApp(path) {
      const files = filesBridge()
      if (!files?.openLink) return { ok: false, message: t`Sotto cannot open files from here. Nothing was opened.` }
      try {
        const result = await files.openLink({ threadId: readerOf(path), path })
        return result.ok ? { ok: true, shown: result.value.did === 'shown' } : { ok: false, message: result.error.message }
      } catch { return { ok: false, message: t`Sotto could not open this file. Nothing was opened.` } }
    },
    async showHostFile(path, download = false) {
      const files = filesBridge()
      if (!files?.linkedFile) return { ok: false, message: t`Sotto cannot show files from here. Nothing was opened.` }
      const reader = readerOf(path)
      try {
        const result = await files.linkedFile({ threadId: reader, path, want: 'place' })
        if (!result.ok) return { ok: false, message: hostFileRefusal(result.error) }
        if (result.value.is !== 'place') return { ok: false, message: t`Sotto could not show this file. Nothing was opened.` }
        const { inside, kind } = result.value
        // Files browses a thread's own folder beside its pane. Anywhere else, and in a room with no Tools, a file is shown alone.
        const inTree = inside !== null && !showFile && reader === threadId
        if (kind === 'directory' && !inTree) return { ok: false, message: t`This folder is on another computer, outside what Files shows here. Nothing was opened. Copy its path from the link’s menu instead.` }
        if (inTree) {
          store.showThreadFiles(threadId, focused)
          if (kind === 'directory') store.files.showFolder(files, threadId, inside.path)
          else store.files.showFile(files, threadId, inside.path)
        } else if (showFile) showFile.open(reader, path)
        else store.showLinkedFile(threadId, path, focused)
        if (!download) return { ok: true }
        if (kind === 'directory') return { ok: true, message: t`A folder is not downloaded. It is open in Files, where each file can be.` }
        // Named as the panel that shows it names it, so its line of progress is that file's.
        fileDownloads.start(files, reader, inTree ? inside.path : path)
        return { ok: true }
      } catch { return { ok: false, message: t`Sotto could not show this file. Nothing was opened.` } }
    },
    async revealFile(path) {
      const files = (window.sotto as { files?: FilesBridge } | undefined)?.files
      if (!files?.revealLink) return { ok: false, message: t`Sotto cannot show files from here. Nothing was opened.` }
      try {
        const result = await files.revealLink({ threadId: showFile?.readerOf(threadId, path) ?? threadId, path })
        return result.ok ? { ok: true } : { ok: false, message: result.error.message }
      } catch { return { ok: false, message: t`Sotto could not show this file. Nothing was opened.` } }
    },
    canEmbed: bridge !== undefined,
    async open(url, destination) {
      if (!bridge || url.startsWith('mailto:')) return destination === 'embedded' ? { ok: false, message: t`Only web pages open in Sotto’s browser.` } : openSystem(url)
      try {
        const target = await store.browser.target(bridge, threadId)
        if (!target && destination === 'embedded') return { ok: false, message: t`This thread has no working folder for Sotto’s browser.` }
        const result = await bridge.openLink({ url, ...(destination ? { destination } : {}), ...(target ? { target } : {}) })
        if (!result.ok) {
          // The setting asks for embedded pages but this thread cannot hold one: the system browser still opens it.
          if (!destination && result.error.code === 'workspace-unavailable') return openSystem(url)
          return { ok: false }
        }
        if (result.value.destination === 'external' || !result.value.page) return { ok: true }
        return showPage(result.value.page)
      } catch {
        return { ok: false }
      }
    },
  }
}

/**
 * Gives links inside a thread's transcript that thread's browser. `focused` should be the pane's own focus state.
 * `onPairedHost` says the thread runs on a paired host. Sotto's browser is on this computer and that thread's Browser
 * tool is on the host, so its links open in the system browser whatever the setting says, and this computer's browser
 * bridge, which refuses another host's thread by throwing, is never asked.
 */
export function ThreadWebLinks({ threadId, threadTitle, children, bridge, store, focused = true, onPairedHost = false }: {
  readonly threadId: string; readonly threadTitle: string; readonly children: ReactNode; readonly bridge?: BrowserBridge | undefined; readonly store?: ToolsPanelStore
  readonly focused?: boolean; readonly onPairedHost?: boolean
}): ReactNode {
  const route = useContext(BrowserPageRouteContext)
  // A thread whose browser cannot be shown from here has none to open links in.
  const resolved = route === null || onPairedHost ? undefined : bridge ?? bridgeBrowser()
  const fileRoute = useContext(LinkedFileRouteContext)
  const router = useMemo(() => threadLinkRouter(threadId, threadTitle, resolved, store, focused, route ?? undefined, fileRoute, onPairedHost), [threadId, threadTitle, resolved, store, focused, route, fileRoute, onPairedHost])
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
