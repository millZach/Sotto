import React, { useCallback, useRef, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { BrowserBounds, BrowserBridge, BrowserPage } from '../../../shared/browser'
import type { ToolsError, ToolsResult } from '../../../shared/tools'
import { pageLabel, type BrowserStore } from './browserStore'
import { useBrowserPageMount } from './useBrowserPageMount'
import { useOverlayOpen } from './browserOverlay'
import { shownWords, type LaterWords } from '../features/settings/laterWords'

/** Why Tools > Browser could not list a thread's pages, in words. */
export function listProblem(error: ToolsError, bridge: boolean): string {
  if (!bridge) return i18n._(msg`Browser is not available in this window.`)
  switch (error.code) {
    case 'thread-unavailable': return i18n._(msg`This thread is not available to the browser.`)
    case 'workspace-unavailable': return i18n._(msg`The working folder is not available.`)
    default: return error.message || i18n._(msg`The browser could not list its pages.`)
  }
}

/**
 * Shares a page with the thread's agent or stops sharing it, or sets its size: `size` is `fit` (the pane's own size)
 * or `<width>x<height>` in CSS pixels. Both Tools > Browser surfaces send these the same way.
 */
export function changePage(bridge: BrowserBridge, threadId: string, page: BrowserPage, action: 'share' | 'viewport', size = 'fit'): Promise<ToolsResult<BrowserPage>> {
  const request = { threadId, workspaceId: page.workspace.workspaceId, pageId: page.id }
  if (action === 'share') return bridge.share({ ...request, enabled: !page.sharedOrigin })
  if (size === 'fit') return bridge.viewport({ ...request, reset: true })
  const [width, height] = size.split('x').map(Number)
  return bridge.viewport({ ...request, width: width!, height: height! })
}

/**
 * The live page, drawn by main at this element's rectangle, or why it is not. `surface` bounds what counts as an
 * overlay: anything inside it never makes the page step aside. The quiet pane passes the viewport itself, so its
 * own More menu, which opens over the page, does (ADR-0154).
 */
export function PageViewport({ page, threadId, store, bridge, surface, refused, onOpenExternally, children }: {
  readonly page: BrowserPage; readonly threadId: string; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined
  readonly surface: React.RefObject<HTMLDivElement | null> | null; readonly refused: LaterWords | null; readonly onOpenExternally: () => void
  /** What sits at the page's foot, under the native view and never over it: the quiet pane's agent strip. */
  readonly children?: ReactNode
}): ReactNode {
  const { t } = useLingui()
  const host = useRef<HTMLDivElement>(null)
  const covered = useOverlayOpen(surface ?? host, host)
  const show = page.status !== 'unavailable' && covered === false
  const openInSystemBrowser = t`Open in system browser`
  const pageId = page.id

  const mount = useCallback((bounds: BrowserBounds | null) => store.mount(bridge, threadId, pageId, bounds), [store, bridge, threadId, pageId])
  useBrowserPageMount(host, show, mount)

  return <div className="browser-page" id="browser-page" role="tabpanel" aria-label={pageLabel(page)} data-status={page.status}>
    {page.status === 'unavailable' ? <div className="files-problem browser-unavailable" role="status">
      <strong>{t`This page could not load.`}</strong>
      {page.error ? <p>{page.error}</p> : null}
      <p className="browser-unavailable__url">{page.url}</p>
      <div className="browser-unavailable__actions">
        <button type="button" className="files-link tt-focusable" onClick={() => void store.history(bridge, threadId, pageId, 'reload')}>{t`Try again`}</button>
        <button type="button" className="files-link tt-focusable" onClick={onOpenExternally}>{openInSystemBrowser}</button>
      </div>
    </div> : <div ref={host} className="browser-viewport" data-covered={covered || undefined} data-refused={refused !== null || undefined}>
      {refused !== null ? <div className="files-problem browser-unavailable" role="alert">
        <strong>{t`This page could not be shown.`}</strong>{' '}
        <p className={typeof refused === 'string' ? undefined : 'tt-paragraph'}>{shownWords(refused)}</p>
        <div className="browser-unavailable__actions">
          <button type="button" className="files-link tt-focusable" onClick={() => store.retryPlacement(threadId, pageId)}>{t`Try again`}</button>
          <button type="button" className="files-link tt-focusable" onClick={onOpenExternally}>{openInSystemBrowser}</button>
        </div>
      </div> : covered ? <p className="browser-viewport__covered tt-paragraph">{t`The page steps aside while a menu or dialog is open.`}</p> : null}
    </div>}
    {children}
  </div>
}
