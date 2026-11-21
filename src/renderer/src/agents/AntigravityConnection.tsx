import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { ANTIGRAVITY_ACCOUNT_WORDS, type AntigravityAccountBridge, type AntigravityInstallProgress } from '../../../shared/antigravityAccount'
import { ANTIGRAVITY_SIGN_IN_METHODS, type AntigravitySignInMethod } from '../../../shared/antigravity'
import type { ProviderProblem } from '../../../shared/agents'
import type { ProviderSignInView } from '../../../shared/hostProviders'
import type { LocalProviderSignInBridge } from '../../../shared/localProviderSignIn'
import { Button } from '../components/Button'
import { SegmentedControl } from '../components/SegmentedControl'
import { shownWords, type LaterWords } from './interfaceWords'

/** How often the row asks main where a Google sign-in stands, and how far Install has got, while each runs. */
const READ_EVERY_MS = 1500
const PROGRESS_EVERY_MS = 500
const running = (view: ProviderSignInView | null | undefined): boolean =>
  view !== null && view !== undefined && (view.stage === 'starting' || view.stage === 'waiting' || view.stage === 'finishing')

const SIGN_IN_ENDED = msg`Antigravity did not finish signing in, so Sotto is not connected to it. Nothing was saved. Sign in again to try once more.`
const CODE_REFUSED = msg`Antigravity did not accept that code. Nothing was signed in. Sign in again for a new code.`
const OPEN_FAILED = msg`The sign-in page could not open. Nothing was changed. Try again.`
const CODE_FAILED = msg`The code could not be sent. Nothing was changed. Try again.`
const SIGNED_OUT = msg`Antigravity is signed out on this computer. Your threads are kept.`
const REMOVED = msg`The downloaded Antigravity was removed.`
/**
 * Main's own sentences about Antigravity's account (`ANTIGRAVITY_ACCOUNT_WORDS`), written in English as every provider's
 * words in main are, as messages in the interface language. Any other sentence, such as one `agy` wrote, shows as written.
 */
export const ANTIGRAVITY_ACCOUNT_MESSAGES: Readonly<Record<keyof typeof ANTIGRAVITY_ACCOUNT_WORDS, MessageDescriptor>> = {
  notRunning: msg`Antigravity’s sign-in is not available right now. Nothing was changed.`,
  enterpriseFailed: msg`Gemini Enterprise did not finish signing in. Nothing was signed in. Try Sign in again.`,
  signOutFailed: msg`Antigravity could not sign out. Your threads are kept. Try Sign out again.`,
  installFailed: msg`Antigravity could not be installed. Nothing was changed. Try Install again.`,
  removeFailed: msg`The downloaded Antigravity could not be removed. Nothing was changed.`,
}
const MAIN_SENTENCES = new Map<string, MessageDescriptor>((Object.keys(ANTIGRAVITY_ACCOUNT_WORDS) as (keyof typeof ANTIGRAVITY_ACCOUNT_WORDS)[])
  .map(key => [ANTIGRAVITY_ACCOUNT_WORDS[key], ANTIGRAVITY_ACCOUNT_MESSAGES[key]]))
const heard = (sentence: string | undefined, otherwise: MessageDescriptor): LaterWords => sentence ? MAIN_SENTENCES.get(sentence) ?? sentence : otherwise

/** Where Antigravity's own sign-ins and download stand from its row, and the presses that move them. */
export interface AntigravitySignIn {
  /** A Google account's paste-code sign-in (ADR-0200's shape, inline in the row). */
  readonly view: ProviderSignInView | null
  /** Open sign-in page was pressed for this sign-in, so the code field is offered. */
  readonly opened: boolean
  readonly pending: 'start' | 'open' | 'code' | 'enterprise' | 'sign-out' | 'install' | 'remove' | null
  readonly error: LaterWords | null
  readonly notice: LaterWords | null
  /** How far Install has got while it runs. */
  readonly install: AntigravityInstallProgress | null
  /** A Google sign-in or Gemini Enterprise's is under way. */
  readonly signing: boolean
  readonly start: () => Promise<boolean>
  readonly open: () => Promise<boolean>
  readonly sendCode: (code: string) => Promise<boolean>
  readonly cancel: () => void
  readonly signInEnterprise: () => Promise<void>
  readonly signOut: () => Promise<boolean>
  readonly runInstall: () => Promise<void>
  readonly cancelInstall: () => void
  readonly removeDownloaded: () => Promise<void>
  readonly clear: () => void
}

/**
 * Antigravity's sign-ins and download from its row in Settings › Providers (ADR-0211, variant B of the prototype), held
 * by the Providers page so closing the row or opening another keeps a sign-in waiting. Main runs `agy`'s sign-in, holds
 * and opens Google's page; the row sees where it stands and hands main the code the user pastes back.
 */
export function useAntigravitySignIn(signIn: LocalProviderSignInBridge | undefined, account: AntigravityAccountBridge | undefined): AntigravitySignIn {
  const [view, setView] = useState<ProviderSignInView | null>(null)
  const [opened, setOpened] = useState(false)
  const [pending, setPending] = useState<AntigravitySignIn['pending']>(null)
  const [error, setError] = useState<LaterWords | null>(null)
  const [notice, setNotice] = useState<LaterWords | null>(null)
  const [install, setInstall] = useState<AntigravityInstallProgress | null>(null)
  const current = useRef<ProviderSignInView | null>(null)
  current.current = view
  const cancelled = useRef(false)
  useEffect(() => () => { const last = current.current; if (signIn && last && running(last)) void signIn.signIn({ type: 'cancel', signInId: last.id }).catch(() => undefined) }, [signIn])

  /** A view main sent: kept while it runs, otherwise said and let go. */
  const settle = (next: ProviderSignInView | null): void => {
    if (next && running(next)) { setView(next); return }
    setView(null); setOpened(false)
    if (next?.stage === 'connected') return
    setError(next?.stage === 'refused' ? CODE_REFUSED : heard(next?.message, SIGN_IN_ENDED))
  }
  const id = view?.id, stage = view?.stage
  useEffect(() => {
    if (!signIn || !id || !running(current.current)) return
    let alive = true
    const timer = setInterval(() => {
      void signIn.signIn({ type: 'read', signInId: id }).then(next => { if (alive) settle(next) }, () => undefined)
    }, READ_EVERY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [signIn, id, stage])

  useEffect(() => {
    if (pending !== 'install' || !account) return
    let alive = true
    const timer = setInterval(() => { void account.installProgress().then(next => { if (alive) setInstall(next) }, () => undefined) }, PROGRESS_EVERY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [pending, account])

  const begin = (what: NonNullable<AntigravitySignIn['pending']>): void => { setPending(what); setError(null); setNotice(null) }
  const start = async (): Promise<boolean> => {
    if (!signIn || pending) return false
    cancelled.current = false
    begin('start')
    try {
      const started = await signIn.signIn({ type: 'start', provider: 'antigravity' })
      if (cancelled.current) { if (started && running(started)) void signIn.signIn({ type: 'cancel', signInId: started.id }).catch(() => undefined); return false }
      setOpened(false); settle(started)
      return started !== null && running(started)
    } catch { if (!cancelled.current) setError(ANTIGRAVITY_ACCOUNT_MESSAGES.notRunning); return false }
    finally { setPending(null) }
  }
  const open = async (): Promise<boolean> => {
    const last = current.current
    if (!signIn || !last || pending) return false
    setPending('open'); setError(null)
    try { const next = await signIn.signIn({ type: 'open', signInId: last.id }); setOpened(true); if (next) settle(next); return true }
    catch { setError(OPEN_FAILED); return false }
    finally { setPending(null) }
  }
  const sendCode = async (code: string): Promise<boolean> => {
    const last = current.current
    if (!signIn || !last || pending || !code.trim()) return false
    setPending('code'); setError(null)
    try { settle(await signIn.signIn({ type: 'code', signInId: last.id, code: code.trim() })); return true }
    catch { setError(CODE_FAILED); return false }
    finally { setPending(null) }
  }
  const cancel = (): void => {
    const last = current.current
    cancelled.current = true
    setView(null); setOpened(false); setError(null)
    if (signIn && last) void signIn.signIn({ type: 'cancel', signInId: last.id }).catch(() => undefined)
  }
  const signInEnterprise = async (): Promise<void> => {
    if (!account || pending) return
    begin('enterprise')
    try { const done = await account.enterpriseSignIn(); if (!done.ok) setError(heard(done.message, ANTIGRAVITY_ACCOUNT_MESSAGES.enterpriseFailed)) }
    catch { setError(ANTIGRAVITY_ACCOUNT_MESSAGES.enterpriseFailed) }
    finally { setPending(null) }
  }
  const signOut = async (): Promise<boolean> => {
    if (!account || pending) return false
    begin('sign-out')
    try {
      const done = await account.signOut()
      if (!done.ok) { setError(heard(done.message, ANTIGRAVITY_ACCOUNT_MESSAGES.signOutFailed)); return false }
      setNotice(heard(done.message, SIGNED_OUT)); return true
    } catch { setError(ANTIGRAVITY_ACCOUNT_MESSAGES.signOutFailed); return false }
    finally { setPending(null) }
  }
  const runInstall = async (): Promise<void> => {
    if (!account || pending) return
    begin('install'); setInstall({ installing: true })
    try { const done = await account.install(); if (!done.ok) setError(heard(done.message, ANTIGRAVITY_ACCOUNT_MESSAGES.installFailed)) }
    catch { setError(ANTIGRAVITY_ACCOUNT_MESSAGES.installFailed) }
    finally { setPending(null); setInstall(null) }
  }
  const cancelInstall = (): void => { if (account) void account.cancelInstall().catch(() => undefined) }
  const removeDownloaded = async (): Promise<void> => {
    if (!account || pending) return
    begin('remove')
    try { const done = await account.removeDownloaded(); if (done.ok) setNotice(heard(done.message, REMOVED)); else setError(heard(done.message, ANTIGRAVITY_ACCOUNT_MESSAGES.removeFailed)) }
    catch { setError(ANTIGRAVITY_ACCOUNT_MESSAGES.removeFailed) }
    finally { setPending(null) }
  }
  return { view, opened, pending, error, notice, install, signing: running(view) || pending === 'start' || pending === 'enterprise',
    start, open, sendCode, cancel, signInEnterprise, signOut, runInstall, cancelInstall, removeDownloaded, clear: () => { setError(null); setNotice(null) } }
}

/** What the row saves of Antigravity's settings (`agentConfigurationSchema`); a key is never one of them. */
export interface AntigravitySettings {
  readonly antigravitySignInMethod: AntigravitySignInMethod
  readonly antigravityProject: string
  readonly antigravityLocation: string
  readonly antigravityBinaryPath: string
}

/**
 * Antigravity's Local connection in its row (ADR-0211, variant B of the prototype, Cursor's row shape): the sign-in
 * method as a four-way choice, two by two when narrow, then that method's numbered steps inline. A Google account signs in
 * with Google's page and the code pasted back; Gemini Enterprise finishes in the browser once its project and location are
 * filled in; a Gemini API key and Agent Platform connect from the row, the key masked and never shown back. Escape while a
 * Google sign-in waits cancels it.
 */
export function AntigravityConnection({ signIn, settings, keySaved, problem, said, connected, connectButton, busy, configure, saveKey, connect }: {
  readonly signIn: AntigravitySignIn
  readonly settings: AntigravitySettings
  /** Whether the credential store holds Antigravity's key. */
  readonly keySaved: boolean
  readonly problem: ProviderProblem | undefined
  /** The client's own sentence about a problem the folded row names in a word. */
  readonly said: LaterWords | undefined
  readonly connected: boolean
  /** The page's own Connect, Retry or Disconnect. */
  readonly connectButton: ReactNode
  readonly busy: boolean
  /** Saves part of Antigravity's settings; answers what went wrong, or null. */
  readonly configure: (patch: Partial<AntigravitySettings>) => Promise<LaterWords | null>
  /** Saves the key in the credential store, or removes it when empty; answers what went wrong, or null. */
  readonly saveKey: (value: string) => Promise<LaterWords | null>
  readonly connect: () => void
}): ReactNode {
  const { t } = useLingui()
  const ids = useId()
  const root = useRef<HTMLDivElement>(null)
  const method = settings.antigravitySignInMethod
  const [project, setProject] = useState(settings.antigravityProject)
  const [location, setLocation] = useState(settings.antigravityLocation)
  const [binaryPath, setBinaryPath] = useState(settings.antigravityBinaryPath)
  useEffect(() => setProject(settings.antigravityProject), [settings.antigravityProject])
  useEffect(() => setLocation(settings.antigravityLocation), [settings.antigravityLocation])
  useEffect(() => setBinaryPath(settings.antigravityBinaryPath), [settings.antigravityBinaryPath])
  const [key, setKey] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [rowError, setRowError] = useState<LaterWords | null>(null)
  // Agent Platform takes a key or a project and location; a saved key wins, as main reads it.
  const [platformWay, setPlatformWay] = useState<'key' | 'project'>(keySaved || !settings.antigravityProject ? 'key' : 'project')
  const { view, opened, pending, signing, install } = signIn
  const googleWaiting = view !== null
  const enterpriseWaiting = pending === 'enterprise'
  const installing = pending === 'install'
  const cloudReady = project.trim() !== '' && location.trim() !== ''
  const locked = signing || installing || busy || saving

  const focus = (target: string): void => { requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-antigravity="${target}"]:not(:disabled)`)?.focus()) }
  const ran = async (work: () => Promise<LaterWords | null>): Promise<boolean> => {
    setSaving(true); setRowError(null); signIn.clear()
    try { const failed = await work(); if (failed) setRowError(failed); return failed === null }
    finally { setSaving(false) }
  }
  const saveCloud = async (): Promise<boolean> => project === settings.antigravityProject && location === settings.antigravityLocation
    ? true : ran(() => configure({ antigravityProject: project.trim(), antigravityLocation: location.trim() }))
  const choose = (next: string): void => {
    if (!(ANTIGRAVITY_SIGN_IN_METHODS as readonly string[]).includes(next) || next === method) return
    setReplacing(false); setKey('')
    void ran(() => configure({ antigravitySignInMethod: next as AntigravitySignInMethod }))
  }
  const connectWithKey = async (): Promise<void> => {
    if (!key.trim()) return
    if (!await ran(() => saveKey(key.trim()))) return
    setKey(''); setReplacing(false); connect(); focus('replace')
  }
  const removeKey = async (): Promise<void> => { if (await ran(() => saveKey(''))) { setReplacing(false); focus('key') } }
  const startGoogle = async (): Promise<void> => { if (await signIn.start()) focus('open') }
  const startEnterprise = async (): Promise<void> => { if (await saveCloud()) await signIn.signInEnterprise() }
  const connectProject = async (): Promise<void> => { if (await saveCloud()) connect() }
  const cancel = (): void => { signIn.cancel(); setCode(''); focus('sign-in') }
  const finish = async (): Promise<void> => { if (await signIn.sendCode(code)) setCode('') }

  const methodNames: Readonly<Record<AntigravitySignInMethod, string>> = {
    'oauth-personal': t({ message: 'Google account', comment: 'A way Antigravity signs in: with the user’s own Google account.' }),
    'oauth-business': t({ message: 'Gemini Enterprise', comment: 'A way Antigravity signs in. Gemini Enterprise is Google’s product name; keep it.' }),
    'gemini-api-key': t({ message: 'Gemini API key', comment: 'A way Antigravity signs in: with a key from Google AI Studio.' }),
    'agent-platform': t({ message: 'Agent Platform', comment: 'A way Antigravity signs in: Google Cloud’s Agent Platform (Vertex AI). Agent Platform is Google’s product name; keep it.' }),
  }
  const methodLines: Readonly<Record<AntigravitySignInMethod, string>> = {
    'oauth-personal': t`Sign in with Google in your browser, then paste back the code Google shows.`,
    'oauth-business': t`Your organisation’s Gemini Enterprise: its Google Cloud project and location, then a Google sign-in in your browser. No code to paste.`,
    'gemini-api-key': t`A key from Google AI Studio.`,
    'agent-platform': t`Vertex AI on Google Cloud, with an API key or with a Google Cloud project and location.`,
  }
  const keyName = method === 'agent-platform' ? t`Agent Platform API key` : t`Gemini API key`
  const STORE = t`The key stays on this computer, in Sotto’s credential store. Sotto hands it to agy and never shows it again.`

  const step = (n: number, body: ReactNode): ReactNode => <li><span className="antigravity-steps__n" aria-hidden="true">{n}</span><div>{body}</div></li>
  const cloudFields = (): ReactNode => <div className="antigravity-fields">
    <label className="antigravity-field"><span>{t`Google Cloud project`}</span>
      <input className="tt-input" data-antigravity="project" value={project} placeholder="my-project-id" autoComplete="off" spellCheck={false} disabled={locked}
        onChange={event => setProject(event.target.value)} onBlur={() => void saveCloud()} /></label>
    <label className="antigravity-field"><span>{t`Location`}</span>
      <input className="tt-input" data-antigravity="location" value={location} placeholder="us-central1" autoComplete="off" spellCheck={false} disabled={locked}
        onChange={event => setLocation(event.target.value)} onBlur={() => void saveCloud()} /></label>
  </div>
  const keyField = (): ReactNode => {
    if (keySaved && !replacing) return <>
      <div className="antigravity-key-saved"><p className="tt-paragraph"><Check size={15} aria-hidden="true" />{t`Key saved`}</p>
        <div className="provider-client__actions">
          <Button variant="secondary" data-antigravity="replace" disabled={locked} aria-label={t({ message: `Replace the saved ${keyName}`, comment: '{keyName} is the kind of key, such as Gemini API key.' })} onClick={() => { setReplacing(true); focus('key') }}>{t({ message: 'Replace', comment: 'Replaces a saved key with a new one.' })}</Button>
          <Button variant="ghost" disabled={locked} aria-label={t({ message: `Remove the saved ${keyName} from this computer`, comment: '{keyName} is the kind of key, such as Gemini API key.' })} onClick={() => void removeKey()}>{t`Remove key`}</Button>
        </div></div>
      <p className="antigravity-hint tt-paragraph">{STORE}</p>
    </>
    return <div className="antigravity-field">
      <label htmlFor={`${ids}-key`}>{keyName}</label>
      <div className="antigravity-field__row">
        <input id={`${ids}-key`} className="tt-input" type="password" data-antigravity="key" value={key} placeholder={replacing ? t`Paste the new key` : t`Paste the key`}
          autoComplete="off" spellCheck={false} disabled={locked} aria-describedby={`${ids}-key-hint`}
          onChange={event => setKey(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void connectWithKey() } }} />
        <Button variant="primary" disabled={locked || !key.trim()} aria-label={t({ message: `Save this ${keyName} and connect Antigravity`, comment: '{keyName} is the kind of key, such as Gemini API key.' })} onClick={() => void connectWithKey()}>{t`Connect`}</Button>
        {replacing ? <Button variant="ghost" disabled={locked} onClick={() => { setReplacing(false); setKey(''); focus('replace') }}>{t`Keep the saved key`}</Button> : null}
      </div>
      <p id={`${ids}-key-hint`} className="antigravity-hint tt-paragraph">{STORE}</p>
    </div>
  }
  const waitingLine = (words: string): ReactNode => <p className="provider-connection__waiting tt-paragraph" role="status"><i aria-hidden="true" />{words}</p>

  const steps = (): ReactNode => {
    if (method === 'oauth-personal') {
      if (view) return <>
        <ol className="antigravity-steps">
          {step(1, <><p className="tt-paragraph">{t`Open Google’s sign-in page and sign in with your Google account.`}</p>
            <Button variant={opened ? 'secondary' : 'primary'} data-antigravity="open" disabled={pending !== null || view.stage === 'starting'}
              aria-label={opened ? t`Open Google’s sign-in page in your browser again` : t`Open Google’s sign-in page in your browser`}
              onClick={() => void signIn.open().then(done => { if (done) focus('code') })}>{opened ? t`Open sign-in page again` : t`Open sign-in page`}</Button></>)}
          {step(2, <p className="tt-paragraph">{t`Google then lands on an antigravity.google page that shows a code. Copy the code, or the page’s whole address.`}</p>)}
          {step(3, <div className="antigravity-field">
            <label htmlFor={`${ids}-code`}>{t`Code from the Antigravity page`}</label>
            <div className="antigravity-field__row">
              <input id={`${ids}-code`} className="tt-input" data-antigravity="code" value={code} placeholder={t`Paste the code or the page’s address`} autoComplete="off" spellCheck={false}
                disabled={view.stage !== 'waiting' || pending !== null} aria-describedby={`${ids}-code-hint`}
                onChange={event => setCode(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void finish() } }} />
              <Button variant="primary" disabled={!code.trim() || view.stage !== 'waiting' || pending !== null} onClick={() => void finish()}>{t`Finish sign-in`}</Button>
            </div>
            <p id={`${ids}-code-hint`} className="antigravity-hint tt-paragraph">{t`Paste the code, or the whole address of that page. Sotto hands it to Antigravity and keeps nothing.`}</p>
          </div>)}
        </ol>
        {waitingLine(view.stage === 'starting' ? t`Starting Antigravity’s sign-in…` : view.stage === 'finishing' ? t`Signed in with Google. Connecting Antigravity…` : t`Waiting for the code.`)}
      </>
      if (connected) return null
      return <ol className="antigravity-steps">
        {step(1, <><p className="tt-paragraph">{t`Sign in with your Google account in your browser.`}</p>
          <Button variant="primary" data-antigravity="sign-in" disabled={locked} aria-label={t`Sign in to Antigravity with your Google account`} onClick={() => void startGoogle()}>{pending === 'start' ? t`Starting…` : t({ message: 'Sign in', comment: 'A button that signs in to a provider.' })}</Button></>)}
        {step(2, <p className="tt-paragraph">{t`Google then shows a code on an antigravity.google page. Paste it here to finish.`}</p>)}
      </ol>
    }
    if (method === 'oauth-business') {
      if (enterpriseWaiting) return <>
        <p className="provider-connection__lead tt-paragraph">{t`Finish signing in with Google in your browser.`}</p>
        {waitingLine(t`Waiting for Google. This connects by itself; there is no code to paste.`)}
      </>
      return <ol className="antigravity-steps">
        {step(1, <><p className="tt-paragraph">{t`Enter your organisation’s Google Cloud project and location.`}</p>{cloudFields()}</>)}
        {connected ? null : step(2, <><p className="tt-paragraph">{t`Sign in with Google in your browser. Google tells agy when you are done; there is no code to paste.`}</p>
          <Button variant="primary" data-antigravity="sign-in" disabled={locked || !cloudReady} aria-label={t`Sign in to Gemini Enterprise with Google in your browser`} onClick={() => void startEnterprise()}>{t({ message: 'Sign in', comment: 'A button that signs in to a provider.' })}</Button></>)}
      </ol>
    }
    if (method === 'gemini-api-key') return <ol className="antigravity-steps">
      {step(1, <p className="tt-paragraph">{t`Make a key in Google AI Studio, under API keys.`}</p>)}
      {step(2, keyField())}
    </ol>
    return <ol className="antigravity-steps">
      {step(1, <><p className="tt-paragraph">{t`Choose how Agent Platform connects.`}</p>
        <SegmentedControl label={t`Connect Agent Platform with`} value={platformWay} disabled={locked}
          options={[{ value: 'key', label: t`API key` }, { value: 'project', label: t`Project and location` }]} onChange={value => setPlatformWay(value === 'project' ? 'project' : 'key')} /></>)}
      {step(2, platformWay === 'key' ? keyField() : <>
        {cloudFields()}
        <p className="antigravity-hint tt-paragraph">{keySaved ? t`Sotto uses the saved key while one is saved. Remove it under API key to use this project instead.` : t`agy uses this computer’s Google Cloud application default credentials for that project.`}</p>
        {connected ? null : <div className="provider-client__actions"><Button variant="primary" disabled={locked || !cloudReady} aria-label={t`Connect Antigravity to Agent Platform with this project and location`} onClick={() => void connectProject()}>{t`Connect`}</Button></div>}
      </>)}
    </ol>
  }

  const lines = (): ReactNode => {
    if (problem === 'not-installed' && !connected) return <p className="tt-paragraph">{t`Antigravity’s CLI, agy, is not on this computer. Sotto can download it from Google and check it, which needs about 1.25 GB free while it unpacks. Sotto works with agy 1.5.0 or newer.`}</p>
    if (connected) return <p className="tt-paragraph">{t`Sotto runs agy with a folder of its own, so the agy you run yourself, and its sign-in, stay as they are.`}</p>
    return <p className="tt-paragraph">{t`Sotto runs agy with a folder of its own. Choose how it signs in: a Google account, Gemini Enterprise, a Gemini API key or Agent Platform.`}</p>
  }
  const browserMethod = method === 'oauth-personal' || method === 'oauth-business'
  const actions = (): ReactNode => {
    if (problem === 'not-installed' && !connected) return installing
      ? <Button variant="ghost" aria-label={t`Cancel installing Antigravity`} onClick={signIn.cancelInstall}>{t`Cancel install`}</Button>
      : <><Button variant="primary" disabled={locked} aria-label={t`Download and install Antigravity’s agy from Google`} onClick={() => void signIn.runInstall()}>{t`Install Antigravity`}</Button>{connectButton}</>
    if (googleWaiting) return <Button variant="ghost" aria-label={t`Cancel signing in to Antigravity`} onClick={cancel}>{t({ message: 'Cancel', comment: 'Stops a sign-in that is waiting for the user.' })}</Button>
    if (enterpriseWaiting) return null
    if (connected) return <>{connectButton}{browserMethod ? <Button variant="ghost" disabled={locked} aria-label={t`Sign out of Antigravity on this computer`}
      onClick={() => void signIn.signOut().then(done => { if (done) focus('sign-in') })}>{pending === 'sign-out' ? t`Signing out…` : t`Sign out of Antigravity`}</Button> : null}</>
    return browserMethod && problem === 'signed-out' ? null : connectButton
  }
  const { error, notice } = signIn
  const shownError = rowError ?? error
  const acts = actions()
  return <div ref={root} className="provider-connection provider-connection--antigravity" onKeyDown={event => {
    if (event.key === 'Escape' && googleWaiting && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); cancel() }
  }}>
    <div>
      <h4>{t({ message: 'Local connection', comment: 'Heading of a provider’s connection on this computer, in Settings > Providers.' })}</h4>
      {lines()}
      {said ? <p className={typeof said === 'string' ? 'provider-connection__said' : 'provider-connection__said tt-paragraph'}>{shownWords(said)}</p> : null}
      {installing ? waitingLine(install?.text ?? t`Downloading Antigravity from Google…`) : null}
      {problem === 'not-installed' && !connected ? null : <div className="antigravity-form">
        <div className="antigravity-field">
          <span id={`${ids}-method`}>{t`Sign-in method`}</span>
          <SegmentedControl label={t`Sign-in method`} value={method} disabled={locked || googleWaiting}
            options={ANTIGRAVITY_SIGN_IN_METHODS.map(id => ({ value: id, label: methodNames[id], describedBy: `${ids}-method-line` }))} onChange={choose} />
          <p id={`${ids}-method-line`} className="antigravity-hint tt-paragraph">{methodLines[method]}</p>
        </div>
        {steps()}
      </div>}
      {notice ? <p className={typeof notice === 'string' ? 'provider-connection__notice' : 'provider-connection__notice tt-paragraph'} role="status">{shownWords(notice)}</p> : null}
      {shownError ? <p className={typeof shownError === 'string' ? 'provider-detail__error' : 'provider-detail__error tt-paragraph'} role="alert">{shownWords(shownError)}</p> : null}
      <details className="provider-client__steps antigravity-client">
        <summary>{t`Binary path`}</summary>
        <div className="antigravity-field">
          <label htmlFor={`${ids}-binary`}>{t`agy to use instead of Sotto’s download`}</label>
          <input id={`${ids}-binary`} className="tt-input" value={binaryPath} placeholder={t`Empty: Sotto’s download, or agy on your PATH`} autoComplete="off" spellCheck={false} disabled={locked}
            onChange={event => setBinaryPath(event.target.value)} onBlur={() => { if (binaryPath.trim() !== settings.antigravityBinaryPath) void ran(() => configure({ antigravityBinaryPath: binaryPath.trim() })) }} />
        </div>
        <div className="provider-client__actions">
          <Button variant="ghost" disabled={locked || pending === 'remove'} onClick={() => void signIn.removeDownloaded()}>{pending === 'remove' ? t`Removing…` : t`Remove downloaded Antigravity`}</Button>
        </div>
        <p className="tt-paragraph">{t`Removes the agy Sotto downloaded. A version a running thread uses goes once that thread lets go of it.`}</p>
      </details>
    </div>
    {acts ? <div className="provider-client__actions">{acts}</div> : null}
  </div>
}
