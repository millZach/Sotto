import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Check, ChevronLeft, Copy, ExternalLink, Plus, Search } from 'lucide-react'
import { plural, t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import {
  COMMON_MODEL_SOURCES, KEY_SENTENCE, SIGN_IN_WORDS, hostKeySentence, opencodeSignInComesBack, type ModelSource, type ModelSourceField, type ModelSourceMethod, type ModelSources,
  type OpenCodeSignInBridge, type SignInAttempt, type SignInResult, type SignInWait,
} from '../../../shared/opencodeSignIn'
import { Button } from '../components/Button'
import { useDialogFocus } from '../components/useDialogFocus'
import { writeClipboard } from './richActions'
import './opencodeSources.css'

const countModels = (count: number): string => plural(count, { one: '# model', other: '# models' })
const byName = (a: ModelSource, b: ModelSource): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
const shortLabel = (method: ModelSourceMethod): string => method.kind !== 'key' ? method.label : /token/iu.test(method.label) ? /access/iu.test(method.label) ? t`Access token` : t`API token` : t`API key`
/** How a source signs in, in a few words: "API key or ChatGPT account". */
const howHint = (source: ModelSource): string => [...new Set(source.methods.map(shortLabel))]
  .reduce((list: string, item) => list ? t({ message: `${list} or ${item}`, comment: 'Ways to sign in to a model source, such as "API key or ChatGPT account".' }) : item, '')
  || t`No way to sign in from Sotto`
const isKey = (how: string): boolean => /key|token/iu.test(how)
const expiry = (at: number | undefined): string | undefined => at === undefined ? undefined
  : new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
function aboutMethod(source: ModelSource, method: ModelSourceMethod, host: string | undefined): string {
  if (method.kind === 'key') {
    const keyName = method.label.replace(/^(?!API)\w/u, letter => letter.toLowerCase())
    const sourceName = source.name
    // English chooses "a" or "an" by the key's own name, which comes from OpenCode.
    return /^[aeiou]/iu.test(method.label)
      ? t({ message: `Paste an ${keyName} from your ${sourceName} account.`, comment: '{keyName} is the kind of key, such as "API key", in OpenCode\'s words; {sourceName} is a model source, such as Anthropic.' })
      : t({ message: `Paste a ${keyName} from your ${sourceName} account.`, comment: '{keyName} is the kind of key, such as "API key", in OpenCode\'s words; {sourceName} is a model source, such as Anthropic.' })
  }
  if (method.kind === 'external') return host === undefined ? t`Uses a sign-in already on this computer.` : t({ message: `Uses a sign-in already on ${host}.`, comment: '{host} is the name of a saved host.' })
  return t`In your browser.`
}

/**
 * The bridge, with each answer that says a host did not answer (`answer-lost`) followed by `lost`: the host may have signed
 * in or out all the same, so the list is read again and shown (#1107). Reading the list is never followed, so it cannot loop.
 */
function rereadingAfterLostAnswers(bridge: OpenCodeSignInBridge, lost: () => void): OpenCodeSignInBridge {
  const after = <T,>(answer: Promise<T>): Promise<T> => answer.then(result => {
    if ((result as { readonly reason?: string }).reason === 'answer-lost') lost()
    return result
  })
  return {
    sources: () => bridge.sources(),
    signInWithKey: request => after(bridge.signInWithKey(request)), startBrowserSignIn: request => after(bridge.startBrowserSignIn(request)),
    useExternalSignIn: request => after(bridge.useExternalSignIn(request)), wait: request => after(bridge.wait(request)),
    finish: request => after(bridge.finish(request)), reopen: request => after(bridge.reopen(request)),
    cancel: request => after(bridge.cancel(request)), signOut: request => after(bridge.signOut(request)),
  }
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
  const { t } = useLingui()
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
  // After a host's lost answer only a list it could read replaces the one shown, so the dialog stays open over it.
  const rereadShown = useCallback((): void => { void bridge.sources().then(next => { if (next.status === 'ok') setRead(next) }, () => undefined) }, [bridge])
  const checked = useMemo(() => rereadingAfterLostAnswers(bridge, rereadShown), [bridge, rereadShown])
  const sources = read?.status === 'ok' ? read.sources : []
  const signed = sources.filter(source => source.signedIn)
  const signOut = async (source: ModelSource): Promise<void> => {
    setSigningOut(source.id); setError(null); setNotice('')
    const key = isKey(source.signedIn?.how ?? '')
    try {
      const result = await checked.signOut({ sourceId: source.id })
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
    <h4 id={headingId}>{host ? t({ message: `OpenCode model sources on ${host}`, comment: '{host} is the name of a saved host.' }) : t`Model sources`}</h4>
    {read === null ? <p className="oc-empty tt-paragraph" role="status">{host ? t({ message: `Reading what Sotto’s OpenCode on ${host} is signed in to…`, comment: '{host} is the name of a saved host.' }) : t`Reading what Sotto’s OpenCode is signed in to…`}</p> : null}
    {read?.status === 'refused' ? <p className="provider-detail__error" role="alert">{read.message}</p> : null}
    {read?.status === 'ok' ? <>
      <ul className="oc-list" ref={listRef} aria-label={host ? t({ message: `Model sources Sotto’s OpenCode on ${host} can use`, comment: '{host} is the name of a saved host.' }) : t`Model sources Sotto’s OpenCode can use`}>
        <li><span className="oc-src"><strong>OpenCode Zen</strong><small>{t`Free models. No sign-in needed.`}</small></span><span className="oc-count">{countModels(read.zenModels)}</span></li>
        {signed.map(source => {
          const sourceName = source.name
          return <li key={source.id}>
            <span className="oc-src"><strong>{source.name}</strong><small>{source.signedIn!.how}</small></span>
            <span className="oc-count">{countModels(source.models)}</span>
            <Button variant="ghost" aria-label={host ? t({ message: `Sign out of ${sourceName} on ${host}`, comment: '{sourceName} is a model source; {host} is the name of a saved host.' }) : t({ message: `Sign out of ${sourceName}`, comment: '{sourceName} is a model source, such as Anthropic.' })} disabled={signingOut !== null} onClick={() => void signOut(source)}>{signingOut === source.id ? t`Signing out…` : t`Sign out`}</Button>
          </li>
        })}
      </ul>
      {!signed.length ? <p className="oc-empty tt-paragraph">{host ? t({ message: `Sign in to a model source, such as Anthropic, OpenAI or OpenRouter, to use its models in OpenCode threads on ${host}. That account pays for them.`, comment: '{host} is the name of a saved host.' }) : t`Sign in to a model source, such as Anthropic, OpenAI or OpenRouter, to use its models in OpenCode threads. That account pays for them.`}</p> : null}
      <div className="oc-below"><Button ref={addRef} variant="secondary" aria-haspopup="dialog" aria-expanded={open} aria-label={host ? t({ message: `Add a model source to OpenCode on ${host}`, comment: '{host} is the name of a saved host.' }) : undefined} onClick={() => { setNotice(''); setError(null); setOpen(true) }}><Plus aria-hidden="true" size={14} />{t`Add a model source`}</Button></div>
    </> : null}
    <p className="oc-notice tt-paragraph" role="status">{notice}</p>
    {error ? <p className="provider-detail__error" role="alert">{error}</p> : null}
    {open && read?.status === 'ok' ? <AddModelSourceDialog bridge={checked} sources={read.sources} pollMs={pollMs} fallbackFocus={addRef} host={host}
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
  const { t } = useLingui()
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
  // The newest bridge and tile callback, for leaving: Settings makes a host's bridge again whenever what it is made from
  // changes, and that is no reason to end a sign-in.
  const latest = useRef({ bridge, onLeft })
  useEffect(() => { latest.current = { bridge, onLeft } }, [bridge, onLeft])
  /** Cancels the waiting browser sign-in, if there is one; one OpenCode finished meanwhile is kept, so the list is read again. */
  const leave = useCallback((): void => {
    const attempt = flowRef.current?.attempt
    // A start or a key still answering finds no flow: a start cancels its sign-in and opens no page, and a key's answer
    // still reaches the tile.
    flowRef.current = null
    const { bridge: current, onLeft: left } = latest.current
    if (attempt) void current.cancel({ attemptId: attempt.id }).then(left, () => undefined)
  }, [])
  const close = useCallback((): void => { leave(); onClose() }, [leave, onClose])
  // Settings closing under the dialog ends a waiting sign-in as Cancel does; only the dialog going away does.
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
    const how = source.signedIn ? t`Signed in` : howHint(source)
    const sourceName = source.name
    return <button key={source.id} type="button" role="option" aria-selected="false" tabIndex={-1} className="oc-opt" aria-disabled={unavailable || undefined}
      aria-label={source.signedIn ? t({ message: `${sourceName}, already signed in`, comment: '{sourceName} is a model source, such as Anthropic.' }) : t({ message: `${sourceName}, ${how}`, comment: '{sourceName} is a model source; {how} is how it signs in, such as "API key".' })} onClick={() => pick(source)}>
      <span className="oc-opt__name">{source.name}</span><span className="oc-opt__how">{source.signedIn ? <Check aria-hidden="true" size={13} /> : null}{how}</span>
    </button>
  }

  if (!flow) {
    const sourceCount = sources.length
    const typed = query.trim()
    const restName = typed ? t`More matches` : t`Every model source, A to Z`
    const commonName = t({ message: 'Common', comment: 'A heading over the model sources most people use.' })
    return <div className="tt-dialog-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
      <section ref={dialogRef} className="tt-dialog oc-dialog oc-dialog--pick" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={aboutId}>
        <h2 id={titleId}>{host ? t({ message: `Add a model source to OpenCode on ${host}`, comment: '{host} is the name of a saved host.' }) : t`Add a model source`}</h2>
        <p className="tt-dialog__description tt-paragraph" id={aboutId}>{host ? t({ message: `Sign Sotto’s OpenCode on ${host} in to a model source to use its models in OpenCode threads there. That account pays for them.`, comment: '{host} is the name of a saved host.' }) : t`Sign Sotto’s OpenCode in to a model source to use its models in OpenCode threads. That account pays for them.`}</p>
        <div className="oc-search"><Search aria-hidden="true" size={14} />
          <input ref={searchRef} type="text" aria-label={t`Search model sources`} aria-controls={listId} placeholder={plural(sourceCount, { one: 'Search # model source', other: 'Search # model sources' })}
            value={query} autoComplete="off" spellCheck={false} onChange={event => setQuery(event.target.value)} onKeyDown={onSearchKey} /></div>
        <div ref={listRef} className="oc-pick" role="listbox" id={listId} aria-label={t`Model sources`} onKeyDown={onListKey}>
          {shownCommon.length ? <div role="group" aria-label={commonName}><div className="oc-group-head" aria-hidden="true">{commonName}</div>{shownCommon.map(option)}</div> : null}
          {rest.length ? <div role="group" aria-label={restName}><div className="oc-group-head" aria-hidden="true">{restName}</div>{rest.map(option)}</div> : null}
          {!shownCommon.length && !rest.length ? <p className="oc-none tt-paragraph" role="status">{t({ message: `No model source matches “${typed}”.`, comment: '{typed} is what the user typed in the search field.' })}</p> : null}
        </div>
        <div className="tt-dialog__actions"><Button variant="secondary" aria-label={t`Close without adding a model source`} onClick={close}>{t`Cancel`}</Button></div>
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
      // The answer says why, by its reason and never its words: one that finishes on the host is not offered again.
      if (host && result.reason === 'finishes-on-host') onUnreachable?.(`${source.id}:${method.id}`)
      setFlow({ ...current, error: result.message }); return
    }
    setFlow({ ...current, phase: 'waiting', attempt: result.attempt, error: null, code: '', taking: false, unopened: null })
    await openPage(result.attempt.id)
  })
  const finishCode = (): Promise<void> => run(async current => {
    if (!current.attempt || !current.code.trim()) return
    const result = await bridge.finish({ attemptId: current.attempt.id, code: current.code.trim() })
    if (result.status === 'pending') { if (flowRef.current === current) setFlow({ ...current, taking: true }); return }
    // A refused code is told by the answer's reason, never its words: the sign-in stays open for another one.
    if (result.status === 'refused' && flowRef.current === current && result.reason === 'code-refused') { setFlow({ ...current, code: '', taking: false, error: result.message }); return }
    finish(result, current)
  })
  const stopWaiting = (): Promise<void> => run(async current => {
    if (current.attempt) await bridge.cancel({ attemptId: current.attempt.id }).then(onLeft, () => undefined)
    if (flowRef.current === current) setFlow({ ...current, phase: 'form', attempt: null, code: '', taking: false, unopened: null })
  })
  const openAgain = (): Promise<void> => run(async current => { if (current.attempt) await openPage(current.attempt.id) })
  const copyCode = async (code: string): Promise<void> => {
    try { await writeClipboard(code); setCopied(true); setTimeout(() => setCopied(false), 1_500) } catch { update({ error: t`The code could not be copied. Select it and copy it yourself.` }) }
  }
  const copyAddress = async (address: string): Promise<void> => {
    try { await writeClipboard(address); setCopiedAddress(true); setTimeout(() => setCopiedAddress(false), 1_500) } catch { update({ error: t`The address could not be copied. Select it and copy it yourself.` }) }
  }

  const error = flow.error ? <p className="provider-detail__error" role="alert" id={errorId}>{flow.error}</p> : null
  const sourceName = source.name
  const cancelSigningIn = t({ message: `Cancel signing in to ${sourceName}`, comment: '{sourceName} is a model source, such as Anthropic.' })
  const cancel = <Button variant="secondary" aria-label={cancelSigningIn} onClick={close}>{t`Cancel`}</Button>
  const formFields = flow.phase === 'form' ? (method.form ?? []).filter(field => shown(field, flow.answers)).map(field => field.options?.length
    ? <fieldset key={field.key} className="oc-methods"><legend>{field.title}</legend>{field.options.map(choice => <label key={choice.value} className="oc-method">
      <input type="radio" name={`oc-field-${field.key}`} value={choice.value} checked={flow.answers[field.key] === choice.value}
        onChange={() => update({ answers: { ...flow.answers, [field.key]: choice.value }, error: null })} />
      <b>{choice.label}</b>{choice.description ? <small>{choice.description}</small> : null}</label>)}</fieldset>
    : <label key={field.key} className="oc-field">{field.title}{field.required ? null : <span className="oc-optional"> {t`(optional)`}</span>}
      <input className="tt-input" type="text" value={flow.answers[field.key] ?? ''} placeholder={field.placeholder} autoComplete="off" spellCheck={false}
        aria-required={field.required || undefined} onChange={event => update({ answers: { ...flow.answers, [field.key]: event.target.value }, error: null })} />
      {field.description ? <small>{field.description}</small> : null}</label>) : null
  let body: ReactNode, actions: ReactNode
  if (method.kind === 'key') {
    const keyName = method.label.replace(/^(?!API)\w/u, letter => letter.toLowerCase())
    const fieldLabel = method.label === 'API key'
      ? t({ message: `${sourceName} API key`, comment: '{sourceName} is a model source, such as Anthropic.' })
      : t({ message: `${sourceName} ${keyName}`, comment: 'A key field\'s label: {sourceName} is a model source; {keyName} is the kind of key, in OpenCode\'s words.' })
    body = <>{formFields}
      <label className="oc-field">{fieldLabel}
        <input data-autofocus className="tt-input" type="password" value={flow.key} placeholder={t`Paste the key`} autoComplete="off" spellCheck={false}
          aria-describedby={[flow.error ? errorId : '', noteId].filter(Boolean).join(' ')} aria-invalid={flow.error ? true : undefined}
          onChange={event => update({ key: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submitKey() } }} /></label>
      <p className="oc-keynote tt-paragraph" id={noteId}>{host ? hostKeySentence(host) : KEY_SENTENCE}</p>{error}</>
    actions = <>{cancel}<Button variant="primary" aria-label={t({ message: `Sign in to ${sourceName} with this key`, comment: '{sourceName} is a model source, such as Anthropic.' })} disabled={busy || !flow.key.trim() || !answered(method, flow.answers)} onClick={() => void submitKey()}>{busy ? t`Signing in…` : t`Sign in`}</Button></>
  } else if (method.kind === 'external') {
    const about = aboutMethod(source, method, host)
    const methodName = method.label.replace(/^\w/u, letter => letter.toLowerCase())
    body = <>{formFields}<p className="oc-open tt-paragraph">{host
      ? t({ message: `${about} Sotto’s OpenCode on ${host} reads it there, and Sotto keeps no copy.`, comment: '{about} is a sentence saying where the sign-in is; {host} is the name of a saved host.' })
      : t({ message: `${about} Sotto’s OpenCode reads it there, and Sotto keeps no copy.`, comment: '{about} is a sentence saying where the sign-in is.' })}</p>{error}</>
    actions = <>{cancel}<Button data-autofocus={!(method.form?.length) || undefined} variant="primary" disabled={busy || !answered(method, flow.answers)} onClick={() => void useExternal()}>{t({ message: `Use ${methodName}`, comment: '{methodName} is a way to sign in, in OpenCode\'s words, such as "ChatGPT account".' })}</Button></>
  } else if (flow.phase === 'waiting' && flow.attempt) {
    const attempt = flow.attempt, until = expiry(attempt.expiresAt)
    const status = (words: string): ReactNode => <p className="oc-wait__status" role="status"><span className="oc-pulse" aria-hidden="true" />{words}</p>
    // Where the page is: in the browser, or, when the browser did not open it, at the address shown to open by hand.
    const unopened = flow.unopened !== null && flow.unopened !== ''
    const address = flow.unopened ? <div className="oc-address"><code>{flow.unopened}</code>
      <Button variant="secondary" aria-label={t({ message: `Copy the ${sourceName} sign-in page address`, comment: '{sourceName} is a model source, such as Anthropic.' })} onClick={() => void copyAddress(flow.unopened!)}><Copy aria-hidden="true" size={14} />{copiedAddress ? t`Copied` : t`Copy address`}</Button></div> : null
    const code = attempt.code ?? ''
    body = <><div className="oc-wait" role="group" aria-label={t({ message: `Signing in to ${sourceName}`, comment: '{sourceName} is a model source, such as Anthropic.' })}>
      {attempt.mode === 'code' ? <>
        <p className="tt-paragraph">{unopened
          ? t({ message: `Approve on the ${sourceName} page at the address below, then paste the code it shows.`, comment: '{sourceName} is a model source, such as Anthropic.' })
          : t({ message: `Approve on the ${sourceName} page that opened in your browser, then paste the code it shows.`, comment: '{sourceName} is a model source, such as Anthropic.' })}</p>
        {address}
        <label className="oc-field">{t({ message: `Code from the ${sourceName} page`, comment: '{sourceName} is a model source, such as Anthropic.' })}
          <input data-autofocus className="tt-input" type="text" value={flow.code} placeholder={t`Paste the code`} autoComplete="off" spellCheck={false}
            onChange={event => update({ code: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && flow.code.trim()) { event.preventDefault(); void finishCode() } }} /></label>
        <div className="oc-actions-inline"><Button variant="primary" aria-label={t({ message: `Finish signing in to ${sourceName} with this code`, comment: '{sourceName} is a model source, such as Anthropic.' })} disabled={busy || !flow.code.trim()} onClick={() => void finishCode()}>{t`Finish signing in`}</Button></div>
        {flow.taking ? status(t({ message: `Waiting for ${sourceName} to take the code. This updates by itself.`, comment: '{sourceName} is a model source, such as Anthropic.' })) : null}
        {until ? <p className="oc-wait__status tt-paragraph">{t({ message: `The code works until ${until}.`, comment: '{until} is a time of day.' })}</p> : null}
      </> : attempt.code ? <>
        <p className="tt-paragraph">{unopened
          ? t({ message: `Enter this code on the ${sourceName} page at the address below.`, comment: '{sourceName} is a model source, such as Anthropic.' })
          : t({ message: `Enter this code on the ${sourceName} page that opened in your browser.`, comment: '{sourceName} is a model source, such as Anthropic.' })}</p>
        <div className="oc-code"><code>{attempt.code}</code>
          <Button data-autofocus variant="secondary" aria-label={t({ message: `Copy the code ${code}`, comment: '{code} is the sign-in code itself.' })} onClick={() => void copyCode(attempt.code!)}><Copy aria-hidden="true" size={14} />{copied ? t`Copied` : t`Copy code`}</Button></div>
        {address ?? <p className="oc-site">{attempt.page}</p>}
        {status(until
          ? t({ message: `Waiting for ${sourceName}. This updates by itself once you enter the code. It expires at ${until}.`, comment: '{sourceName} is a model source; {until} is a time of day.' })
          : t({ message: `Waiting for ${sourceName}. This updates by itself once you enter the code.`, comment: '{sourceName} is a model source, such as Anthropic.' }))}
      </> : <>
        <p className="tt-paragraph">{unopened
          ? t({ message: `Finish signing in on the ${sourceName} page at the address below.`, comment: '{sourceName} is a model source, such as Anthropic.' })
          : t({ message: `Finish signing in on the ${sourceName} page that opened in your browser.`, comment: '{sourceName} is a model source, such as Anthropic.' })}</p>
        {address ?? <p className="oc-site">{attempt.page}</p>}
        {status(until
          ? t({ message: `Waiting for ${sourceName}. This updates by itself when you are done. It expires at ${until}.`, comment: '{sourceName} is a model source; {until} is a time of day.' })
          : t({ message: `Waiting for ${sourceName}. This updates by itself when you are done.`, comment: '{sourceName} is a model source, such as Anthropic.' }))}
      </>}
    </div>{error}</>
    actions = <><Button variant="secondary" aria-label={cancelSigningIn} disabled={busy} onClick={() => void stopWaiting()}>{t`Cancel`}</Button>
      <Button data-autofocus={attempt.mode === 'auto' && !attempt.code ? true : undefined} variant="secondary" aria-label={t({ message: `Open the ${sourceName} sign-in page again`, comment: '{sourceName} is a model source, such as Anthropic.' })} onClick={() => void openAgain()}><ExternalLink aria-hidden="true" size={14} />{t`Open the page again`}</Button></>
  } else if (unreachable.has(`${source.id}:${method.id}`)) {
    // On a host, a sign-in already found to finish on that machine is not offered again.
    const methodLabel = method.label
    body = <>{formFields}<p className="provider-detail__error tt-paragraph" role="alert">{flow.error ?? opencodeSignInComesBack(host ?? t({ message: 'the host', comment: 'Stands for a saved host whose name is not known, inside a sentence.' }))}</p></>
    actions = <>{cancel}<Button variant="primary" disabled aria-label={t({ message: `${methodLabel} cannot finish from this computer`, comment: '{methodLabel} is a way to sign in, in OpenCode\'s words.' })}><ExternalLink aria-hidden="true" size={14} />{t`Open sign-in page`}</Button></>
  } else {
    body = <>{formFields}<p className="oc-open tt-paragraph">{host
      ? t({ message: `Opens the ${sourceName} sign-in page in your browser on this computer. Sotto’s OpenCode on ${host} keeps the sign-in in its own folder there, and Sotto keeps no copy.`, comment: '{sourceName} is a model source; {host} is the name of a saved host.' })
      : t({ message: `Opens the ${sourceName} sign-in page in your browser. Sotto’s OpenCode keeps the sign-in in its own folder, and Sotto keeps no copy.`, comment: '{sourceName} is a model source, such as Anthropic.' })}</p>{error}</>
    actions = <>{cancel}<Button data-autofocus={!(method.form?.length) && source.methods.length < 2 ? true : undefined} variant="primary" aria-label={t({ message: `Open the ${sourceName} sign-in page in your browser`, comment: '{sourceName} is a model source, such as Anthropic.' })}
      disabled={busy || !answered(method, flow.answers)} onClick={() => void startBrowser()}><ExternalLink aria-hidden="true" size={14} />{busy ? t`Opening…` : flow.error ? t`Open sign-in page again` : t`Open sign-in page`}</Button></>
  }
  const hostName = host ?? t({ message: 'the host', comment: 'Stands for a saved host whose name is not known, inside a sentence.' })
  return <div className="tt-dialog-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className="tt-dialog oc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={aboutId} aria-busy={busy || undefined}>
      <div className="oc-dialog__body">
        <button type="button" className="oc-back" aria-label={t`Back to the list of model sources`}
          onClick={() => { leave(); setFlow(null); queueMicrotask(() => searchRef.current?.focus()) }}>
          <ChevronLeft aria-hidden="true" size={14} />{t`Model sources`}</button>
        <h2 id={titleId}>{t({ message: `Sign in to ${sourceName}`, comment: '{sourceName} is a model source, such as Anthropic.' })}</h2>
        <p className="tt-dialog__description tt-paragraph" id={aboutId}>{host
          ? t({ message: `Its models join the model menu under OpenCode on ${host}, billed to your ${sourceName} account.`, comment: '{host} is the name of a saved host; {sourceName} is a model source.' })
          : t({ message: `Its models join the model menu under OpenCode, billed to your ${sourceName} account.`, comment: '{sourceName} is a model source, such as Anthropic.' })}</p>
        {source.methods.length > 1 && flow.phase === 'form' ? <fieldset className="oc-methods"><legend>{t`How to sign in`}</legend>{source.methods.map((choice, index) =>
          <label key={choice.id} className="oc-method"><input data-autofocus={index === flow.method || undefined} type="radio" name="oc-method" value={choice.id} checked={index === flow.method}
            onChange={() => setFlow(freshFlow(source, index))} /><b>{choice.label}</b><small>{unreachable.has(`${source.id}:${choice.id}`) ? t({ message: `Finishes on ${hostName} itself, so not from this computer.`, comment: '{hostName} is the name of a saved host, or "the host".' }) : aboutMethod(source, choice, host)}</small></label>)}</fieldset> : null}
        {body}
      </div>
      <div className="tt-dialog__actions">{actions}</div>
    </section>
  </div>
}
