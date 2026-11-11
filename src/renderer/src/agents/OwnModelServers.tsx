import React, { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Server, MoreHorizontal } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import {
  OWN_SERVER_CONTEXT_MAX, OWN_SERVER_CONTEXT_MIN, OWN_SERVER_KEY_MAX, ownServerAddress,
  keptModels, type CatalogueEntry, type FoundModel, type OwnServerModel, type OwnServer, type OwnServerKind, type OwnServerRefusal, type OwnServersBridge,
} from '../../../shared/ownModelServers'
import { contextUnknown, keyNote, kindName, notAnswered, privacyWords, refusalWords } from './ownServerWords'
import { effortLabel } from './effortNames'
import { useOptionalAgents } from './AgentContext'
import { localProviders } from './localAgents'
import { RowMenu } from './RowMenu'
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

/** One block, shared by the existing Owl gate and model-menu shortcut. */
export function OwnModelServers({ bridge }: { readonly bridge: OwnServersBridge }): ReactNode {
  const { t } = useLingui()
  const agents = useOptionalAgents()
  const providers = agents?.state ? localProviders(agents.state).filter(provider => provider.connection === 'connected') : []
  const runners = providers.filter(provider => ['hermes', 'opencode', 'deepseek'].includes(provider.id))
  const [servers, setServers] = useState<OwnServer[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [reading, setReading] = useState(true), [busy, setBusy] = useState('')
  const [dialog, setDialog] = useState<{ mode: 'add' | 'choose' | 'replace' | 'remove'; server?: OwnServer } | null>(null)
  const [menu, setMenu] = useState<OwnServer | null>(null)
  const addRef = useRef<HTMLButtonElement>(null), opener = useRef<HTMLElement | null>(null)
  const read = (): void => { setError(''); setReading(true); void bridge.list().then(setServers, () => setError(t`Sotto could not read your saved servers. Nothing was changed. Try again.`)).finally(() => setReading(false)) }
  useEffect(read, [bridge])
  const open = (mode: 'add' | 'choose' | 'replace' | 'remove', server?: OwnServer): void => {
    opener.current = document.activeElement as HTMLElement; setDialog({ mode, ...(server ? { server } : {}) }); setMenu(null)
  }
  const changed = (): void => { read(); setNotice(t`Saved. Its chosen models are in the model menu.`); setDialog(null) }
  const recheck = async (server: OwnServer): Promise<void> => {
    setBusy(server.id); setError(''); setNotice('')
    try {
      const result = await bridge.checkSaved({ id: server.id })
      if (result.status === 'refused') setError(refusalWords(result.reason, 'check-saved', hostOf(server.address), server.name, result.message))
      else {
        setNotice(result.keyKept ? t`The API answered. Its key stays with its provider, so its saved models were kept.` : t`Models checked. Your choices were kept; new models start unticked.`)
        read()
      }
    } catch { setError(notAnswered()) } finally { setBusy('') }
  }
  return <SettingsGroup icon={Server} title={t`APIs and your own model servers`}
    note={t`Add an API key or a server you run, such as SGLang, vLLM, Ollama or LM Studio. Sotto contacts it only when you check or add it.`}>
    <div className="own-servers" data-setting="own-model-servers" aria-busy={reading}>
      {!servers.length ? !error && <p className="own-servers__empty">{reading ? t`Reading your servers…` : t`None yet. Add an API or a model server to use its models in threads.`}</p> :
        <ul className="own-servers__rows" aria-label={t`Saved APIs and model servers`}>{servers.map(server => {
          const count = keptModels(server).length, total = (server.inventory ?? server.models).length, name = server.name
          return <li className="own-server" key={server.id} aria-busy={busy === server.id}>
            <div className="own-server__name"><strong>{name}</strong><span className="own-server__address">{server.address}</span></div>
            <div className="own-server__actions">
              <Button variant="secondary" onClick={() => open('choose', server)}>{t`Choose models`}</Button>
              <Button variant="secondary" disabled={!!busy} onClick={() => void recheck(server)}>{busy === server.id ? t`Checking…` : t`Check again`}</Button>
              <Button variant="ghost" aria-label={t`More for ${name}`} aria-haspopup="menu" aria-expanded={menu?.id === server.id}
                onClick={event => { opener.current = event.currentTarget; setMenu(menu?.id === server.id ? null : server) }}><MoreHorizontal size={16} /></Button>
            </div>
            <p className="own-server__meta">{runners.length ? `${t`Runs with`} ${runners.filter(provider => !server.keyed || provider.id === (server.keyKeeper ?? 'opencode') || provider.id === 'hermes').map(provider => provider.name).join(' / ')} · ` : ''}{t`${count} of ${total} models`}{server.keyed ? ` · ${server.keyKeeper === 'hermes' ? t`Key kept by Hermes` : t`Key kept by OpenCode`}` : ''}</p>
            {server.checkedAt ? <p className="own-server__meta">{t`Checked`} {new Date(server.checkedAt).toLocaleString()}{server.newModelIds?.length ? ` · ${server.newModelIds.length} ${t`new`}` : ''}</p> : null}
          </li>
        })}</ul>}
      <div className="own-servers__below"><Button ref={addRef} variant="secondary" aria-haspopup="dialog" onClick={() => open('add')}><Plus size={14} />{t`Add an API or server`}</Button></div>
      {notice ? <p className="own-servers__notice" role="status">{notice}</p> : null}
      {error ? <p role="alert" className="provider-detail__error">{error} <Button variant="ghost" onClick={read}>{t`Try again`}</Button></p> : null}
    </div>
    {menu ? <RowMenu label={t`API actions`} anchor={() => opener.current} place="beside" onClose={restore => { setMenu(null); if (restore) opener.current?.focus() }}
      groups={[[...(menu.keyed ? [{ id: 'replace', label: t`Replace key`, run: () => open('replace', menu) }] : []),
        { id: 'remove', label: t`Remove`, tone: 'danger', run: () => open('remove', menu) }]]} /> : null}
    {dialog ? <AddOwnServerDialog bridge={bridge} server={dialog.server} mode={dialog.mode} fallbackFocus={opener} onClose={() => setDialog(null)} onAdded={changed} onListChanged={() => { read(); if (dialog.mode === 'remove') requestAnimationFrame(() => addRef.current?.focus()) }} /> : null}
  </SettingsGroup>
}

export function OwnServerMenuEntry({ onPress }: { readonly onPress: () => void }): ReactNode {
  const { t } = useLingui()
  return <button type="button" className="model-picker__own" tabIndex={-1} aria-haspopup="dialog" onClick={onPress}>
    <Plus size={14} aria-hidden="true" /><span><b>{t`Add an API or server…`}</b><small>{t`Use an API key or a server you run`}</small></span>
  </button>
}

export function initialKept(models: readonly FoundModel[]): Set<string> { return new Set(models.length <= 10 ? models.map(model => model.id) : []) }
function runnable(model: FoundModel, context: number): OwnServerModel {
  return { ...model, context, thinking: model.thinking !== false, images: model.images === true,
    reasoningEfforts: model.reasoningEfforts ?? (model.thinking === false ? [] : ['default']) }
}

type DialogProps = {
  readonly bridge: OwnServersBridge; readonly fallbackFocus?: RefObject<HTMLElement | null> | undefined
  readonly onClose: () => void; readonly onAdded?: ((server: OwnServer) => void) | undefined
  readonly confirm?: boolean; readonly onListChanged?: (() => void) | undefined
  readonly mode?: 'add' | 'choose' | 'replace' | 'remove' | undefined; readonly server?: OwnServer | undefined
}

/** The approved Add flow, and the same model choices and key field when revisiting a saved source. */
export function AddOwnServerDialog({ bridge, fallbackFocus, onClose, onAdded, onListChanged, confirm = false, mode = 'add', server }: DialogProps): ReactNode {
  const { t } = useLingui()
  const [page, setPage] = useState<'apis' | 'key' | 'address' | 'models' | 'done'>(mode === 'choose' ? 'models' : mode === 'replace' ? 'key' : 'apis')
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]), [loading, setLoading] = useState(mode === 'add'), [available, setAvailable] = useState(true)
  const [byAddress, setByAddress] = useState(false)
  const [api, setApi] = useState<CatalogueEntry | null>(server?.helpUrl ? { id: server.catalogueId ?? server.id, api: server.address, name: server.name, doc: server.helpUrl } : null), [query, setQuery] = useState('')
  const [address, setAddress] = useState(server?.address ?? ''), [name, setName] = useState(server?.name ?? '')
  const [writing, setWriting] = useState(false)
  const [key, setKey] = useState(''), [showKey, setShowKey] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [models, setModels] = useState<FoundModel[]>(server ? (server.inventory ?? server.models).map(model => {
    const context = model.context ?? server.models.find(saved => saved.id === model.id)?.context
    return { ...model, ...(context === undefined ? {} : { context }) }
  }) : [])
  const [kept, setKept] = useState<Set<string>>(new Set(server ? keptModels(server).map(model => model.id) : []))
  const [contexts, setContexts] = useState<Record<string, string>>({}), [filter, setFilter] = useState('all'), [modelQuery, setModelQuery] = useState('')
  const root = useRef<HTMLElement>(null), focus = useRef<HTMLInputElement>(null), status = useRef<HTMLParagraphElement>(null)
  const selectedFocus = useRef(false)
  useEffect(() => {
    if (!selectedFocus.current) return
    selectedFocus.current = false
    ;(root.current?.querySelector<HTMLElement>('[data-model-check]') ?? root.current?.querySelector<HTMLElement>('.own-model-filters button[aria-pressed="true"]'))?.focus()
  }, [kept, filter])
  const ticket = useRef(0), live = useRef(true), titleId = useId(), errorId = useId()
  useEffect(() => () => { live.current = false; ticket.current++ }, [])
  const close = (): void => { if (!writing) { ticket.current++; setKey(''); onClose() } }
  const dialog = useDialogFocus({ onEscape: () => {
    const details = root.current?.querySelector<HTMLDetailsElement>('details[open]')
    if (details) { details.open = false; details.querySelector('summary')?.focus() } else close()
  }, initialFocus: status, fallbackFocus })
  const load = (): void => { setLoading(true); setAvailable(true); void bridge.catalogue().then(result => {
    if (!live.current) return; setCatalogue(result.entries); setAvailable(result.available)
  }, () => { if (live.current) setAvailable(false) }).finally(() => { if (live.current) setLoading(false) }) }
  useEffect(() => { if (mode === 'add') load() }, [bridge, mode])
  useEffect(() => {
    if (busy || loading) status.current?.focus()
    else if (page === 'models') (root.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]') ?? root.current?.querySelector<HTMLInputElement>(models.length > 10 ? '[data-model-search]' : '[data-model-check]'))?.focus()
    else (focus.current ?? root.current?.querySelector<HTMLButtonElement>('[data-another-address]'))?.focus()
  }, [page, busy, loading, models.length])
  const parsed = ownServerAddress(address), sourceName = (byAddress ? name.trim() || ownServerName(address) : api?.name ?? (name.trim() || ownServerName(address))).slice(0, 80)
  const many = models.length > 10, newIds = new Set(server?.newModelIds ?? [])
  const shown = models.filter(model => (`${model.name} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase())) &&
    (filter === 'selected' ? kept.has(model.id) : filter === 'new' ? newIds.has(model.id) : true)).sort((a, b) => Number(newIds.has(b.id)) - Number(newIds.has(a.id)))
  const validModels = models.filter(model => model.context !== undefined || parseContext(contexts[model.id] ?? '') !== null)
    .map(model => runnable(model, model.context ?? parseContext(contexts[model.id] ?? '')!))
  const validIds = new Set(validModels.map(model => model.id))
  const canSave = kept.size > 0 && [...kept].every(id => validIds.has(id) || !!server?.models.some(model => model.id === id))
  const refuse = (result: { reason: OwnServerRefusal; message: string }): void => {
    setError(mode === 'replace' ? (result.reason === 'replaced-partly' ? t`OpenCode has the new key, but Hermes could not replace its copy. Your model choices were kept. Try again.` : result.reason === 'opencode-not-running' ? t`Connect the provider that keeps this key before replacing it. Nothing was changed.` : result.reason === 'key-refused' || result.reason === 'key-needed' ? t`This API did not accept the new key. The saved key and model choices were kept. Check the key and try again.` : t`The new key could not be saved. The model choices were kept. Try again.`) :
      refusalWords(result.reason, 'check', hostOf(address), sourceName, result.message))
    queueMicrotask(() => focus.current?.focus())
  }
  const check = async (): Promise<void> => {
    if (busy) return
    if (!parsed.ok) { setError(refusalWords(parsed.reason, 'check', parsed.host, sourceName)); focus.current?.focus(); return }
    const at = ++ticket.current; setBusy(true); setError('')
    try {
      const result = await bridge.check({ address: parsed.address, ...(key.trim() ? { key: key.trim() } : {}), ...(api ? { catalogueId: api.id } : {}) })
      if (!live.current || at !== ticket.current) return
      if (result.status === 'refused') { refuse(result); return }
      if (mode === 'replace' && server) {
        setWriting(true)
        const replaced = await bridge.replaceKey({ id: server.id, key: key.trim() })
        if (!live.current || at !== ticket.current) return
        if (replaced.status === 'refused') { refuse(replaced); return }
        setKey(''); onAdded?.(replaced.server); onClose(); return
      }
      setModels(result.models); setKept(initialKept(result.models)); setPage('models')
    } catch { if (live.current && at === ticket.current) setError(notAnswered()) }
    finally { if (live.current && at === ticket.current) { setBusy(false); setWriting(false) } }
  }
  const save = async (): Promise<void> => {
    if (!canSave || busy) return; setWriting(true); setBusy(true); setError('')
    try {
      const result = mode === 'choose' && server ? await bridge.chooseModels({ id: server.id, keptModelIds: [...kept], models: validModels.filter(model => contexts[model.id] !== undefined || !server.models.some(saved => saved.id === model.id)) }) :
        await bridge.add({ name: sourceName, address, ...(key.trim() ? { key: key.trim() } : {}), models: validModels,
          inventory: models, keptModelIds: [...kept], ...(api ? { catalogueId: api.id } : {}) })
      if (result.status === 'refused') { refuse(result); onListChanged?.(); return }
      if (!live.current) { onListChanged?.(); return }
      setKey(''); onAdded?.(result.server); if (confirm) setPage('done'); else onClose()
    } catch { setError(notAnswered()) } finally { if (live.current) { setBusy(false); setWriting(false) } }
  }
  const remove = async (): Promise<void> => {
    if (!server || busy) return; const at = ++ticket.current; setWriting(true); setBusy(true)
    try { const result = await bridge.remove({ id: server.id }); if (!live.current || at !== ticket.current) return; if (result.status === 'ok') { onListChanged?.(); onClose() } else refuse(result) }
    catch { setError(notAnswered()) } finally { if (live.current) { setBusy(false); setWriting(false) } }
  }
  const title = mode === 'remove' ? t`Remove ${sourceName}?` : mode === 'replace' ? t`Replace the key for ${sourceName}` : mode === 'choose' ? t`Choose ${sourceName} models` :
    page === 'apis' ? t`Add an API or server` : byAddress || !api ? t`Add by address` : t`Add ${sourceName}`
  const toggle = (id: string): void => {
    selectedFocus.current = filter === 'selected' && kept.has(id)
    setKept(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  const listKeys = (event: React.KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }
  const notListed = query.toLowerCase().trim()
  const matched = catalogue.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(notListed))
  const commonIds = ['openrouter', 'deepseek', 'fireworks-ai', 'moonshotai', 'zai']
  const common = notListed ? [] : commonIds.flatMap(id => matched.filter(item => item.id === id))
  const remaining = matched.filter(item => !common.includes(item))
  const apiButton = (item: CatalogueEntry, index: number): ReactNode => <button type="button" key={item.id} tabIndex={index === 0 ? 0 : -1} className="own-api-option"
    onFocus={event => { const buttons = root.current?.querySelectorAll<HTMLButtonElement>('.own-api-option'); buttons?.forEach(button => { button.tabIndex = button === event.currentTarget ? 0 : -1 }) }}
    onClick={() => { const custom = item.api.includes('${'); setByAddress(custom); setApi(item); setAddress(item.api); setName(item.name); setPage(custom ? 'address' : 'key'); setQuery('') }}>{item.name}</button>
  return createPortal(<div className="tt-dialog-backdrop own-backdrop" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={element => { dialog.current = element; root.current = element }} className="tt-dialog own-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || loading}>
      <h2 id={titleId}>{title}</h2>
      <p className="tt-dialog__description">{mode === 'replace' ? t`The saved key keeps working until the new one passes. Your model choices stay the same.` :
        mode === 'remove' ? t`Its models will leave the menu. Existing threads keep their messages. Add it again before sending to it from those threads.` :
          page === 'apis' ? t`Choose an API and paste its key, or add the address of a server you run.` : t`Use its models with a connected provider.`}</p>
      <div className="own-dialog__body">
        {error ? <p id={errorId} className="provider-detail__error" role="alert">{error}</p> : null}
        {busy || loading ? <p ref={status} tabIndex={-1} role="status">{loading ? t`Getting the list of APIs…` : writing ? t`Saving…` : t`Checking the key and reading models…`}</p> : null}
        {mode === 'add' && page === 'apis' && !loading ? <>
          {available ? <><input ref={focus} className="tt-input" aria-label={t`Search APIs`} placeholder={t`Search APIs`} value={query} onChange={event => setQuery(event.target.value)} />
            <p className="own-model__note">{t`${catalogue.length} APIs`}</p>
            <div className="own-api-list" onKeyDown={listKeys}>
              {common.length ? <><p className="own-model__note">{t`Common`}</p>{common.map(apiButton)}<p className="own-model__note">{t`Every API, A to Z`}</p></> : null}
              {remaining.map((item, index) => apiButton(item, index + common.length))}
            </div>
            {['openai', 'anthropic', 'google', 'xai', 'x.ai'].includes(notListed) ? <p>{t`This API cannot be added with just a key here. This list has only APIs that supply an OpenAI-compatible address.`} {notListed === 'openai' ? t`For OpenAI, connect Codex under Providers.` : notListed === 'anthropic' ? t`For Anthropic, connect Claude Code under Providers.` : ['xai', 'x.ai'].includes(notListed) ? t`For xAI, connect Grok Build under Providers.` : t`You can use Another address if you have an OpenAI-compatible API address.`}</p> : null}
            {query && !catalogue.some(item => `${item.name} ${item.id}`.toLowerCase().includes(notListed)) ? <p>{t`No matching API. Use Another address to enter an OpenAI-compatible address.`}</p> : null}
          </> : <p role="alert">{t`The list of APIs could not be fetched. Nothing was added. Try again, or choose Another address below.`}</p>}
          <Button data-another-address variant="secondary" onClick={() => { setByAddress(true); setApi(null); setPage('address') }}>{t`Another address`}</Button>
          <p className="own-privacy">{t`The list comes from models.dev. Sotto downloads it when this opens and sends nothing of yours.`}</p>
        </> : null}
        {(page === 'key' || page === 'address' || (page === 'models' && byAddress && mode === 'add')) && !busy ? <>
          {mode === 'add' ? <Button variant="ghost" onClick={() => { setPage('apis'); setKey(''); setError('') }}>{t`All APIs`}</Button> : null}
          {api && !byAddress ? <p className="own-server__address">{address}</p> : null}
          <div className="own-fields">
            {byAddress && mode === 'add' ? <>
              <label className="own-field">{t`Address`}<input ref={focus} className="tt-input" value={address} placeholder="http://localhost:11434" autoComplete="off" spellCheck={false} maxLength={400} aria-describedby={error ? errorId : undefined} onChange={event => { setAddress(event.target.value); setModels([]); setKept(new Set()); setPage('address'); setError('') }} /></label>
              {api?.api.includes('${') ? <p className="own-model__note">{t`Replace the placeholders with your API address before checking.`}</p> : null}
              <label className="own-field">{t`Name`}<input className="tt-input" value={name} placeholder={ownServerName(address)} maxLength={80} onChange={event => setName(event.target.value)} /></label>
            </> : null}
            <div className="own-field"><label htmlFor={`${titleId}-key`}>{mode === 'replace' ? t`New key` : !api && mode === 'add' ? t`Key (optional)` : t`Key`}</label>
              {api?.doc ? <a href={api.doc} onClick={event => { event.preventDefault(); void window.sotto?.openExternalLink?.(api.doc!) }}>{t`Get a key`} ↗ {hostOf(api.doc)}</a> : null}
              <div className="own-key"><input ref={page === 'key' ? focus : undefined} id={`${titleId}-key`} className="tt-input" type={showKey ? 'text' : 'password'} value={key} maxLength={OWN_SERVER_KEY_MAX} autoComplete="off" spellCheck={false} aria-describedby={error ? errorId : undefined}
                onChange={event => { setKey(event.target.value); if (page === 'models') { setModels([]); setKept(new Set()); setPage('address') } }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void check() } }} />
                <Button variant="ghost" onClick={() => setShowKey(!showKey)}>{showKey ? t`Hide` : t`Show`}</Button></div>
              <small>{keyNote()}</small>
            </div>
          </div>
          {page === 'models' ? <Button variant="secondary" onClick={() => void check()}>{t`Check again`}</Button> : null}
          <p className="own-privacy">{privacyWords()}</p>
        </> : null}
        {page === 'models' && !busy ? <>
          <div className="own-model-toolbar"><span>{plural(models.length, { one: '# model found', other: '# models found' })}</span><Button variant="ghost" onClick={() => setKept(current => { const next = new Set(current), clear = shown.every(model => next.has(model.id)); for (const model of shown) { if (clear) next.delete(model.id); else next.add(model.id) } return next })}>{shown.length && shown.every(model => kept.has(model.id)) ? (many ? t`Clear shown` : t`Clear all`) : (many ? t`Select shown` : t`Select all`)}</Button></div>
          {many ? <><input data-model-search className="tt-input" aria-label={t`Search models`} placeholder={t`Search models`} value={modelQuery} onChange={event => setModelQuery(event.target.value)} />
            <div className="own-model-filters">{[['all', t`All`, models.length], ['selected', t`Selected`, kept.size], ...(newIds.size ? [['new', t`New`, newIds.size]] : [])].map(([id, label, count]) =>
              <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(String(id))}>{label} <span>{count}</span></button>)}</div></> : null}
          <ul className="own-models" aria-label={t`Models found`}>{shown.map(model => <li key={model.id} className="own-model">
            <label className="own-model__choice"><input data-model-check type="checkbox" checked={kept.has(model.id)} onChange={() => toggle(model.id)} /><strong>{model.name}</strong>{newIds.has(model.id) ? <small>{t`New`}</small> : null}</label>
            <code className="own-model__id">{model.id}</code>
            <p className="own-model__note">{model.context ? t`${model.context.toLocaleString()} context` : t`Context not given`}{model.images ? ` · ${t`Takes images`}` : ''}{model.tools === false ? ` · ${t`No tools`}` : ''}</p>
            {model.thinking !== false ? <p className="own-model__note">{t`Thinking`}: {model.reasoningEfforts?.length && (model.reasoningEfforts.length > 1 || !model.reasoningEfforts.includes('default')) ? model.reasoningEfforts.map(level => effortLabel(level === 'none' ? 'off' : level)).join(', ') : t`the model’s default`}</p> : null}
            {model.context === undefined && kept.has(model.id) ? <label className="own-model__context">{t`Context, in tokens`}<input className="tt-input" inputMode="numeric" value={contexts[model.id] ?? ''} aria-invalid={parseContext(contexts[model.id] ?? '') === null} onChange={event => setContexts({ ...contexts, [model.id]: event.target.value })} /><small>{contextUnknown()}</small></label> : null}
            <details><summary>{t`Details`}</summary><div className="own-model__details"><span>{model.output ? t`Longest answer: ${model.output.toLocaleString()} tokens` : t`Longest answer not given`}</span>
              <span>{model.tools === undefined ? t`Tool support not given` : model.tools ? t`Tools supported` : t`No tools`}</span>
              {model.cost ? Object.entries(model.cost).map(([kind, price]) => <span key={kind}>{kind === 'input' ? t`Input` : kind === 'output' ? t`Output` : t`Cached input`}: {t`$${price} per 1M tokens`}</span>) : <span>{t`Price not given`}</span>}</div></details>
          </li>)}</ul>
          {!shown.length ? <p>{t`No models match. Clear the search or choose another filter.`}</p> : null}
          <p className="own-privacy">{mode === 'choose' ? t`Existing threads keep working. Unticked models leave the menu for new picks.` : t`Choose thinking and effort in each thread’s effort control.`}</p>
        </> : null}
        {page === 'done' ? <p role="status">{t`Added. Its models are in the model menu.`}</p> : null}
      </div>
      <div className="tt-dialog__actions">
        {page === 'models' ? <span className="own-model-count" role="status">{t`${kept.size} of ${models.length} models selected`}</span> : null}
        <Button variant="secondary" disabled={writing} onClick={close}>{page === 'done' ? t`Done` : t`Cancel`}</Button>
        {page === 'apis' && !available ? <Button variant="primary" onClick={load}>{t`Try again`}</Button> : null}
        {(page === 'key' || page === 'address') && !busy ? <Button variant="primary" disabled={address.includes('${') || (page === 'key' ? !key.trim() : !address.trim())} onClick={() => void check()}>{mode === 'replace' ? t`Check and replace` : page === 'address' ? t`Check this server` : t`Check key`}</Button> : null}
        {page === 'models' ? <Button variant="primary" disabled={!canSave || busy} onClick={() => void save()}>{busy ? t`Saving…` : mode === 'choose' ? t`Save choices` : byAddress ? t`Add server` : kept.size ? plural(kept.size, { one: 'Add # model', other: 'Add # models' }) : t`Add models`}</Button> : null}
        {mode === 'remove' ? <Button variant="primary" disabled={busy} onClick={() => void remove()}>{t`Remove`}</Button> : null}
      </div>
    </section>
  </div>, document.body)
}
