import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Check, ChevronLeft, Copy, ExternalLink, Plus, Search } from 'lucide-react'
import {
  COMMON_MODEL_SOURCES, KEY_SENTENCE, SIGN_IN_WORDS, hostKeySentence, opencodeSignInComesBack, type ModelSource, type ModelSourceField, type ModelSourceMethod, type ModelSources,
  type OpenCodeSignInBridge, type SignInAttempt, type SignInResult, type SignInWait,
} from '../../../shared/opencodeSignIn'
import { Button } from '../components/Button'
import { useDialogFocus } from '../components/useDialogFocus'
import { writeClipboard } from './richActions'
import './opencodeSources.css'

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
const byName = (a: ModelSource, b: ModelSource): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
const shortLabel = (method: ModelSourceMethod): string => method.kind !== 'key' ? method.label : /token/iu.test(method.label) ? /access/iu.test(method.label) ? 'Access token' : 'API token' : 'API key'
/** How a source signs in, in a few words: "API key or ChatGPT account". */
const howHint = (source: ModelSource): string => [...new Set(source.methods.map(shortLabel))].join(' or ') || 'No way to sign in from Sotto'
const isKey = (how: string): boolean => /key|token/iu.test(how)
const expiry = (at: number | undefined): string | undefined => at === undefined ? undefined
  : new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
function aboutMethod(source: ModelSource, method: ModelSourceMethod, host: string | undefined): string {
  if (method.kind === 'key') return `Paste ${/^[aeiou]/iu.test(method.label) ? 'an' : 'a'} ${method.label.replace(/^(?!API)\w/u, letter => letter.toLowerCase())} from your ${source.name} account.`
  if (method.kind === 'external') return `Uses a sign-in already on ${host ?? 'this computer'}.`
  return 'In your browser.'
}

/**
 * The OpenCode tile's Model sources block (#1104, variant A of `prototype/opencode-sign-in`): OpenCode Zen, then each
 * source Sotto's OpenCode is signed in to with how and its model count, and Add a model source, which opens the dialog.
 * Everything it learns comes through main; it never holds a key past the field it was typed in. With `host`, the same block
 * and dialog sign a connected host's own OpenCode in, over the host connection, and say so (#1107).
 */
export function OpenCodeModelSources({ bridge, pollMs = 2_000, host }: {
  readonly bridge: OpenCodeSignInBridge; readonly pollMs?: number
  /** The saved host whose OpenCode this signs in, by the name this computer saved it under; absent for this computer's own. */
  readonly host?: string | undefined
}): ReactNode {
  const on = host ? ` on ${host}` : ''
  /**
   * On a host, the browser sign-ins that turned out to finish by sending the browser back to OpenCode on that machine, by
   * source and method. OpenCode names a method's mode only when it starts, so each is learned once and then not offered.
   */
  const [unreachable, setUnreachable] = useState<ReadonlySet<string>>(() => new Set())
  const [read, setRead] = useState<ModelSources | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState<string | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const headingId = useId()
  // After a sign-out, focus moves to the next Sign out, or to Add a model source when none is left.
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current || signingOut) return
    refocus.current = false
    ;(listRef.current?.querySelector<HTMLButtonElement>('button') ?? addRef.current)?.focus()
  }, [read, signingOut])
  useEffect(() => {
    let live = true
    void bridge.sources().then(result => { if (live) setRead(result) }, () => { if (live) setRead({ status: 'refused', message: SIGN_IN_WORDS.notRunning }) })
    return () => { live = false }
  }, [bridge])
  const sources = read?.status === 'ok' ? read.sources : []
  const signed = sources.filter(source => source.signedIn)
  const signOut = async (source: ModelSource): Promise<void> => {
    setSigningOut(source.id); setError(null); setNotice('')
    const key = isKey(source.signedIn?.how ?? '')
    try {
      const result = await bridge.signOut({ sourceId: source.id })
      if (result.status === 'ok') {
        setRead(result.sources)
        setNotice([SIGN_IN_WORDS.signedOut(source.name, key), result.warning ?? ''].filter(Boolean).join(' '))
        refocus.current = true
      } else setError(result.message)
    } catch { setError(SIGN_IN_WORDS.signOutFailed(source.name)) } finally { setSigningOut(null) }
  }
  const signedIn = (next: ModelSources, source: ModelSource, method: ModelSourceMethod, warning?: string): void => {
    setRead(next); setOpen(false); setError(null)
    const count = next.status === 'ok' ? next.sources.find(item => item.id === source.id)?.models ?? 0 : 0
    setNotice([SIGN_IN_WORDS.signedIn(source.name, count), method.kind === 'key' ? SIGN_IN_WORDS.keyUnchecked(source.name) : '', warning ?? ''].filter(Boolean).join(' '))
  }
  // A sign-in the dialog was closed over may still have changed what OpenCode keeps, so the list is read again.
  const reread = useCallback((): void => { void bridge.sources().then(setRead, () => undefined) }, [bridge])
  return <div className="oc-sources" role="group" aria-labelledby={headingId} aria-busy={read === null}>
    <h4 id={headingId}>{host ? `OpenCode model sources on ${host}` : 'Model sources'}</h4>
    {read === null ? <p className="oc-empty" role="status">Reading what Sotto’s OpenCode{on} is signed in to…</p> : null}
    {read?.status === 'refused' ? <p className="provider-detail__error" role="alert">{read.message}</p> : null}
    {read?.status === 'ok' ? <>
      <ul className="oc-list" ref={listRef} aria-label={`Model sources Sotto’s OpenCode${on} can use`}>
        <li><span className="oc-src"><strong>OpenCode Zen</strong><small>Free models. No sign-in needed.</small></span><span className="oc-count">{plural(read.zenModels, 'model')}</span></li>
        {signed.map(source => <li key={source.id}>
          <span className="oc-src"><strong>{source.name}</strong><small>{source.signedIn!.how}</small></span>
          <span className="oc-count">{plural(source.models, 'model')}</span>
          <Button variant="ghost" aria-label={`Sign out of ${source.name}${on}`} disabled={signingOut !== null} onClick={() => void signOut(source)}>{signingOut === source.id ? 'Signing out…' : 'Sign out'}</Button>
        </li>)}
      </ul>
      {!signed.length ? <p className="oc-empty">Sign in to a model source, such as Anthropic, OpenAI or OpenRouter, to use its models in OpenCode threads{on}. That account pays for them.</p> : null}
      <div className="oc-below"><Button ref={addRef} variant="secondary" aria-haspopup="dialog" aria-expanded={open} aria-label={host ? `Add a model source to OpenCode on ${host}` : undefined} onClick={() => { setNotice(''); setError(null); setOpen(true) }}><Plus aria-hidden="true" size={14} />Add a model source</Button></div>
    </> : null}
    <p className="oc-notice" role="status">{notice}</p>
    {error ? <p className="provider-detail__error" role="alert">{error}</p> : null}
    {open && read?.status === 'ok' ? <AddModelSourceDialog bridge={bridge} sources={read.sources} pollMs={pollMs} fallbackFocus={addRef} host={host}
      onClose={() => setOpen(false)} onSignedIn={signedIn} onLeft={reread} unreachable={unreachable}
      onUnreachable={key => setUnreachable(current => new Set([...current, key]))} /> : null}
  </div>
}

interface Flow {
  readonly source: ModelSource
  method: number
  phase: 'form' | 'waiting'
  key: string
  code: string
  answers: Record<string, string>
  error: string | null
  attempt: SignInAttempt | null
  /** Finish handed OpenCode the pasted code and it is still taking it: the dialog says so while it reads the sign-in again. */
  taking: boolean
  /** The page's address when the browser did not open it, to open by hand. */
  unopened: string | null
}
const freshFlow = (source: ModelSource, method = 0): Flow => ({ source, method, phase: 'form', key: '', code: '', answers: defaults(source.methods[method]), error: null, attempt: null, taking: false, unopened: null })
/** Back to the form after a sign-in ended without saving anything, saying why. */
const ended = (flow: Flow, error: string): Flow => ({ ...flow, phase: 'form', attempt: null, code: '', taking: false, unopened: null, error })
function defaults(method: ModelSourceMethod | undefined): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of method?.form ?? []) {
    if (field.default !== undefined) answers[field.key] = field.default
    else if (field.options?.length) answers[field.key] = field.options[0]!.value
  }
  return answers
}
const shown = (field: ModelSourceField, answers: Record<string, string>): boolean => !field.when || answers[field.when.key] === field.when.value
function answered(method: ModelSourceMethod, answers: Record<string, string>): boolean {
  return (method.form ?? []).every(field => !shown(field, answers) || !field.required || Boolean(answers[field.key]?.trim()))
}
/** What is sent for a form: the shown fields' answers, without the ones a choice made irrelevant. */
function sentAnswers(method: ModelSourceMethod, answers: Record<string, string>): Record<string, string> | undefined {
  const sent = Object.fromEntries((method.form ?? []).filter(field => shown(field, answers) && answers[field.key]?.trim()).map(field => [field.key, answers[field.key]!.trim()]))
  return Object.keys(sent).length ? sent : undefined
}

/**
 * Add a model source: a search over every source OpenCode lists, common ones first, then the chosen source's ways to
 * sign in. Focus stays inside, Escape closes and hands focus back to the button that opened it, and a browser sign-in
 * that is waiting is cancelled when the dialog closes.
 */
function AddModelSourceDialog({ bridge, sources, pollMs, fallbackFocus, onClose, onSignedIn, onLeft, host, unreachable = new Set<string>(), onUnreachable }: {
  readonly bridge: OpenCodeSignInBridge; readonly sources: readonly ModelSource[]; readonly pollMs: number; readonly host?: string | undefined
  readonly fallbackFocus: RefObject<HTMLButtonElement | null>
  readonly onClose: () => void; readonly onSignedIn: (next: ModelSources, source: ModelSource, method: ModelSourceMethod, warning?: string) => void
  /** A sign-in the dialog left before it answered ended without saying what was saved: the tile reads the list again. */
  readonly onLeft: () => void
  /** On a host, the browser sign-ins that cannot finish from this computer (`source:method`), and how one is learned. */
  readonly unreachable?: ReadonlySet<string>; readonly onUnreachable?: (key: string) => void
}): ReactNode {
  const on = host ? ` on ${host}` : ''
  const [query, setQuery] = useState('')
  const [flow, setFlowState] = useState<Flow | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedAddress, setCopiedAddress] = useState(false)
  const flowRef = useRef<Flow | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const titleId = useId(), aboutId = useId(), listId = useId(), errorId = useId(), noteId = useId()
  const setFlow = useCallback((next: Flow | null): void => { flowRef.current = next; setFlowState(next) }, [])
  /** Cancels the waiting browser sign-in, if there is one; one OpenCode finished meanwhile is kept, so the list is read again. */
  const leave = useCallback((): void => {
    const attempt = flowRef.current?.attempt
    // A start or a key still answering finds no flow: a start cancels its sign-in and opens no page, and a key's answer
    // still reaches the tile.
    flowRef.current = null
    if (attempt) void bridge.cancel({ attemptId: attempt.id }).then(onLeft, () => undefined)
  }, [bridge, onLeft])
  const close = useCallback((): void => { leave(); onClose() }, [leave, onClose])
  // Settings closing under the dialog ends a waiting sign-in as Cancel does.
  useEffect(() => leave, [leave])
  const dialogRef = useDialogFocus({ onEscape: close, initialFocus: searchRef, fallbackFocus })
  // Each step puts focus on its first field or control, as the eye reads it.
  const focusKey = flow ? `${flow.source.id}:${flow.method}:${flow.phase}` : 'pick'
  useEffect(() => {
    if (focusKey === 'pick') return
    const dialog = dialogRef.current
    const target = dialog?.querySelector<HTMLElement>('[data-autofocus]') ?? dialog?.querySelector<HTMLElement>('.oc-dialog__body input')
      ?? dialog?.querySelector<HTMLElement>('.tt-dialog__actions .tt-button--primary')
    target?.focus()
  }, [focusKey, dialogRef])

  const finish = useCallback((result: SignInWait, current: Flow): void => {
    if (flowRef.current !== current) return
    const method = current.source.methods[current.method]!
    if (result.status === 'pending') return
    if (result.status === 'ok') { flowRef.current = null; onSignedIn(result.sources, current.source, method, result.warning); return }
    setFlow(ended(current, result.message))
  }, [onSignedIn, setFlow])
  // A waiting sign-in is read again every couple of seconds, whatever its mode: one that finishes by itself, and a pasted
  // code OpenCode is still taking, end when OpenCode says, and an expired page is noticed by OpenCode's own clock.
  const waitingId = flow?.phase === 'waiting' ? flow.attempt?.id : undefined
  useEffect(() => {
    if (!waitingId) return
    const timer = setInterval(() => {
      void bridge.wait({ attemptId: waitingId }).then(result => {
        const current = flowRef.current
        if (current?.attempt?.id === waitingId) finish(result, current)
      }, () => undefined)
    }, pollMs)
    return () => clearInterval(timer)
  }, [waitingId, bridge, pollMs, finish])

  const common = useMemo(() => COMMON_MODEL_SOURCES.flatMap(id => sources.filter(source => source.id === id)), [sources])
  const matches = (source: ModelSource): boolean => { const words = query.trim().toLowerCase(); return !words || `${source.name} ${source.id}`.toLowerCase().includes(words) }
  const shownCommon = common.filter(matches)
  const rest = sources.filter(source => !COMMON_MODEL_SOURCES.includes(source.id as typeof COMMON_MODEL_SOURCES[number]) && matches(source)).sort(byName)
  const options = (): HTMLButtonElement[] => [...listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []]
  // A source opens on its first way to sign in that can finish from here.
  const pick = (source: ModelSource): void => {
    if (source.signedIn || !source.methods.length) return
    setFlow(freshFlow(source, Math.max(0, source.methods.findIndex(method => !unreachable.has(`${source.id}:${method.id}`)))))
  }
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); options()[0]?.focus() }
    if (event.key === 'Enter') { event.preventDefault(); options().find(option => option.getAttribute('aria-disabled') !== 'true')?.click() }
  }
  const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = options(), at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, items.length - 1) : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -2
    if (next === -2) return
    event.preventDefault()
    if (next < 0) searchRef.current?.focus(); else items[next]?.focus()
  }
  const option = (source: ModelSource): ReactNode => {
    const unavailable = Boolean(source.signedIn) || !source.methods.length
    const how = source.signedIn ? 'Signed in' : howHint(source)
    return <button key={source.id} type="button" role="option" aria-selected="false" tabIndex={-1} className="oc-opt" aria-disabled={unavailable || undefined}
      aria-label={`${source.name}, ${source.signedIn ? 'already signed in' : how}`} onClick={() => pick(source)}>
      <span className="oc-opt__name">{source.name}</span><span className="oc-opt__how">{source.signedIn ? <Check aria-hidden="true" size={13} /> : null}{how}</span>
    </button>
  }

  if (!flow) {
    return <div className="tt-dialog-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
      <section ref={dialogRef} className="tt-dialog oc-dialog oc-dialog--pick" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={aboutId}>
        <h2 id={titleId}>{host ? `Add a model source to OpenCode on ${host}` : 'Add a model source'}</h2>
        <p className="tt-dialog__description" id={aboutId}>Sign Sotto’s OpenCode{on} in to a model source to use its models in OpenCode threads{host ? ' there' : ''}. That account pays for them.</p>
        <div className="oc-search"><Search aria-hidden="true" size={14} />
          <input ref={searchRef} type="text" aria-label="Search model sources" aria-controls={listId} placeholder={`Search ${sources.length} model sources`}
            value={query} autoComplete="off" spellCheck={false} onChange={event => setQuery(event.target.value)} onKeyDown={onSearchKey} /></div>
        <div ref={listRef} className="oc-pick" role="listbox" id={listId} aria-label="Model sources" onKeyDown={onListKey}>
          {shownCommon.length ? <div role="group" aria-label="Common"><div className="oc-group-head" aria-hidden="true">Common</div>{shownCommon.map(option)}</div> : null}
          {rest.length ? <div role="group" aria-label={query.trim() ? 'More matches' : 'Every model source, A to Z'}><div className="oc-group-head" aria-hidden="true">{query.trim() ? 'More matches' : 'Every model source, A to Z'}</div>{rest.map(option)}</div> : null}
          {!shownCommon.length && !rest.length ? <p className="oc-none" role="status">No model source matches “{query.trim()}”.</p> : null}
        </div>
        <div className="tt-dialog__actions"><Button variant="secondary" aria-label="Close without adding a model source" onClick={close}>Cancel</Button></div>
      </section>
    </div>
  }

  const { source } = flow
  const method = source.methods[flow.method]!
  const update = (patch: Partial<Flow>): void => setFlow({ ...flowRef.current!, ...patch })
  const run = async (work: (current: Flow) => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await work(flowRef.current!) } catch { if (flowRef.current) update({ error: SIGN_IN_WORDS.notRunning }) } finally { setBusy(false) }
  }
  /** A sign-in that answered after the dialog closed or went back: what OpenCode kept still reaches the tile. */
  const settledAfterLeaving = (result: SignInResult): void => { if (result.status === 'ok') onSignedIn(result.sources, source, method, result.warning); else onLeft() }
  const submitKey = (): Promise<void> => run(async current => {
    const key = current.key.trim()
    if (!key) return
    const result = await bridge.signInWithKey({ sourceId: source.id, key, ...(sentAnswers(method, current.answers) ? { answer: sentAnswers(method, current.answers)! } : {}) })
    if (flowRef.current !== current) { settledAfterLeaving(result); return }
    // The key leaves the field either way: a refused one is pasted again, and an accepted one is OpenCode's.
    if (result.status === 'ok') { flowRef.current = null; onSignedIn(result.sources, source, method, result.warning) }
    else setFlow({ ...current, key: '', error: result.message })
  })
  const useExternal = (): Promise<void> => run(async current => {
    const result = await bridge.useExternalSignIn({ sourceId: source.id, methodId: method.id, ...(sentAnswers(method, current.answers) ? { answer: sentAnswers(method, current.answers)! } : {}) })
    if (flowRef.current !== current) { settledAfterLeaving(result); return }
    if (result.status === 'ok') { flowRef.current = null; onSignedIn(result.sources, source, method, result.warning) } else setFlow({ ...current, error: result.message })
  })
  /** Opens the waiting sign-in's page from main; a browser that does not open leaves its address to open by hand. */
  const openPage = async (attemptId: string): Promise<void> => {
    const result = await bridge.reopen({ attemptId })
    if (flowRef.current?.attempt?.id !== attemptId) return
    if (result.status === 'not-opened') update({ error: result.message, unopened: result.address })
    else if (result.status === 'refused') update({ error: result.message })
    else if (flowRef.current.unopened || flowRef.current.error) update({ error: null, unopened: null })
  }
  const startBrowser = (): Promise<void> => run(async current => {
    const result = await bridge.startBrowserSignIn({ sourceId: source.id, methodId: method.id, ...(sentAnswers(method, current.answers) ? { answer: sentAnswers(method, current.answers)! } : {}) })
    // A dialog closed, or a step left, while this started: the sign-in is cancelled, and its page never opens.
    if (flowRef.current !== current) { if (result.status === 'waiting') void bridge.cancel({ attemptId: result.attempt.id }).catch(() => undefined); return }
    if (result.status !== 'waiting') {
      if (host && result.message === opencodeSignInComesBack(host)) onUnreachable?.(`${source.id}:${method.id}`)
      setFlow({ ...current, error: result.message }); return
    }
    setFlow({ ...current, phase: 'waiting', attempt: result.attempt, error: null, code: '', taking: false, unopened: null })
    await openPage(result.attempt.id)
  })
  const finishCode = (): Promise<void> => run(async current => {
    if (!current.attempt || !current.code.trim()) return
    const result = await bridge.finish({ attemptId: current.attempt.id, code: current.code.trim() })
    if (result.status === 'pending') { if (flowRef.current === current) setFlow({ ...current, taking: true }); return }
    if (result.status === 'refused' && flowRef.current === current && result.message === SIGN_IN_WORDS.codeRefused(source.name)) { setFlow({ ...current, code: '', taking: false, error: result.message }); return }
    finish(result, current)
  })
  const stopWaiting = (): Promise<void> => run(async current => {
    if (current.attempt) await bridge.cancel({ attemptId: current.attempt.id }).then(onLeft, () => undefined)
    if (flowRef.current === current) setFlow({ ...current, phase: 'form', attempt: null, code: '', taking: false, unopened: null })
  })
  const openAgain = (): Promise<void> => run(async current => { if (current.attempt) await openPage(current.attempt.id) })
  const copyCode = async (code: string): Promise<void> => {
    try { await writeClipboard(code); setCopied(true); setTimeout(() => setCopied(false), 1_500) } catch { update({ error: 'The code could not be copied. Select it and copy it yourself.' }) }
  }
  const copyAddress = async (address: string): Promise<void> => {
    try { await writeClipboard(address); setCopiedAddress(true); setTimeout(() => setCopiedAddress(false), 1_500) } catch { update({ error: 'The address could not be copied. Select it and copy it yourself.' }) }
  }

  const error = flow.error ? <p className="provider-detail__error" role="alert" id={errorId}>{flow.error}</p> : null
  const cancel = <Button variant="secondary" aria-label={`Cancel signing in to ${source.name}`} onClick={close}>Cancel</Button>
  const formFields = flow.phase === 'form' ? (method.form ?? []).filter(field => shown(field, flow.answers)).map(field => field.options?.length
    ? <fieldset key={field.key} className="oc-methods"><legend>{field.title}</legend>{field.options.map(choice => <label key={choice.value} className="oc-method">
      <input type="radio" name={`oc-field-${field.key}`} value={choice.value} checked={flow.answers[field.key] === choice.value}
        onChange={() => update({ answers: { ...flow.answers, [field.key]: choice.value }, error: null })} />
      <b>{choice.label}</b>{choice.description ? <small>{choice.description}</small> : null}</label>)}</fieldset>
    : <label key={field.key} className="oc-field">{field.title}{field.required ? null : <span className="oc-optional"> (optional)</span>}
      <input className="tt-input" type="text" value={flow.answers[field.key] ?? ''} placeholder={field.placeholder} autoComplete="off" spellCheck={false}
        aria-required={field.required || undefined} onChange={event => update({ answers: { ...flow.answers, [field.key]: event.target.value }, error: null })} />
      {field.description ? <small>{field.description}</small> : null}</label>) : null
  let body: ReactNode, actions: ReactNode
  if (method.kind === 'key') {
    const fieldLabel = method.label === 'API key' ? `${source.name} API key` : `${source.name} ${method.label.replace(/^(?!API)\w/u, letter => letter.toLowerCase())}`
    body = <>{formFields}
      <label className="oc-field">{fieldLabel}
        <input data-autofocus className="tt-input" type="password" value={flow.key} placeholder="Paste the key" autoComplete="off" spellCheck={false}
          aria-describedby={[flow.error ? errorId : '', noteId].filter(Boolean).join(' ')} aria-invalid={flow.error ? true : undefined}
          onChange={event => update({ key: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submitKey() } }} /></label>
      <p className="oc-keynote" id={noteId}>{host ? hostKeySentence(host) : KEY_SENTENCE}</p>{error}</>
    actions = <>{cancel}<Button variant="primary" aria-label={`Sign in to ${source.name} with this key`} disabled={busy || !flow.key.trim() || !answered(method, flow.answers)} onClick={() => void submitKey()}>{busy ? 'Signing in…' : 'Sign in'}</Button></>
  } else if (method.kind === 'external') {
    body = <>{formFields}<p className="oc-open">{aboutMethod(source, method, host)} Sotto’s OpenCode{on} reads it there, and Sotto keeps no copy.</p>{error}</>
    actions = <>{cancel}<Button data-autofocus={!(method.form?.length) || undefined} variant="primary" disabled={busy || !answered(method, flow.answers)} onClick={() => void useExternal()}>{`Use ${method.label.replace(/^\w/u, letter => letter.toLowerCase())}`}</Button></>
  } else if (flow.phase === 'waiting' && flow.attempt) {
    const attempt = flow.attempt, until = expiry(attempt.expiresAt)
    const status = (words: string): ReactNode => <p className="oc-wait__status" role="status"><span className="oc-pulse" aria-hidden="true" />{words}</p>
    // Where the page is: in the browser, or, when the browser did not open it, at the address shown to open by hand.
    const where = flow.unopened ? 'at the address below' : 'that opened in your browser'
    const address = flow.unopened ? <div className="oc-address"><code>{flow.unopened}</code>
      <Button variant="secondary" aria-label={`Copy the ${source.name} sign-in page address`} onClick={() => void copyAddress(flow.unopened!)}><Copy aria-hidden="true" size={14} />{copiedAddress ? 'Copied' : 'Copy address'}</Button></div> : null
    body = <><div className="oc-wait" role="group" aria-label={`Signing in to ${source.name}`}>
      {attempt.mode === 'code' ? <>
        <p>Approve on the {source.name} page {where}, then paste the code it shows.</p>
        {address}
        <label className="oc-field">Code from the {source.name} page
          <input data-autofocus className="tt-input" type="text" value={flow.code} placeholder="Paste the code" autoComplete="off" spellCheck={false}
            onChange={event => update({ code: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && flow.code.trim()) { event.preventDefault(); void finishCode() } }} /></label>
        <div className="oc-actions-inline"><Button variant="primary" aria-label={`Finish signing in to ${source.name} with this code`} disabled={busy || !flow.code.trim()} onClick={() => void finishCode()}>Finish signing in</Button></div>
        {flow.taking ? status(`Waiting for ${source.name} to take the code. This updates by itself.`) : null}
        {until ? <p className="oc-wait__status">The code works until {until}.</p> : null}
      </> : attempt.code ? <>
        <p>Enter this code on the {source.name} page {where}.</p>
        <div className="oc-code"><code>{attempt.code}</code>
          <Button data-autofocus variant="secondary" aria-label={`Copy the code ${attempt.code}`} onClick={() => void copyCode(attempt.code!)}><Copy aria-hidden="true" size={14} />{copied ? 'Copied' : 'Copy code'}</Button></div>
        {address ?? <p className="oc-site">{attempt.page}</p>}
        {status(`Waiting for ${source.name}. This updates by itself once you enter the code.${until ? ` It expires at ${until}.` : ''}`)}
      </> : <>
        <p>Finish signing in on the {source.name} page {where}.</p>
        {address ?? <p className="oc-site">{attempt.page}</p>}
        {status(`Waiting for ${source.name}. This updates by itself when you are done.${until ? ` It expires at ${until}.` : ''}`)}
      </>}
    </div>{error}</>
    actions = <><Button variant="secondary" aria-label={`Cancel signing in to ${source.name}`} disabled={busy} onClick={() => void stopWaiting()}>Cancel</Button>
      <Button data-autofocus={attempt.mode === 'auto' && !attempt.code ? true : undefined} variant="secondary" aria-label={`Open the ${source.name} sign-in page again`} onClick={() => void openAgain()}><ExternalLink aria-hidden="true" size={14} />Open the page again</Button></>
  } else if (unreachable.has(`${source.id}:${method.id}`)) {
    // On a host, a sign-in already found to finish on that machine is not offered again.
    body = <>{formFields}<p className="provider-detail__error" role="alert">{flow.error ?? opencodeSignInComesBack(host ?? 'the host')}</p></>
    actions = <>{cancel}<Button variant="primary" disabled aria-label={`${method.label} cannot finish from this computer`}><ExternalLink aria-hidden="true" size={14} />Open sign-in page</Button></>
  } else {
    body = <>{formFields}<p className="oc-open">Opens the {source.name} sign-in page in your browser{host ? ' on this computer' : ''}. Sotto’s OpenCode{on} keeps the sign-in in its own folder{host ? ' there' : ''}, and Sotto keeps no copy.</p>{error}</>
    actions = <>{cancel}<Button data-autofocus={!(method.form?.length) && source.methods.length < 2 ? true : undefined} variant="primary" aria-label={`Open the ${source.name} sign-in page in your browser`}
      disabled={busy || !answered(method, flow.answers)} onClick={() => void startBrowser()}><ExternalLink aria-hidden="true" size={14} />{busy ? 'Opening…' : flow.error ? 'Open sign-in page again' : 'Open sign-in page'}</Button></>
  }
  return <div className="tt-dialog-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className="tt-dialog oc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={aboutId} aria-busy={busy || undefined}>
      <div className="oc-dialog__body">
        <button type="button" className="oc-back" aria-label="Back to the list of model sources"
          onClick={() => { leave(); setFlow(null); queueMicrotask(() => searchRef.current?.focus()) }}>
          <ChevronLeft aria-hidden="true" size={14} />Model sources</button>
        <h2 id={titleId}>Sign in to {source.name}</h2>
        <p className="tt-dialog__description" id={aboutId}>Its models join the model menu under OpenCode{on}, billed to your {source.name} account.</p>
        {source.methods.length > 1 && flow.phase === 'form' ? <fieldset className="oc-methods"><legend>How to sign in</legend>{source.methods.map((choice, index) =>
          <label key={choice.id} className="oc-method"><input data-autofocus={index === flow.method || undefined} type="radio" name="oc-method" value={choice.id} checked={index === flow.method}
            onChange={() => setFlow(freshFlow(source, index))} /><b>{choice.label}</b><small>{unreachable.has(`${source.id}:${choice.id}`) ? `Finishes on ${host ?? 'the host'} itself, so not from this computer.` : aboutMethod(source, choice, host)}</small></label>)}</fieldset> : null}
        {body}
      </div>
      <div className="tt-dialog__actions">{actions}</div>
    </section>
  </div>
}
