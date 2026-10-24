import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Server } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import {
  OWN_SERVER_CONTEXT_MAX, OWN_SERVER_CONTEXT_MIN, OWN_SERVER_KEY_MAX, ownServerAddress,
  type CheckResult, type FoundModel, type OwnServer, type OwnServerKind, type OwnServerRefusal, type OwnServersBridge,
} from '../../../shared/ownModelServers'
import {
  addedWords, answeredWords, checkedAgainWords, contextRange, contextUnknown, keyKeptWords, keyNote, kindName, modelCount, notAnswered, notAnsweredSaved,
  privacyWords, refusalWords, removedWords, removeFailed, type OwnServerDoing,
} from './ownServerWords'
import { Button } from '../components/Button'
import { useDialogFocus } from '../components/useDialogFocus'
import { useOwlFeature } from '../state/owlFeature'
import { SettingsGroup } from '../features/settings/SettingsGroup'
import './ownServers.css'

/**
 * Your own model servers (ADR-0124), phase 1: the bridge, only while the `own-model-servers` Owl feature is on and main
 * gave the window one. Every part of the feature asks this before it exists.
 */
export function useOwnServersBridge(): OwnServersBridge | undefined {
  return useOwlFeature('own-model-servers') ? window.sotto?.ownServers : undefined
}

/** The host and port of a saved address, which refusals name. */
const hostOf = (address: string): string => { try { return new URL(address).host } catch { return address } }

const isLoopback = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || /^127\./u.test(host) || host === '[::1]' || host === '::1'
const isIp = (host: string): boolean => /^[\d.]+$/u.test(host) || host.startsWith('[')
/**
 * The name a server gets when the user gives none: the host's first label (`spark-head` for spark-head.tail1234.ts.net),
 * an address as it is, or, on this computer, the kind of server once a check has said it.
 */
export function ownServerName(typed: string, kind?: OwnServerKind): string {
  const parsed = ownServerAddress(typed)
  if (!parsed.ok) return ''
  const host = new URL(parsed.address).hostname
  if (isLoopback(host) && kind && kind !== 'openai-compatible') return kindName(kind)
  return (isIp(host) ? host.replace(/^\[|\]$/gu, '') : host.split('.')[0] ?? host).slice(0, 80)
}

/** A context as typed: digits, with commas, spaces or underscores, and K or M for 1,024 or 1,048,576. Null when it is not one. */
export function parseContext(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([km])?$/iu.exec(text.trim().replace(/[,\s_]/gu, ''))
  if (!match) return null
  const unit = match[2]?.toLowerCase()
  const value = Math.round(Number(match[1]) * (unit === 'm' ? 1_048_576 : unit === 'k' ? 1_024 : 1))
  return Number.isSafeInteger(value) && value >= OWN_SERVER_CONTEXT_MIN && value <= OWN_SERVER_CONTEXT_MAX ? value : null
}

/** Where focus goes after a refusal: the field that can put it right, or nowhere new. */
const fieldFor = (reason: OwnServerRefusal): 'address' | 'key' | null =>
  reason === 'bad-address' || reason === 'public-http' || reason === 'unreachable' || reason === 'not-openai' || reason === 'already-added' ? 'address'
    : reason === 'key-needed' || reason === 'key-refused' ? 'key' : null

/**
 * The Your own model servers group on Settings › Providers, above the provider tiles (layout B of
 * `prototype/local-model-server`): each saved server with Check again and Remove, and Add a server, which opens the
 * dialog. Sotto contacts a server only on a press, so a row says only what the last check on this window found.
 */
export function OwnModelServers({ bridge }: { readonly bridge: OwnServersBridge }): ReactNode {
  const { t } = useLingui()
  const [servers, setServers] = useState<readonly OwnServer[] | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** What the last Check again on this window found, by server. */
  const [checks, setChecks] = useState<Readonly<Record<string, { readonly tone: 'ok' | 'bad'; readonly words: string }>>>({})
  const [busy, setBusy] = useState<{ readonly id: string; readonly doing: 'check' | 'remove' } | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** After a remove, focus moves to the next row's first button, or to Add a server when none is left. */
  const refocusAt = useRef<number | null>(null)
  /** The button a press disabled while it ran, which takes focus back once it is enabled again. */
  const pressed = useRef<HTMLElement | null>(null)
  const [reads, setReads] = useState(0)
  useEffect(() => {
    let live = true
    setReadFailed(false)
    void bridge.list().then(list => { if (live) setServers(list) }, () => { if (live) { setServers([]); setReadFailed(true) } })
    return () => { live = false }
  }, [bridge, reads])
  useEffect(() => {
    if (busy || !pressed.current) return
    const button = pressed.current
    pressed.current = null
    if (button.isConnected && (document.activeElement === null || document.activeElement === document.body)) button.focus()
  }, [busy])
  useEffect(() => {
    if (refocusAt.current === null || busy) return
    const rows = [...listRef.current?.querySelectorAll<HTMLElement>(':scope > li') ?? []]
    const row = rows[Math.min(refocusAt.current, rows.length - 1)]
    refocusAt.current = null
    ;(row?.querySelector<HTMLButtonElement>('button') ?? addRef.current)?.focus()
  }, [servers, busy])

  const checkAgain = async (server: OwnServer): Promise<void> => {
    if (busy) return
    pressed.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy({ id: server.id, doing: 'check' }); setNotice(''); setError(null)
    let outcome: { readonly tone: 'ok' | 'bad'; readonly words: string }
    try { outcome = checkedWords(server, await bridge.checkSaved({ id: server.id })) } catch { outcome = { tone: 'bad', words: notAnsweredSaved() } }
    setChecks(current => ({ ...current, [server.id]: outcome }))
    setBusy(null)
  }
  const remove = async (server: OwnServer, index: number): Promise<void> => {
    if (busy) return
    setBusy({ id: server.id, doing: 'remove' }); setNotice(''); setError(null)
    try {
      const result = await bridge.remove({ id: server.id })
      if (result.status === 'ok') {
        setServers(current => (current ?? []).filter(item => item.id !== server.id))
        setChecks(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== server.id)))
        setNotice(removedWords(server.name))
        refocusAt.current = index
      } else setError(refusalWords(result.reason, 'remove', hostOf(server.address), server.name, result.message))
    } catch { setError(removeFailed(server.name)) } finally { setBusy(null) }
  }
  const added = useCallback((server: OwnServer): void => {
    setServers(current => [...(current ?? []).filter(item => item.id !== server.id), server])
    setNotice(addedWords(server.name)); setError(null)
  }, [])

  return <SettingsGroup title={t`Your own model servers`} icon={Server} rows={false}
    note={t`Model servers you run, such as Ollama, LM Studio, vLLM or SGLang, on this computer, your network or your tailnet. OpenCode threads can use their models. Sotto contacts a server only when you check or add it.`}>
    <div className="own-servers" data-setting="own-model-servers" aria-busy={servers === null}>
      {servers === null ? <p className="own-servers__empty tt-paragraph" role="status">{t`Reading your servers…`}</p>
        : readFailed ? <div className="own-servers__failed"><p className="provider-detail__error tt-paragraph" role="alert">{t`Sotto could not read your saved servers. Nothing was changed. Try again.`}</p>
          <Button variant="secondary" aria-label={t`Read your saved servers again`} onClick={() => { setServers(null); setReads(count => count + 1) }}>{t`Try again`}</Button></div>
        : servers.length === 0 ? <p className="own-servers__empty tt-paragraph">{t`None yet. Add a model server you run to use its models in OpenCode threads.`}</p>
        : <ul className="own-servers__rows" ref={listRef} aria-label={t`Saved model servers`}>{servers.map((server, index) => {
          const check = checks[server.id]
          const name = server.name
          const working = busy?.id === server.id ? busy.doing : null
          return <li key={server.id} className="own-server" aria-busy={working !== null || undefined}>
            <div className="own-server__name"><strong>{server.name}</strong><span className="own-server__address">{server.address}</span></div>
            <div className="own-server__actions">
              <Button variant="secondary" aria-label={t`Check ${name} again`} disabled={busy !== null} onClick={() => void checkAgain(server)}>{working === 'check' ? t`Checking…` : t`Check again`}</Button>
              <Button variant="ghost" aria-label={t`Remove ${name}`} disabled={busy !== null} onClick={() => void remove(server, index)}>{working === 'remove' ? t`Removing…` : t`Remove`}</Button>
            </div>
            <p className="own-server__meta">{[t`Runs with OpenCode`, modelCount(server.models.length), server.keyed ? t`Key kept by OpenCode` : ''].filter(Boolean).join(' · ')}</p>
            {check ? <p className="own-server__check tt-paragraph" data-tone={check.tone} role={check.tone === 'bad' ? 'alert' : 'status'}>{check.tone === 'ok' ? <i aria-hidden="true" /> : null}{check.words}</p> : null}
          </li>
        })}</ul>}
      <div className="own-servers__below">
        <Button ref={addRef} variant="secondary" aria-haspopup="dialog" aria-expanded={open} disabled={servers === null}
          onClick={() => { setNotice(''); setError(null); setOpen(true) }}><Plus aria-hidden="true" size={14} />{t`Add a server`}</Button>
      </div>
      <p className="own-servers__notice tt-paragraph" role="status">{notice}</p>
      {error ? <p className="provider-detail__error tt-paragraph" role="alert">{error}</p> : null}
    </div>
    {open ? <AddOwnServerDialog bridge={bridge} fallbackFocus={addRef} onClose={() => setOpen(false)} onAdded={server => { added(server); setOpen(false) }}
      onListChanged={() => setReads(count => count + 1)} /> : null}
  </SettingsGroup>
}

/** What Check again found on a saved server, in words. Its saved models are not changed until it is added again. */
function checkedWords(server: OwnServer, result: CheckResult): { readonly tone: 'ok' | 'bad'; readonly words: string } {
  if (result.status !== 'ok') return { tone: 'bad', words: refusalWords(result.reason, 'check-saved', hostOf(server.address), server.name, result.message) }
  // A server added with a key asks for it again, and only OpenCode has it: the models shown are the saved ones, unread.
  if (result.keyKept) return { tone: 'ok', words: keyKeptWords(server.name, result.answeredMs) }
  const found = new Set(result.models.map(model => model.id)), saved = new Set(server.models.map(model => model.id))
  const extra = result.models.filter(model => !saved.has(model.id)).map(model => model.name)
  const gone = server.models.filter(model => !found.has(model.id)).map(model => model.name)
  return { tone: 'ok', words: checkedAgainWords(result.kind, result.answeredMs, gone, extra) }
}

/**
 * The last row of OpenCode's model sources in a thread's model menu (C's shortcut in `prototype/local-model-server`):
 * Your own server…, which opens the Add a server dialog. The menu moves focus through its rows itself.
 */
export function OwnServerMenuEntry({ onPress }: { readonly onPress: () => void }): ReactNode {
  const { t } = useLingui()
  return <button type="button" className="model-picker__own" tabIndex={-1} aria-haspopup="dialog" aria-label={t`Your own server: add a model server you run`} onClick={onPress}>
    <Plus size={14} aria-hidden="true" /><span><b>{t`Your own server…`}</b><small>SGLang, vLLM, Ollama, LM Studio, llama.cpp</small></span>
  </button>
}

/** A model the check found, as the dialog edits it. */
interface Draft { readonly found: FoundModel; readonly context: string; readonly thinking: boolean }
type Checked = { readonly phase: 'running' } | { readonly phase: 'done'; readonly result: CheckResult & { readonly status: 'ok' } }

/**
 * Add a server: Address, Name and an optional Key, then Check this server, which asks main to check it. A server that
 * answers shows what answered and each model with its context and Thinking; Add server saves it. In phase 1 OpenCode is
 * the only provider that runs servers, so there is no Run it with step. A refusal is said in the dialog and every field
 * keeps what was typed. Focus stays inside, and Escape closes and hands focus back. With `confirm`, used from the model
 * menu, the dialog says where the models are and waits for Done instead of closing on Add.
 */
export function AddOwnServerDialog({ bridge, fallbackFocus, onClose, onAdded, confirm = false, onListChanged }: {
  readonly bridge: OwnServersBridge
  readonly fallbackFocus?: RefObject<HTMLElement | null> | undefined
  readonly onClose: () => void
  /** The server main saved. Called even when the dialog was closed before main answered, since the server is saved. */
  readonly onAdded?: ((server: OwnServer) => void) | undefined
  readonly confirm?: boolean
  /** Main's list changed though the add was refused, as when a server stayed saved without its key. */
  readonly onListChanged?: (() => void) | undefined
}): ReactNode {
  const { t } = useLingui()
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false)
  const [key, setKey] = useState('')
  const [addressShown, setAddressShown] = useState(false)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [drafts, setDrafts] = useState<readonly Draft[]>([])
  const [refusal, setRefusal] = useState<{ readonly words: string; readonly field: 'address' | 'key' | null } | null>(null)
  const [adding, setAdding] = useState(false)
  const [done, setDone] = useState<OwnServer | null>(null)
  const addressRef = useRef<HTMLInputElement>(null), keyRef = useRef<HTMLInputElement>(null)
  const checkRef = useRef<HTMLButtonElement>(null), addRef = useRef<HTMLButtonElement>(null), doneRef = useRef<HTMLButtonElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  /** The check whose answer is still wanted: one asked for an address or key since changed, or after closing, is dropped. */
  const asked = useRef(0)
  const focusResults = useRef(false)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const titleId = useId(), aboutId = useId(), addressId = useId(), addressNoteId = useId(), addressErrorId = useId(), nameId = useId(), nameNoteId = useId(), keyId = useId(),
    keyNoteId = useId(), refusalId = useId(), privacyId = useId()
  // While an add is with main, nothing closes the dialog: it closes, or says the refusal, when main answers.
  const close = (): void => { if (!adding) onClose() }
  const dialogRef = useDialogFocus({ onEscape: close, initialFocus: addressRef, fallbackFocus })
  useEffect(() => { if (done) doneRef.current?.focus() }, [done])

  const parsed = ownServerAddress(address)
  const addressWords = address.trim() && !parsed.ok ? refusalWords(parsed.reason, 'check', parsed.host, parsed.host) : null
  // The name follows the address until the user types one; cleared, it falls back to the address's.
  const derivedName = ownServerName(address, checked?.phase === 'done' ? checked.result.kind : undefined)
  const shownName = named ? name : derivedName
  const serverName = shownName.trim() || derivedName
  const contexts = drafts.map(draft => parseContext(draft.context))
  const ok = checked?.phase === 'done'
  const canAdd = ok && !adding && serverName.length > 0 && contexts.every(context => context !== null)
  const running = checked?.phase === 'running'

  /** A change to what was checked leaves the old answer behind: it was about another server. */
  const forget = (): void => { asked.current += 1; setChecked(null); setDrafts([]); setRefusal(null) }
  /** Main's refusal in the interface language, for this address and the name it would be saved under. */
  const refusedWords = (reason: OwnServerRefusal, doing: OwnServerDoing, english?: string): string =>
    refusalWords(reason, doing, parsed.host || address.trim(), serverName, english)
  const refuse = (reason: OwnServerRefusal, words: string, from: RefObject<HTMLButtonElement | null>): void => {
    const field = fieldFor(reason)
    setRefusal({ words, field })
    // Focus goes to the field that can put it right; otherwise it stays on the button pressed, and the alert is read.
    queueMicrotask(() => { if (!live.current) return; (field === 'address' ? addressRef.current : field === 'key' ? keyRef.current : from.current)?.focus() })
  }
  const check = async (): Promise<void> => {
    if (running || adding || !address.trim()) return
    setAddressShown(true)
    if (!parsed.ok) { refuse(parsed.reason, refusedWords(parsed.reason, 'check'), checkRef); return }
    const ticket = ++asked.current
    setChecked({ phase: 'running' }); setDrafts([]); setRefusal(null)
    let result: CheckResult
    try { result = await bridge.check({ address: parsed.address, ...(key.trim() ? { key: key.trim() } : {}) }) } catch { result = { status: 'refused', reason: 'unreachable', message: notAnswered() } }
    if (!live.current || ticket !== asked.current) return
    if (result.status !== 'ok') { setChecked(null); refuse(result.reason, refusedWords(result.reason, 'check', result.message), checkRef); return }
    setChecked({ phase: 'done', result })
    setDrafts(result.models.map(found => ({ found, context: found.context === undefined ? '' : String(found.context), thinking: found.thinking === true })))
    focusResults.current = true
  }
  // Once the models found are drawn, focus moves to the first thing the check asks for: a context to type, else Add server.
  useEffect(() => {
    if (!focusResults.current || checked?.phase !== 'done') return
    focusResults.current = false
    const first = resultsRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')
    if (first) first.focus(); else if (addRef.current && !addRef.current.disabled) addRef.current.focus(); else resultsRef.current?.querySelector<HTMLElement>('input')?.focus()
  }, [checked])
  const add = async (): Promise<void> => {
    if (!canAdd || checked?.phase !== 'done') return
    setAdding(true); setRefusal(null)
    const models = drafts.map((draft, index) => ({ id: draft.found.id, name: draft.found.name, context: contexts[index]!, ...(draft.found.output === undefined ? {} : { output: draft.found.output }),
      thinking: draft.thinking, images: draft.found.images }))
    try {
      const result = await bridge.add({ name: serverName, address: checked.result.address, ...(key.trim() ? { key: key.trim() } : {}), models })
      if (result.status === 'ok') {
        onAdded?.(result.server)
        if (live.current && confirm) setDone(result.server)
      } else {
        if (result.reason === 'added-partly') onListChanged?.()
        if (live.current) refuse(result.reason, refusedWords(result.reason, 'add', result.message), addRef)
      }
    } catch { if (live.current) refuse('sign-in-failed', notAnswered(), addRef) } finally { if (live.current) setAdding(false) }
  }
  const enter = (event: React.KeyboardEvent<HTMLInputElement>): void => { if (event.key === 'Enter') { event.preventDefault(); void check() } }
  const describedBy = (...ids: Array<string | false>): string | undefined => ids.filter(Boolean).join(' ') || undefined

  const shell = (body: ReactNode, actions: ReactNode, title: string, about: string): ReactNode => createPortal(
    <div className="tt-dialog-backdrop own-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
      <section ref={dialogRef} className="tt-dialog own-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={aboutId} aria-busy={running || adding || undefined}>
        <h2 id={titleId}>{title}</h2>
        <p className="tt-dialog__description tt-paragraph" id={aboutId}>{about}</p>
        <div className="own-dialog__body">{body}</div>
        <div className="tt-dialog__actions">{actions}</div>
      </section>
    </div>, document.body)

  if (done) {
    const doneName = done.name
    return shell(<p className="own-dialog__done tt-paragraph" role="status">{addedWords(doneName)}</p>,
      <Button ref={doneRef} variant="primary" onClick={onClose}>{t`Done`}</Button>, t`Added ${doneName}`, t`It runs with OpenCode.`)
  }

  const result = checked?.phase === 'done' ? checked.result : null
  return shell(<>
    <div className="own-fields">
      <div className="own-field"><label htmlFor={addressId}>{t`Address`}</label>
        <input ref={addressRef} id={addressId} className="tt-input" type="url" inputMode="url" value={address} placeholder="http://localhost:11434" autoComplete="off" spellCheck={false} maxLength={400} readOnly={adding}
          aria-invalid={(addressShown && addressWords !== null) || refusal?.field === 'address' || undefined}
          aria-describedby={describedBy(addressNoteId, addressShown && addressWords !== null && refusal?.field !== 'address' && addressErrorId, refusal?.field === 'address' && refusalId)}
          onChange={event => { setAddress(event.target.value); forget() }} onBlur={() => setAddressShown(true)} onKeyDown={enter} />
        <small className="tt-paragraph" id={addressNoteId}>{t`Where the server listens, on this computer, your network or your tailnet.`}</small>
        {addressShown && addressWords !== null && refusal?.field !== 'address' ? <small className="own-field__error tt-paragraph" id={addressErrorId}>{addressWords}</small> : null}
      </div>
      <div className="own-field"><label htmlFor={nameId}>{t`Name`}</label>
        <input id={nameId} className="tt-input" type="text" value={shownName} placeholder={derivedName ? t({ message: `${derivedName}, from the address`, comment: '{derivedName} is the name Sotto takes from the address, such as spark-head.' }) : t`From the address, if left empty`} autoComplete="off" spellCheck={false} maxLength={80} aria-describedby={nameNoteId} readOnly={adding}
          onChange={event => { setNamed(true); setName(event.target.value) }} onKeyDown={enter} />
        <small className="tt-paragraph" id={nameNoteId}>{t`What the model menu calls it.`}</small>
      </div>
      <div className="own-field"><label htmlFor={keyId}>{t({ message: 'Key', comment: 'A secret the model server checks before it answers.' })} <span className="own-field__optional">{t`(optional)`}</span></label>
        <input ref={keyRef} id={keyId} className="tt-input" type="password" value={key} placeholder={t`Only if the server was started with one`} autoComplete="off" spellCheck={false} maxLength={OWN_SERVER_KEY_MAX} readOnly={adding}
          aria-invalid={refusal?.field === 'key' || undefined} aria-describedby={describedBy(keyNoteId, refusal?.field === 'key' && refusalId)}
          onChange={event => { setKey(event.target.value); forget() }} onKeyDown={enter} />
        <small className="tt-paragraph" id={keyNoteId}>{keyNote()}</small>
      </div>
    </div>
    <div className="own-check">
      <Button ref={checkRef} variant={ok ? 'secondary' : 'primary'} disabled={!address.trim() || running || adding} onClick={() => void check()}>{running ? t`Checking…` : ok ? t`Check again` : t`Check this server`}</Button>
      <span className="own-check__status" role="status">{running ? t`Asking the server for its models…` : ''}</span>
    </div>
    {refusal ? <p className="provider-detail__error own-refusal tt-paragraph" role="alert" id={refusalId}>{refusal.words}</p> : null}
    {result ? <div className="own-found" ref={resultsRef}>
      <p className="own-found__who tt-paragraph">{answeredWords(result.kind, result.answeredMs, result.models.length)}</p>
      <ul className="own-models" aria-label={t`Models found`}>{drafts.map((draft, index) => <ModelCard key={draft.found.id} draft={draft} valid={contexts[index] !== null} locked={adding}
        onChange={patch => setDrafts(current => current.map((item, at) => at === index ? { ...item, ...patch } : item))} />)}</ul>
    </div> : null}
    <p className="own-privacy tt-paragraph" id={privacyId}>{privacyWords()}</p>
  </>, <>
    <Button variant="secondary" aria-label={t`Close without adding a server`} disabled={adding} onClick={close}>{t`Cancel`}</Button>
    {/* While adding, the button keeps focus and says so; it is only marked unavailable, so focus does not fall to the page. */}
    <Button ref={addRef} variant="primary" disabled={!canAdd && !adding} aria-disabled={adding || undefined} aria-describedby={privacyId}
      onClick={() => void add()}>{adding ? t`Adding…` : t`Add server`}</Button>
  </>, t`Add your own model server`, t`SGLang, vLLM, Ollama, LM Studio, llama.cpp or any OpenAI-compatible server. Check it, then add it, and OpenCode threads can use its models.`)
}

/** One model the check found: its name, Thinking, its context to confirm or type, and whether it takes images. */
function ModelCard({ draft, valid, locked, onChange }: { readonly draft: Draft; readonly valid: boolean; readonly locked: boolean; readonly onChange: (patch: Partial<Draft>) => void }): ReactNode {
  const { t } = useLingui()
  const model = draft.found.name
  const contextId = useId(), noteId = useId(), errorId = useId()
  const unknown = draft.found.context === undefined
  // A context the server did not give is asked for by its note; one typed that is not a number of tokens says why.
  const showError = !valid && draft.context.trim() !== ''
  return <li className="own-model">
    <div className="own-model__top">
      <strong>{draft.found.name}</strong>
      <span className="own-model__think"><span aria-hidden="true">{t({ message: 'Thinking', comment: 'Whether the model reasons before it answers.' })}</span>
        <button type="button" role="switch" className="tt-toggle tt-focusable own-switch" aria-checked={draft.thinking} aria-label={t({ message: `Thinking for ${model}`, comment: '{model} is a model name.' })} disabled={locked}
          onClick={() => onChange({ thinking: !draft.thinking })}><span className="tt-toggle__track" aria-hidden="true"><span className="tt-toggle__thumb" /></span></button></span>
    </div>
    <div className="own-model__context">
      <label htmlFor={contextId}>{t`Context, in tokens`}</label>
      <input id={contextId} className="tt-input" type="text" inputMode="numeric" value={draft.context} readOnly={locked} autoComplete="off" spellCheck={false}
        aria-required="true" aria-invalid={!valid || undefined} aria-describedby={[unknown ? noteId : '', showError ? errorId : ''].filter(Boolean).join(' ') || undefined}
        onChange={event => onChange({ context: event.target.value })} />
    </div>
    {unknown ? <p className="own-model__note tt-paragraph" id={noteId}>{contextUnknown()}</p> : null}
    {showError ? <p className="own-model__error tt-paragraph" id={errorId}>{contextRange()}</p> : null}
    {draft.found.images ? <p className="own-model__note tt-paragraph">{t`Takes images.`}</p> : null}
  </li>
}
