import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { CURSOR_SIGN_IN_WORDS, type CursorSignInBridge, type CursorSignInView } from '../../../shared/cursorSignIn'
import type { ProviderProblem } from '../../../shared/agents'
import { Button } from '../components/Button'

/** How often the tile asks main where a sign-in stands while it waits for the user on cursor.com. */
const READ_EVERY_MS = 1500
const running = (view: CursorSignInView | null | undefined): boolean =>
  view !== null && view !== undefined && (view.stage === 'starting' || view.stage === 'waiting' || view.stage === 'finishing')
/** What the tile says when a sign-in ended without connecting and main gave no sentence of its own. */
export const CURSOR_SIGN_IN_ENDED = 'Cursor did not finish signing in, so Sotto is not connected to it. Nothing was saved. Sign in again to try once more.'
const REOPEN_FAILED = 'The sign-in page could not open. Nothing was changed. Try again.'

/** Where Cursor's sign-in from its tile stands, and the presses that move it. */
export interface CursorSignIn {
  readonly view: CursorSignInView | null
  readonly pending: 'start' | 'reopen' | 'sign-out' | null
  readonly error: string | null
  readonly notice: string | null
  /** Signed out from the tile: until Cursor connects again, the tile offers Sign in rather than a Connect that would fail. */
  readonly signedOut: boolean
  /** A sign-in is under way: started, or waiting on cursor.com. */
  readonly signing: boolean
  /** Each answers what the tile should put focus on next, if anything. */
  readonly start: () => Promise<'again' | 'sign-in' | null>
  readonly reopen: () => Promise<'sign-in' | null>
  readonly cancel: () => void
  readonly signOut: () => Promise<'sign-in' | null>
  /** Cursor connected: whatever the tile said about signing out no longer holds. */
  readonly connected: () => void
}

/**
 * Cursor's sign-in from its tile (ADR-0123, variant A of the prototype), held by the Providers page so moving between
 * its tabs and providers keeps a sign-in waiting. Main runs Cursor's own sign-in and opens its cursor.com page; this
 * follows it until Cursor says it signed in or it ends, and stops one still waiting when the page goes. The page's
 * address never reaches the window.
 */
export function useCursorSignIn(bridge: CursorSignInBridge | undefined): CursorSignIn {
  const [view, setView] = useState<CursorSignInView | null>(null)
  const [pending, setPending] = useState<CursorSignIn['pending']>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const current = useRef<CursorSignInView | null>(null)
  current.current = view
  /** Cancel pressed while the start was still on its way: the sign-in it answers with is stopped, not shown. */
  const cancelled = useRef(false)
  useEffect(() => () => { const last = current.current; if (bridge && last && running(last)) void bridge.cancel({ id: last.id }).catch(() => undefined) }, [bridge])

  const id = view?.id, stage = view?.stage
  useEffect(() => {
    if (!bridge || !id || !running(current.current)) return
    let alive = true
    const timer = setInterval(() => {
      void bridge.read({ id }).then(next => {
        if (!alive) return
        if (next === null || next.stage === 'ended' || next.stage === 'failed' || next.stage === 'refused') { setView(null); setError(next?.message ?? CURSOR_SIGN_IN_ENDED) }
        else if (next.stage === 'connected') { setView(null); setSignedOut(false) }
        else setView(next)
      }, () => undefined)
    }, READ_EVERY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [bridge, id, stage])

  const start = async (): Promise<'again' | 'sign-in' | null> => {
    if (!bridge || pending) return null
    cancelled.current = false
    setPending('start'); setError(null); setNotice(null)
    try {
      const started = await bridge.start()
      if (cancelled.current) { if (started.view && running(started.view)) void bridge.cancel({ id: started.view.id }).catch(() => undefined); return null }
      if (started.view && running(started.view)) { setView(started.view); return 'again' }
      if (started.view?.stage === 'connected') { setSignedOut(false); return null }
      setError(started.view?.message ?? started.message ?? CURSOR_SIGN_IN_ENDED)
      return 'sign-in'
    } catch {
      if (!cancelled.current) setError(CURSOR_SIGN_IN_WORDS.notRunning)
      return null
    } finally { setPending(null) }
  }
  const reopen = async (): Promise<'sign-in' | null> => {
    const last = current.current
    if (!bridge || !last || pending) return null
    setPending('reopen'); setError(null)
    try {
      const done = await bridge.reopen({ id: last.id })
      if (done.ok) return null
      setView(null); setError(done.message ?? CURSOR_SIGN_IN_ENDED)
      return 'sign-in'
    } catch { setError(REOPEN_FAILED); return null }
    finally { setPending(null) }
  }
  const cancel = (): void => {
    const last = current.current
    cancelled.current = true
    setView(null); setError(null)
    if (bridge && last) void bridge.cancel({ id: last.id }).catch(() => undefined)
  }
  const signOut = async (): Promise<'sign-in' | null> => {
    if (!bridge || pending) return null
    setPending('sign-out'); setError(null); setNotice(null)
    try {
      const done = await bridge.signOut()
      if (!done.ok) { setError(done.message ?? CURSOR_SIGN_IN_WORDS.signOutFailed); return null }
      setSignedOut(true); setNotice(done.message ?? CURSOR_SIGN_IN_WORDS.signedOut)
      return 'sign-in'
    } catch { setError(CURSOR_SIGN_IN_WORDS.signOutFailed); return null }
    finally { setPending(null) }
  }
  return { view, pending, error, notice, signedOut, signing: running(view) || pending === 'start', start, reopen, cancel, signOut,
    connected: () => { if (signedOut) setSignedOut(false) } }
}

/**
 * Cursor's Local connection on its tile (ADR-0123, variant A of the prototype): Sign in runs Cursor's own sign-in, main
 * opens its cursor.com page in the browser, and the tile waits with Open the page again and Cancel until Cursor says it
 * signed in, when it connects by itself. Connected, it offers Sign out of Cursor beside Disconnect. Escape while it
 * waits cancels, as Cancel does.
 */
export function CursorConnection({ signIn, problem: reported, connected, connectButton, busy, onGuide }: {
  readonly signIn: CursorSignIn
  readonly problem: ProviderProblem | undefined
  readonly connected: boolean
  /** The page's own Connect, Retry or Disconnect, which stays as it is for every other state. */
  readonly connectButton: ReactNode
  /** Another press on this provider is under way, so a sign-in waits for it. */
  readonly busy: boolean
  /** Opens Cursor's install guide, for a computer without Cursor's CLI. */
  readonly onGuide: () => void
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const { view, pending, error, notice, signing } = signIn
  const problem = signIn.signedOut && !connected ? 'signed-out' : reported
  const settled = signIn.connected
  useEffect(() => { if (connected) settled() }, [connected, settled])
  const focus = (target: 'again' | 'sign-in' | null): void => {
    if (target) requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-cursor="${target}"]`)?.focus())
  }
  const cancel = (): void => { signIn.cancel(); focus('sign-in') }
  // A sign-in that ends while focus is on its own controls (they go with it) hands focus to what the tile offers next.
  const wasSigning = useRef(signing)
  useEffect(() => {
    if (wasSigning.current && !signing && (!document.activeElement || document.activeElement === document.body)) {
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-cursor="sign-in"], .provider-client__actions button:not(:disabled)')?.focus())
    }
    wasSigning.current = signing
  }, [signing])

  const lines = (): ReactNode => {
    if (signing) return <>
      <p className="provider-connection__lead">{view?.stage === 'finishing' ? 'Signed in on cursor.com. Connecting Cursor…' : CURSOR_SIGN_IN_WORDS.waiting}</p>
      <p className="provider-connection__waiting" role="status"><i aria-hidden="true" />{!view || view.stage === 'starting' ? 'Starting Cursor’s sign-in…' : 'Waiting for Cursor. This connects by itself.'}</p>
    </>
    if (connected) return <p>Uses your Cursor sign-in on this computer. Sotto keeps no Cursor key, and runs Cursor with a folder of its own, so your own Cursor’s settings stay as they are.</p>
    if (problem === 'signed-out') return <p>Sotto uses Cursor’s own sign-in on this computer and keeps no Cursor key. You need a Cursor account.</p>
    if (problem === 'not-installed') return <p>Cursor’s CLI is not installed on this computer. Install it with Cursor’s guide, then connect again.</p>
    return <p>Uses your Cursor sign-in on this computer. Sotto runs Cursor with a folder of its own, so your own Cursor’s settings stay as they are.</p>
  }
  const actions = (): ReactNode => {
    if (signing) return <>
      <Button variant="secondary" data-cursor="again" disabled={!view || pending !== null} aria-label="Open Cursor’s sign-in page in your browser again"
        onClick={() => void signIn.reopen().then(focus)}>Open the page again</Button>
      <Button variant="ghost" aria-label="Cancel signing in to Cursor" onClick={cancel}>Cancel</Button>
    </>
    if (connected) return <>
      {connectButton}
      <Button variant="ghost" disabled={pending !== null || busy} aria-label="Sign out of Cursor on this computer" onClick={() => void signIn.signOut().then(focus)}>
        {pending === 'sign-out' ? 'Signing out…' : 'Sign out of Cursor'}</Button>
    </>
    if (problem === 'signed-out') return <Button variant="primary" data-cursor="sign-in" disabled={busy} aria-label="Sign in to Cursor in your browser" onClick={() => void signIn.start().then(focus)}>Sign in</Button>
    if (problem === 'not-installed') return <>
      <Button variant="primary" aria-label="Open Cursor’s install guide in your browser" onClick={onGuide}>Install guide</Button>
      {connectButton}
    </>
    return connectButton
  }
  return <div ref={root} className="provider-connection provider-connection--cursor" onKeyDown={event => {
    if (event.key === 'Escape' && signing && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); cancel() }
  }}>
    <div><h4>Local connection</h4>{lines()}
      {notice ? <p className="provider-connection__notice" role="status">{notice}</p> : null}
      {error ? <p className="provider-detail__error" role="alert">{error}</p> : null}
    </div>
    <div className="provider-client__actions">{actions()}</div>
  </div>
}
