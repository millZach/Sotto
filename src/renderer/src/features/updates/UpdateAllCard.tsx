import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ChevronDown, Clock, Copy, LoaderCircle, RotateCcw, Server } from 'lucide-react'
import type { ProviderClientUpdate, ProviderId } from '../../../../shared/agents'
import type { HostsBridge, HostsState } from '../../../../shared/hosts'
import { threadKeepsHostBusy } from '../../../../shared/hostUpdates'
import { Button } from '../../components/Button'
import { SottoMark } from '../../components/SottoMark'
import { useOptionalAgents } from '../../agents/AgentContext'
import { ProviderMark } from '../../agents/ProviderMark'
import { useTransientFlag, writeClipboard } from '../../agents/richActions'
import { focusedComposerField } from '../../agents/promptSelection'
import { useOptionalApp } from '../../state/AppContext'
import { useOwlFeature } from '../../state/owlFeature'
import { APP_KEY, clientKey, hostKey, updateAllSteps, updateAllView, updateAllWords, type UpdateAllItem, type UpdateAllPass, type UpdateAllPhase, type UpdateAllStep, type UpdateAllStepState } from './updateAll'
import './updateAll.css'

const requests = new Set<() => void>()
/** Settings → Application → Updates' Update all: the card runs the same press (ADR-0077 decision 7). */
export function requestUpdateAll(): void { for (const listener of requests) listener() }

const ipcMessage = (error: unknown, fallback: string): string => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() || fallback : fallback
const UNREACHABLE = 'Sotto could not reach the update. Nothing was changed. Try again.'

function useHostsState(bridge: HostsBridge | undefined): HostsState | null {
  const [state, setState] = useState<HostsState | null>(null)
  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.get().then(next => { if (live) setState(next) }, () => undefined)
    const off = bridge.onChanged(next => { if (live) setState(next) })
    return () => { live = false; off() }
  }, [bridge])
  return state
}

function PhaseGlyph({ phase, failed }: { readonly phase: UpdateAllPhase; readonly failed: boolean }): ReactNode {
  if (phase === 'running') return <LoaderCircle size={14} aria-hidden="true" className="update-all__spin" />
  if (failed) return <AlertTriangle size={14} aria-hidden="true" className="update-all__glyph--failed" />
  if (phase === 'restart') return <RotateCcw size={14} aria-hidden="true" className="update-all__glyph--done" />
  if (phase === 'done') return <Check size={14} aria-hidden="true" className="update-all__glyph--done" />
  return <span className="update-all__dot" aria-hidden="true" />
}

/** A step's mark: how it stands once it has started, and what it updates before. The restart waits behind a clock. */
function StepMark({ step }: { readonly step: UpdateAllStep }): ReactNode {
  const { item, state } = step
  if (state === 'done') return <Check size={12} aria-hidden="true" />
  if (state === 'failed') return <AlertTriangle size={12} aria-hidden="true" />
  if (state === 'running') return <LoaderCircle size={12} aria-hidden="true" className="update-all__spin" />
  if (state === 'waiting' || state === 'last') return <Clock size={12} aria-hidden="true" />
  if (item?.kind === 'client') return <ProviderMark provider={item.provider} name={item.name} size={12} />
  if (item?.kind === 'host') return <Server size={12} aria-hidden="true" />
  return <SottoMark className="update-all__sotto" />
}

/** What a screen reader hears after a step's title. */
const STATE_WORDS: Record<UpdateAllStepState, string> = {
  offered: 'to do', running: 'in progress', waiting: 'waiting for its threads', done: 'done', failed: 'did not finish', 'by-hand': 'yours to do',
  last: 'comes last', ready: 'ready',
}

function StepRow({ step, busy, onRetry, onStopThreads, onCancel }: {
  readonly step: UpdateAllStep; readonly busy: boolean
  readonly onRetry: (item: UpdateAllItem) => void; readonly onStopThreads: (item: UpdateAllItem) => void; readonly onCancel: (item: UpdateAllItem) => void
}): ReactNode {
  const [copied, showCopied] = useTransientFlag()
  const item = step.item
  const versionsId = useId(), detailId = useId()
  const described = [step.versions ? versionsId : '', step.detail ? detailId : ''].filter(Boolean).join(' ')
  const where = item?.machine.kind === 'host' ? ` on ${item.machine.name}` : ''
  const copy = (): void => { void writeClipboard(item?.commands ?? '').then(() => showCopied('Copied'), () => showCopied('Could not copy')) }
  const threads = `${item?.working ?? 0} ${item?.working === 1 ? 'thread' : 'threads'}`
  const actions = item ? [
    item.state === 'failed' ? <Button key="retry" variant="secondary" disabled={busy} aria-label={`Try again to update ${item.name}${where}`} onClick={() => onRetry(item)}>Try again</Button> : null,
    item.state === 'waiting' ? <Button key="stop" variant="secondary" disabled={busy} aria-label={`Stop ${threads}${where} and update its host now`} onClick={() => onStopThreads(item)}>Stop {threads} and update</Button> : null,
    item.cancellable ? <Button key="cancel" variant="ghost" disabled={busy} aria-label={`Cancel update, and leave ${item.machine.kind === 'host' ? item.machine.name : item.name} on ${item.versions.split(' → ')[0]}`} onClick={() => onCancel(item)}>Cancel update</Button> : null,
    item.commands ? <Button key="copy" variant="ghost" aria-label={`Copy the commands that update ${item.name}${where}`} onClick={copy}><Copy size={13} aria-hidden="true" />{copied ?? 'Copy commands'}</Button> : null,
  ].filter(Boolean) : []
  // The step's name is what it does and how it stands, and its versions and sentence describe it, so a reader that
  // announces the name alone still says what happened. The rail to the next step is the item's own ::before, so it is
  // never read out.
  return <li className="update-all__step" data-state={step.state} aria-label={`${step.title}, ${STATE_WORDS[step.state]}`} aria-describedby={described || undefined}>
    <span className="update-all__mark" aria-hidden="true"><StepMark step={step} /></span>
    <div className="update-all__body">
      <span className="update-all__name">{step.title}</span>
      {step.versions ? <span className="update-all__versions" id={versionsId}>{step.versions}</span> : null}
      {step.detail ? <small id={detailId}>{step.detail}</small> : null}
      {item?.percent === undefined ? null
        : <span className="update-all__bar" role="progressbar" aria-label="Sotto's download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.percent}><i style={{ width: `${item.percent}%` }} /></span>}
      {actions.length ? <div className="update-all__item-actions">{actions}</div> : null}
    </div>
  </li>
}

const EMPTY_PASS: UpdateAllPass = { touched: new Set(), after: new Set(), refused: new Map(), ranBefore: new Map() }
/** The versions a press asks hosts to update to, by item, added to those it asked for before. */
const targetsWith = (before: ReadonlyMap<string, string> | undefined, items: readonly UpdateAllItem[]): Map<string, string> =>
  new Map([...before ?? [], ...items.flatMap(item => item.target ? [[item.key, item.target] as const] : [])])

/**
 * Update all (ADR-0077, variant C of `prototype/update-all`): one card in the window's bottom-right corner, on Owl,
 * whenever Sotto, a client on this computer or on a connected host, or a host itself is out of date. One press starts
 * Sotto's download, puts every client Sotto can install into its machine's update line, and updates each host once the
 * clients asked of it have finished; then the card asks to restart. Its list is the press's steps in that order, ending
 * with the restart (layout C, "Steps", of `docs/prototypes/update-all-hosts-together-prototype.html`). It folds into a
 * pill, and Not now hides it until something new is published. It drives the updaters that already exist and owns
 * nothing but its press's bookkeeping.
 */
export function UpdateAllCard({ hosts: hostsBridge = window.sotto?.hosts }: { readonly hosts?: HostsBridge | undefined }): ReactNode {
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const hostsState = useHostsState(hostsBridge)
  const resumeFeature = useOwlFeature('resume-after-restart')
  const [pass, setPass] = useState<UpdateAllPass | null>(null)
  const [folded, setFolded] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const card = useRef<HTMLElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const state = agents?.state ?? null
  // This computer's own clients come from its own entry, whichever host the window has selected; the top level carries
  // them only while this computer is the one selected.
  const localHostId = state?.connections?.find(connection => connection.kind === 'local')?.hostId
  const sources = {
    app: app?.update ?? null, hosts: hostsState?.hosts ?? [], localHostId, clientHosts: state?.host.clientHosts ?? [], hostUpdates: hostsState?.updates ?? [],
    local: state?.host.clientHosts?.find(host => host.hostId === localHostId)?.clientUpdates ?? state?.clientUpdates ?? [],
  }
  const view = updateAllView(sources, pass)
  const working = (state?.host.threads ?? []).filter(thread => thread.remoteHost !== true && threadKeepsHostBusy(thread)).length
  const words = updateAllWords(view)
  const steps = updateAllSteps(view, { working, resumes: resumeFeature && app?.settings?.resumeThreadsAfterRestart === true })
  const latest = useRef({ view, sources, app })
  latest.current = { view, sources, app }
  const hidden = view.phase === 'hidden' || (view.phase === 'offer' || view.phase === 'done') && dismissed === view.fingerprint

  /** A client update as its machine publishes it now, for the result it last recorded. */
  const clientUpdate = useCallback((item: UpdateAllItem): ProviderClientUpdate | undefined => {
    const { sources: now } = latest.current
    if (item.kind !== 'client') return undefined
    if (item.machine.kind === 'local') return now.local.find(update => update.id === item.provider)
    const machine = item.machine
    if (machine.kind !== 'host') return undefined
    const hostId = now.hosts.find(host => host.id === machine.id)?.hostId
    return now.clientHosts.find(host => host.hostId === hostId)?.clientUpdates?.find(update => update.id === item.provider)
  }, [])
  const refuse = useCallback((keys: readonly string[], message: string): void => {
    setPass(current => ({ ...current ?? EMPTY_PASS, refused: new Map([...(current ?? EMPTY_PASS).refused, ...keys.map(key => [key, message] as const)]) }))
  }, [])
  /** Puts clients into a machine's own update line, which runs them one at a time and answers at once (ADR-0042). */
  const queueClients = useCallback((machine: string, providers: readonly ProviderId[]): void => {
    if (!providers.length) return
    const keys = providers.map(provider => clientKey(machine, provider))
    if (machine === 'local') {
      // Named, so the router sends it to this computer even while a remote host is selected.
      void agents?.command({ type: 'queue-client-updates', providers: [...providers], ...latest.current.sources.localHostId ? { hostId: latest.current.sources.localHostId } : {} }).then(
        result => { if (result?.error) refuse(keys, result.error) }, () => refuse(keys, UNREACHABLE))
    } else if (hostsBridge) {
      void hostsBridge.updateClients({ id: machine, action: 'update', providers: [...providers] }).then(
        result => { if (result.error) refuse(keys, result.error) }, error => refuse(keys, ipcMessage(error, UNREACHABLE)))
    }
  }, [agents, hostsBridge, refuse])
  /** A host's own update (ADR-0040), answering its busy-host question with Update when they finish (ADR-0077 decision 4). */
  const updateHost = useCallback(async (id: string): Promise<void> => {
    if (!hostsBridge) return
    try {
      const next = await hostsBridge.command({ type: 'host-update', id, action: 'update' })
      if (next.updates?.find(update => update.id === id)?.phase === 'confirm') await hostsBridge.command({ type: 'host-update', id, action: 'when-idle' })
    } catch (error) { refuse([hostKey(id)], ipcMessage(error, UNREACHABLE)) }
  }, [hostsBridge, refuse])
  const download = useCallback((): void => {
    void latest.current.app?.actions.downloadUpdate().then(ok => {
      const status = latest.current.app?.update
      if (!ok && !(status?.phase.phase === 'available' && status.phase.problem)) refuse([APP_KEY], 'The download did not finish. Nothing was installed. Try again.')
    })
  }, [refuse])

  const start = useCallback((): void => {
    // A Sotto download that failed goes again too, as Settings' Download did before Update all took its place.
    const offered = latest.current.view.items.filter(item => item.state === 'offered' || item.kind === 'app' && item.state === 'failed')
    if (!offered.length) return
    const hostOf = (item: UpdateAllItem): string | undefined => item.machine.kind === 'host' ? item.machine.id : undefined
    const clients = offered.filter(item => item.kind === 'client')
    const after = new Set(offered.filter(item => item.kind === 'host' && clients.some(client => hostOf(client) === hostOf(item))).flatMap(item => hostOf(item) ?? []))
    setPass({ touched: new Set(offered.map(item => item.key)), after, refused: new Map(),
      ranBefore: new Map(clients.map(item => [item.key, clientUpdate(item)?.ranAt] as const)), targets: targetsWith(undefined, offered) })
    setFolded(false); setFailure(null); setDismissed(null)
    if (offered.some(item => item.kind === 'app')) download()
    const byMachine = new Map<string, ProviderId[]>()
    for (const item of clients) {
      const machine = hostOf(item) ?? 'local'
      byMachine.set(machine, [...byMachine.get(machine) ?? [], item.provider!])
    }
    for (const [machine, providers] of byMachine) queueClients(machine, providers)
    for (const item of offered) if (item.kind === 'host' && !after.has(hostOf(item)!)) void updateHost(hostOf(item)!)
  }, [clientUpdate, download, queueClients, updateHost])

  // A client step the press finished stays done, even once a host's restart forgets what its update line ran.
  useEffect(() => {
    if (!pass) return
    const done = view.items.filter(item => item.kind === 'client' && item.state === 'done' && pass.touched.has(item.key) && pass.kept?.get(item.key)?.detail !== item.detail)
    if (!done.length) return
    setPass(current => current && { ...current, kept: new Map([...current.kept ?? [], ...done.map(item => [item.key, item] as const)]) })
  }, [pass, view])
  // A host whose clients the press asked for updates once none of them is still going, so its restart cuts none off.
  useEffect(() => {
    if (!pass?.after.size) return
    const due = [...pass.after].filter(id => !view.items.some(item => item.kind === 'client' && item.machine.kind === 'host' && item.machine.id === id
      && pass.touched.has(item.key) && item.state === 'running'))
    if (!due.length) return
    setPass(current => current && { ...current, after: new Set([...current.after].filter(id => !due.includes(id))) })
    for (const id of due) void updateHost(id)
  }, [pass, view, updateHost])

  /** A press whose button goes with it leaves focus on the card's own first control, never on the page behind. */
  const keepFocus = useCallback((): void => {
    requestAnimationFrame(() => { if (!card.current?.contains(document.activeElement)) card.current?.querySelector<HTMLElement>('.update-all__head button')?.focus() })
  }, [])
  /** Focus leaves a card that is going: to the focused thread's composer, as after any page-level dismissal. */
  const leave = useCallback((): void => {
    if (!card.current?.contains(document.activeElement)) return
    const composer = focusedComposerField() ?? document.querySelector<HTMLElement>('.thread-prompt :is(.prompt-editor, textarea)')
    composer?.focus()
  }, [])
  const retry = useCallback((item: UpdateAllItem): void => {
    setPass(current => {
      const base = current ?? EMPTY_PASS
      const refused = new Map(base.refused); refused.delete(item.key)
      return { ...base, touched: new Set([...base.touched, item.key]), refused, ranBefore: new Map([...base.ranBefore, [item.key, clientUpdate(item)?.ranAt]]), targets: targetsWith(base.targets, [item]) }
    })
    setDismissed(null)
    if (item.kind === 'app') download()
    else if (item.kind === 'client') queueClients(item.machine.kind === 'host' ? item.machine.id : 'local', [item.provider!])
    else if (item.machine.kind === 'host') void updateHost(item.machine.id)
    keepFocus()
  }, [clientUpdate, download, keepFocus, queueClients, updateHost])
  const stopThreads = useCallback((item: UpdateAllItem): void => {
    if (item.machine.kind !== 'host' || !hostsBridge) return
    const id = item.machine.id
    setPass(current => ({ ...current ?? EMPTY_PASS, touched: new Set([...(current ?? EMPTY_PASS).touched, item.key]), targets: targetsWith(current?.targets, [item]) }))
    void hostsBridge.command({ type: 'host-update', id, action: 'stop-threads' }).catch(error => refuse([item.key], ipcMessage(error, UNREACHABLE)))
    keepFocus()
  }, [hostsBridge, keepFocus, refuse])
  const cancel = useCallback((item: UpdateAllItem): void => {
    if (item.machine.kind !== 'host' || !hostsBridge) return
    void hostsBridge.command({ type: 'host-update', id: item.machine.id, action: 'cancel' }).catch(error => refuse([item.key], ipcMessage(error, UNREACHABLE)))
    keepFocus()
  }, [hostsBridge, keepFocus, refuse])
  const restart = useCallback(async (): Promise<void> => {
    setBusy(true); setFailure(null)
    try {
      const ok = await latest.current.app?.actions.installUpdate()
      if (!ok) {
        const status = latest.current.app?.update?.phase
        const problem = status && 'problem' in status ? status.problem : null
        setFailure(`Sotto could not install the update. ${problem ?? 'Nothing was changed.'} Try again, or restart from the update control.`)
      }
    } finally { setBusy(false) }
  }, [])
  const putAway = useCallback((): void => {
    if (hostsBridge) for (const item of latest.current.view.items) {
      if (item.kind === 'host' && item.state === 'done' && item.machine.kind === 'host') void hostsBridge.command({ type: 'host-update', id: item.machine.id, action: 'dismiss' }).catch(() => undefined)
    }
    leave()
    setPass(null)
    setDismissed(updateAllView(latest.current.sources, null).fingerprint)
  }, [hostsBridge, leave])
  const notNow = useCallback((): void => { leave(); setDismissed(latest.current.view.fingerprint) }, [leave])

  useEffect(() => {
    const listener = (): void => { setFolded(false); setDismissed(null); start() }
    requests.add(listener)
    return () => { requests.delete(listener) }
  }, [start])
  // Something new opens the card again, and so does the restart a press led to.
  const seen = useRef({ fingerprint: view.fingerprint, phase: view.phase })
  useEffect(() => {
    const before = seen.current
    seen.current = { fingerprint: view.fingerprint, phase: view.phase }
    if (view.phase === 'offer' && view.fingerprint !== before.fingerprint) setFolded(false)
    if (view.phase === 'restart' && before.phase !== 'restart' && pass) setFolded(false)
  }, [view.fingerprint, view.phase, pass])
  // The transient toasts share this corner; they stay clear of whatever height the card or its pill is.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (hidden) { root.style.removeProperty('--tt-corner-inset'); return }
    const height = (folded ? pill.current : card.current)?.getBoundingClientRect().height ?? 0
    root.style.setProperty('--tt-corner-inset', `${Math.round(height) + 28}px`)
    return () => { root.style.removeProperty('--tt-corner-inset') }
  })
  // Escape folds the card, only while it holds focus, so a press meant for something else never folds it.
  useEffect(() => {
    if (hidden || folded) return
    const fold = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !card.current?.contains(document.activeElement)) return
      event.preventDefault()
      setFolded(true)
    }
    window.addEventListener('keydown', fold)
    return () => window.removeEventListener('keydown', fold)
  }, [hidden, folded])
  const wasFolded = useRef(folded)
  useEffect(() => {
    // Focus follows the press that folds or unfolds, so it is never left on a control that went.
    if (wasFolded.current !== folded && (card.current?.contains(document.activeElement) || pill.current === document.activeElement || document.activeElement === document.body)) {
      if (folded) pill.current?.focus(); else card.current?.querySelector<HTMLElement>('.update-all__head button')?.focus()
    }
    wasFolded.current = folded
  }, [folded])

  if (!app || hidden) return null
  const failed = view.items.some(item => item.state === 'failed')
  if (folded) {
    return <button ref={pill} type="button" className="update-all-pill tt-focusable" data-phase={view.phase} data-failed={failed || undefined}
      aria-label={`${words.pill}. Show updates`} title={words.pill} onClick={() => setFolded(false)}>
      <PhaseGlyph phase={view.phase} failed={failed} /><span>{words.pill}</span>
    </button>
  }
  const offered = view.items.filter(item => item.state === 'offered').length
  const actions = view.phase === 'offer'
    ? offered
      ? <><Button variant="primary" disabled={busy} aria-label={`Update all: ${words.summary}`} onClick={start}>Update all</Button>
        <Button variant="ghost" aria-label="Not now: hide these updates until something new is published" onClick={notNow}>Not now</Button></>
      : <Button variant="ghost" aria-label="Dismiss: hide these until something new is published" onClick={notNow}>Dismiss</Button>
    : view.phase === 'restart'
      ? <><Button variant="primary" disabled={busy} aria-label={`Restart Sotto now and install ${view.ready}`} onClick={() => void restart()}>Restart now</Button>
        <Button variant="ghost" aria-label="Later: fold this card. The update control keeps the download." onClick={() => setFolded(true)}>Later</Button></>
      : view.phase === 'done' ? <Button variant="ghost" aria-label="Dismiss the results of Update all" onClick={putAway}>Dismiss</Button> : null
  // The landmark keeps one name whatever the phase; the heading inside says where things stand.
  return <section ref={card} className="update-all" data-phase={view.phase} aria-label="Updates" aria-describedby={titleId}>
    <header className="update-all__head">
      <div aria-live="polite"><strong id={titleId}>{words.title}</strong><span>{words.sub}</span></div>
      <Button variant="ghost" iconOnly aria-label="Fold updates into a button" title="Fold" onClick={() => setFolded(true)}><ChevronDown size={16} aria-hidden="true" /></Button>
    </header>
    <div className="update-all__list">
      <ol className="update-all__steps" aria-label="Steps, in order">
        {steps.map(step => <StepRow key={step.key} step={step} busy={busy} onRetry={retry} onStopThreads={stopThreads} onCancel={cancel} />)}
      </ol>
    </div>
    {words.notes.length ? <div className="update-all__notes">{words.notes.map(note => <p key={note}>{note}</p>)}</div> : null}
    {failure ? <p className="update-all__error" role="alert">{failure}</p> : null}
    {actions ? <div className="update-all__actions">{actions}</div> : null}
  </section>
}
