import React, { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Globe, RefreshCw, RotateCcw, Square, ZoomIn, ZoomOut } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { BROWSER_DEVICE_PRESETS, type BrowserBridge, type BrowserPage, type LocalServer } from '../../../shared/browser'
import type { ToolsResult } from '../../../shared/tools'
import type { PaneMenuItem } from '../agents/PaneMenu'
import { useOwlFeature } from '../state/owlFeature'
import type { BrowserStore } from './browserStore'
import { shortAddress } from './browserSteps'
import './browserParity.css'

/** The full browser (ADR-0220; Owl): the pane's dialog card, recording line, device and colour menus and local servers. */
export function useBrowserParity(): boolean { return useOwlFeature('browser-parity') }

/** The presets the More menu offers; an agent can use every one, and a page shown at another keeps it listed. */
const MENU_PRESETS = ['iphone-se', 'iphone-12-pro', 'iphone-14-pro-max', 'pixel-7', 'samsung-galaxy-s20-ultra', 'ipad-mini', 'ipad-air', 'ipad-pro'] as const

const requestOf = (threadId: string, page: BrowserPage): { threadId: string; workspaceId: string; pageId: string } => ({ threadId, workspaceId: page.workspace.workspaceId, pageId: page.id })

/** Sends one of the pane's page changes and adopts the page main answers with, or returns the problem in words. */
async function changeWith(store: BrowserStore, run: (() => Promise<ToolsResult<BrowserPage>>) | undefined, unavailable: string, noAnswer: string): Promise<string | null> {
  if (!run) return unavailable
  try {
    const result = await run()
    if (!result.ok) return result.error.message
    store.adopt(result.value)
    return null
  } catch { return noAnswer }
}

/**
 * A dialog the page opened (ADR-0220): Sotto answers it here, since the page draws none while Sotto's browser tools
 * hold it. It stands at the page's foot until answered, by the user here or by the agent's dialog action.
 */
export function DialogStrip({ page, threadId, store, bridge }: { readonly page: BrowserPage; readonly threadId: string; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined }): ReactNode {
  const { t } = useLingui()
  const dialog = page.dialog
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [text, setText] = useState(dialog?.defaultPrompt ?? '')
  const first = useRef<HTMLButtonElement | HTMLInputElement | null>(null)
  const key = dialog ? `${dialog.type}:${dialog.message}` : ''
  useEffect(() => { setText(dialog?.defaultPrompt ?? ''); setProblem(null); if (key) requestAnimationFrame(() => first.current?.focus()) }, [key])
  if (!dialog) return null
  const answer = (accept: boolean): void => {
    setBusy(true); setProblem(null)
    void changeWith(store, bridge?.answerDialog ? () => bridge.answerDialog!({ ...requestOf(threadId, page), accept, ...(dialog.type === 'prompt' && accept ? { promptText: text } : {}) }) : undefined,
      t`This window cannot answer the page's dialog.`, t`The browser did not answer. Try again.`).then(setProblem).finally(() => setBusy(false))
  }
  const submit = (event: FormEvent): void => { event.preventDefault(); answer(true) }
  const lead = dialog.type === 'alert' ? t({ message: 'The page says', comment: 'Before the words of a web page\'s alert dialog.' })
    : dialog.type === 'beforeunload' ? t({ message: 'Leave this page? Changes may not be saved', comment: 'A web page asks before it is left.' })
      : t({ message: 'The page asks', comment: 'Before the words of a web page\'s confirm or prompt dialog.' })
  const ok = dialog.type === 'beforeunload' ? t({ message: 'Leave', comment: 'Leaves a web page that asked to stay.' }) : t({ message: 'OK', comment: 'Accepts a web page\'s dialog.' })
  const cancel = dialog.type === 'beforeunload' ? t({ message: 'Stay', comment: 'Stays on a web page that asked before being left.' }) : t({ message: 'Cancel', comment: 'Dismisses a web page\'s dialog.' })
  // A group, not a dialog: the page stays drawn above it, and focus goes to its first answer.
  return <form className="browser-pane__strip browser-parity__dialog" data-state="waiting" role="group" aria-labelledby={`browser-dialog-${page.id}`} onSubmit={submit}>
    <span className="browser-pane__dot" aria-hidden="true" />
    <p className="browser-pane__strip-text browser-pane__request" id={`browser-dialog-${page.id}`}>
      <span className="browser-parity__lead">{lead}</span>{dialog.message ? <span className="browser-parity__words">{dialog.message}</span> : null}
    </p>
    {dialog.type === 'prompt' ? <input ref={element => { first.current = element }} className="tt-input tt-focusable browser-parity__prompt" aria-label={t`Your answer to the page`} value={text} maxLength={4000} disabled={busy} onChange={event => setText(event.currentTarget.value)} /> : null}
    <div className="browser-pane__answers">
      <button ref={dialog.type === 'prompt' ? undefined : element => { first.current = element }} type="submit" className="tt-button tt-button--primary tt-focusable" disabled={busy}>{ok}</button>
      {dialog.type !== 'alert' ? <button type="button" className="tt-button tt-focusable" disabled={busy} onClick={() => answer(false)}>{cancel}</button> : null}
    </div>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </form>
}

/** How long a recording has run, as m:ss, from when main started it. */
export function recordingClock(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** The line that says an agent is recording the page (ADR-0220), with Stop, which keeps what it recorded. */
export function RecordingLine({ page, threadId, store, bridge }: { readonly page: BrowserPage; readonly threadId: string; readonly store: BrowserStore; readonly bridge: BrowserBridge | undefined }): ReactNode {
  const { t } = useLingui()
  const startedAt = page.recording?.startedAt
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  if (startedAt === undefined) return null
  const stop = (): void => {
    setBusy(true); setProblem(null)
    void changeWith(store, bridge?.stopRecording ? () => bridge.stopRecording!(requestOf(threadId, page)) : undefined,
      t`This window cannot stop the recording.`, t`The browser did not answer. Try again.`).then(setProblem).finally(() => setBusy(false))
  }
  const clock = recordingClock(startedAt, now)
  return <div className="browser-pane__strip browser-parity__recording" data-state="recording">
    <span className="browser-pane__dot" aria-hidden="true" />
    {/* The clock is not read aloud each second; the line's name says recording once. */}
    <span className="browser-pane__strip-text"><span className="browser-pane__lead" role="status">{t({ message: 'Recording this page', comment: 'An agent is recording a browser page to a video file.' })}</span><span className="browser-pane__last" aria-hidden="true"> · {clock}</span></span>
    <button type="button" className="tools-chrome__button tt-focusable" disabled={busy} title={t`Stop recording and keep the video in this thread's browser files`} onClick={stop}>
      <Square size={13} aria-hidden="true" />{t({ message: 'Stop', comment: 'Stops recording a browser page.' })}
    </button>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
  </div>
}

/**
 * The More menu's device and colour groups (ADR-0220): a preset with its orientation, Rotate while one is shown, and
 * the page's colour scheme. `run` sends the change; the menu closes, so its result shows on the page itself.
 */
export function parityMenuGroups(page: BrowserPage, words: { device: (name: string) => string; rotate: (landscape: boolean) => string; scheme: (scheme: 'auto' | 'light' | 'dark') => string },
  run: (change: { preset?: typeof BROWSER_DEVICE_PRESETS[number]['id']; orientation?: 'portrait' | 'landscape'; appearance?: 'light' | 'dark' | null }) => void, busy: boolean, devices: boolean): PaneMenuItem[][] {
  const check = (on: boolean): ReactNode => on ? <Check size={15} aria-hidden="true" /> : <span className="browser-pane__no-check" aria-hidden="true" />
  const preset = page.viewport?.preset
  const orientation = page.viewport?.orientation ?? 'portrait'
  const offered = [...MENU_PRESETS, ...(preset && !(MENU_PRESETS as readonly string[]).includes(preset) ? [preset] : [])]
  const deviceGroup: PaneMenuItem[] = devices ? [
    ...offered.map(id => {
      const device = BROWSER_DEVICE_PRESETS.find(item => item.id === id)!
      return { id: `preset-${id}`, label: words.device(device.name), checked: preset === id, icon: check(preset === id), disabled: busy, run: () => run({ preset: id, orientation: preset === id ? orientation : 'portrait' }) }
    }),
    ...(preset ? [{ id: 'rotate', label: words.rotate(orientation === 'portrait'), icon: <RotateCcw size={15} aria-hidden="true" />, disabled: busy, run: () => run({ preset, orientation: orientation === 'portrait' ? 'landscape' : 'portrait' }) }] : []),
  ] : []
  const scheme = page.appearance === 'light' || page.appearance === 'dark' ? page.appearance : 'auto'
  const schemeGroup: PaneMenuItem[] = [
    { id: 'scheme-auto', label: words.scheme('auto'), checked: scheme === 'auto', icon: check(scheme === 'auto'), disabled: busy, run: () => run({ appearance: null }) },
    { id: 'scheme-light', label: words.scheme('light'), checked: scheme === 'light', icon: check(scheme === 'light'), disabled: busy, run: () => run({ appearance: 'light' }) },
    { id: 'scheme-dark', label: words.scheme('dark'), checked: scheme === 'dark', icon: check(scheme === 'dark'), disabled: busy, run: () => run({ appearance: 'dark' }) },
  ]
  return [deviceGroup, schemeGroup].filter(group => group.length > 0)
}

/** The words the menu groups use, in the reader's language. */
export function useParityMenuWords(): Parameters<typeof parityMenuGroups>[1] {
  const { t } = useLingui()
  return {
    device: name => t({ message: `Show as ${name}`, comment: '{name} is a device, such as iPhone 12 Pro. The browser page takes its size.' }),
    rotate: landscape => landscape ? t({ message: 'Rotate to landscape', comment: 'Turns the device the browser page is shown as on its side.' }) : t({ message: 'Rotate to portrait', comment: 'Turns the device the browser page is shown as upright.' }),
    scheme: scheme => scheme === 'light' ? t({ message: 'Page in light colours', comment: 'The browser page is told the reader prefers a light colour scheme.' })
      : scheme === 'dark' ? t({ message: 'Page in dark colours', comment: 'The browser page is told the reader prefers a dark colour scheme.' })
        : t({ message: 'Page in the computer\'s colours', comment: 'The browser page follows the computer\'s light or dark setting.' }),
  }
}

/** A page's zoom as the row and the menu say it: 175%. */
export const zoomPercent = (zoom: number): string => `${Math.round(zoom * 100)}%`
/**
 * The More menu's zoom group (ADR-0222): Zoom in, Zoom out and Actual size, with the keys that do the same from the
 * page, Ctrl (Command on a Mac) with =, - and 0, as Chrome's do.
 */
export function zoomMenuGroup(page: BrowserPage, words: { in: string; out: string; reset: (percent: string) => string }, mac: boolean, run: (zoom: 'in' | 'out' | 'reset') => void, busy: boolean): PaneMenuItem[] {
  const zoom = page.zoom ?? 1
  const key = (plain: string, code: string): { plain: string; keys: string } => ({ plain: `${mac ? '⌘' : 'Ctrl+'}${plain}`, keys: `${mac ? 'Meta' : 'Control'}+${code}` })
  return [
    { id: 'zoom-in', label: words.in, icon: <ZoomIn size={15} aria-hidden="true" />, disabled: busy || zoom >= 5, shortcut: key('=', '='), run: () => run('in') },
    { id: 'zoom-out', label: words.out, icon: <ZoomOut size={15} aria-hidden="true" />, disabled: busy || zoom <= 0.25, shortcut: key('-', '-'), run: () => run('out') },
    { id: 'zoom-reset', label: words.reset(zoomPercent(zoom)), icon: <span className="browser-pane__no-check" aria-hidden="true" />, disabled: busy || zoom === 1, shortcut: key('0', '0'), run: () => run('reset') },
  ]
}
/** The zoom group's words, in the reader's language. */
export function useZoomWords(): Parameters<typeof zoomMenuGroup>[1] {
  const { t } = useLingui()
  return {
    in: t({ message: 'Zoom in', comment: 'Makes the browser page larger.' }),
    out: t({ message: 'Zoom out', comment: 'Makes the browser page smaller.' }),
    reset: percent => t({ message: `Actual size (now ${percent})`, comment: '{percent} is the page\'s zoom now, such as 175%. Puts the browser page back at 100%.' }),
  }
}
/**
 * The page's zoom beside the address while it is not 100% (ADR-0222), as Chrome shows it; pressing it puts the page back
 * at 100%. It stays while the page is zoomed rather than fading, since the native page cannot be drawn over.
 */
export function ZoomChip({ zoom, busy, onReset }: { readonly zoom: number; readonly busy: boolean; readonly onReset: () => void }): ReactNode {
  const { t } = useLingui()
  const percent = zoomPercent(zoom)
  return <button type="button" className="tools-chrome__button tt-focusable browser-parity__zoom" disabled={busy} onClick={onReset}
    aria-label={t({ message: `Zoom ${percent}. Back to 100%`, comment: '{percent} is the browser page\'s zoom, such as 175%. Pressing it puts the page back at 100%.' })}
    title={t({ message: `This page is at ${percent}. Press to show it at 100%.`, comment: '{percent} is the browser page\'s zoom, such as 175%.' })}>
    {zoom > 1 ? <ZoomIn size={14} aria-hidden="true" /> : <ZoomOut size={14} aria-hidden="true" />}<span>{percent}</span>
  </button>
}
/** Sends a zoom step for `page` and adopts the answer. */
export function zoomFor(store: BrowserStore, bridge: BrowserBridge | undefined, threadId: string, page: BrowserPage, zoom: 'in' | 'out' | 'reset', unavailable: string, noAnswer: string): Promise<string | null> {
  return changeWith(store, bridge?.zoom ? () => bridge.zoom!({ ...requestOf(threadId, page), zoom }) : undefined, unavailable, noAnswer)
}

/** Sends a menu change for `page` and adopts the answer. */
export function emulateFor(store: BrowserStore, bridge: BrowserBridge | undefined, threadId: string, page: BrowserPage, change: Parameters<Parameters<typeof parityMenuGroups>[2]>[0], unavailable: string, noAnswer: string): Promise<string | null> {
  return changeWith(store, bridge?.emulate ? () => bridge.emulate!({ ...requestOf(threadId, page), ...change }) : undefined, unavailable, noAnswer)
}

/**
 * Web servers started from Sotto, by its terminals or agents, that answer with a page (ADR-0220), offered in the empty
 * pane. Listed when the pane shows them and on Look again; Sotto asks each for its front page on loopback and keeps nothing.
 */
export function LocalServers({ threadId, workspaceId, bridge, disabled, onOpen }: { readonly threadId: string; readonly workspaceId: string | null; readonly bridge: BrowserBridge | undefined; readonly disabled: boolean; readonly onOpen: (url: string) => void }): ReactNode {
  const { t } = useLingui()
  const [servers, setServers] = useState<readonly LocalServer[] | null>(null)
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    if (!bridge?.localServers || workspaceId === null) return
    const ask = ++asked.current
    setLoading(true)
    try {
      const result = await bridge.localServers({ threadId, workspaceId })
      if (ask === asked.current) setServers(result.ok ? result.value : [])
    } catch { if (ask === asked.current) setServers([]) } finally { if (ask === asked.current) setLoading(false) }
  }, [bridge, threadId, workspaceId])
  useEffect(() => { void load() }, [load])
  if (!bridge?.localServers || workspaceId === null) return null
  return <section className="browser-pane__opened browser-parity__servers" aria-labelledby="browser-pane-servers" aria-busy={loading || undefined}>
    <div className="browser-parity__servers-head">
      <h2 id="browser-pane-servers">{t({ message: 'Servers started from Sotto', comment: 'Heads the local web servers that Sotto terminals or agents started, as the browser pane found them.' })}</h2>
      <button type="button" className="files-icon tt-focusable" aria-label={t`Look for local servers again`} title={t`Look for local servers again`} disabled={loading} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" /></button>
    </div>
    {servers === null ? null : servers.length === 0 ? <p className="browser-parity__none tt-paragraph">{t`No web server started from Sotto is answering. Start one in a terminal here, then look again.`}</p>
      : <ul>{servers.map(server => {
        const where = shortAddress(server.url)
        return <li key={server.url}><button type="button" className="browser-pane__recent tt-focusable" title={server.process ? `${server.url}\n${server.process}` : server.url} disabled={disabled}
          aria-label={t({ message: `Open ${where}`, comment: '{where} is a page address, such as localhost:5173/notes.' })} onClick={() => onOpen(server.url)}>
          <Globe size={15} aria-hidden="true" /><span>{where}</span>{server.title ? <span className="browser-parity__server-title">{server.title}</span> : null}</button></li>
      })}</ul>}
  </section>
}
