import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { AgentModel, AgentState } from '../../../shared/agents'
import type { WatcherOpenRequest } from '../../../shared/watcherRoom'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import { Select } from '../components/Select'
import { PageWindowControls } from '../components/WindowControls'
import { useOptionalApp } from '../state/AppContext'
import { useAgents } from '../agents/AgentContext'
import { EffortPicker } from '../agents/EffortPicker'
import { ModelPicker } from '../agents/ModelPicker'
import { useClock } from '../agents/paneGrid'
import { OverviewSidebarFrame, SidebarChromeProvider } from '../agents/SidebarFrame'
import { useShared } from '../agents/stateSharing'
import { describeThreads, providerKey } from '../agents/threadFacts'
import { effortChoices } from '../agents/ThreadOptions'
import { ThreadPane } from '../agents/ThreadPane'
import { useWatcherRoom, type WatcherRoom } from './watcherRoom'
import { WatcherOverview } from './WatcherOverview'
import { WatcherOwl } from './WatcherOwl'

const WATCHER_PROMPT_ID = 'watcher-prompt'
const LIMITS = [1, 2, 3, 4, 5, 6, 7, 8] as const
type WatcherProvider = WatcherOpenRequest['provider']
const WATCHER_PROVIDERS: ReadonlySet<string> = new Set<WatcherProvider>(['codex', 'claude', 'grok'])

/** Devin cannot host Watcher's tools, so only Codex, Claude Code and Grok Build models are offered for it. */
function watcherProviderOf(model: AgentModel): WatcherProvider | null {
  const provider = model.providerId ?? providerKey(model.provider)
  return WATCHER_PROVIDERS.has(provider) ? provider as WatcherProvider : null
}

/**
 * How many threads Watcher is working with, out of how many it may: "3 of 4 watched". Lowering the limit below
 * that stops nothing, so the count can stand above the limit for a while, and says so.
 */
function WatcherMeter({ inFlight, limit }: { readonly inFlight: number; readonly limit: number }): ReactNode {
  return <span className="watcher-meter" role="meter" aria-label="Watched threads" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(inFlight, limit)}
    aria-valuetext={`${inFlight} of ${limit} watched`} title={`Watcher works with up to ${limit} ${limit === 1 ? 'thread' : 'threads'} at once`}>
    <span className="watcher-meter__cells" aria-hidden="true">{LIMITS.slice(0, limit).map(cell => <i key={cell} data-on={cell <= inFlight || undefined} />)}</span>
    <span aria-hidden="true">{inFlight} of {limit}<span className="watcher-meter__more"> watched</span></span>
  </span>
}

/**
 * More Watcher actions: a small panel under its button, holding Threads in flight, the one setting Watcher has.
 * It saves as it changes, like Settings. Escape or a press outside closes it and returns focus to the button.
 */
function WatcherActions({ room, limit }: { readonly room: WatcherRoom; readonly limit: number }): ReactNode {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const select = useRef<HTMLSelectElement>(null)
  const panelId = useId()
  useEffect(() => {
    if (!open) return
    select.current?.focus()
    const away = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  const close = (): void => { setOpen(false); button.current?.focus() }
  const change = async (next: number): Promise<void> => {
    if (room.setLimit === null) return
    setError(null)
    // The field stays live while main saves, so it keeps focus; main's answer, or the next change, is what shows.
    try { setError(room.settle(await room.setLimit({ limit: next }))) } catch { setError('Sotto could not save the limit. It is unchanged.') }
  }
  return <div className="watcher-actions">
    <button ref={button} type="button" className="pane-action tt-focusable" aria-label="More Watcher actions" title="More Watcher actions"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} id={panelId} className="watcher-actions__panel" role="dialog" aria-label="Watcher settings"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}
      onBlur={event => { const next = event.relatedTarget as Node | null; if (next !== null && !event.currentTarget.contains(next) && next !== button.current) setOpen(false) }}>
      <Field label="Threads in flight" description="Watcher works with at most this many threads at once. Lowering it stops nothing: new work waits until fewer are in flight.">
        <Select ref={select} value={String(limit)} onChange={event => void change(Number(event.currentTarget.value))}>
          {LIMITS.map(value => <option key={value} value={value}>{value}</option>)}
        </Select>
      </Field>
      {error ? <p className="watcher-actions__error" role="alert">{error}</p> : null}
    </div> : null}
  </div>
}

/** Watcher's header in place of a thread's: the owl and its name, how many threads it is working with, and its actions. */
function WatcherHeader({ room, limit }: { readonly room: WatcherRoom; readonly limit: number }): ReactNode {
  return <header className="thread-workspace__head watcher-head">
    <div className="thread-workspace__title">
      <WatcherOwl size={16} className="watcher-head__owl" />
      <h2>Watcher</h2>
    </div>
    <div className="thread-workspace__actions">
      <WatcherMeter inFlight={room.state?.inFlight ?? 0} limit={limit} />
      <WatcherActions room={room} limit={limit} />
    </div>
  </header>
}

/**
 * The first time the room opens: what Watcher is, and which of the user's own providers it runs on. Starting it
 * creates one durable Watcher thread in main and selects nothing anywhere.
 */
function WatcherFirstEntry({ state, room }: { readonly state: AgentState; readonly room: WatcherRoom }): ReactNode {
  const app = useOptionalApp()
  const models = useMemo(() => state.host.models.filter(model => model.ready !== false && watcherProviderOf(model) !== null), [state.host.models])
  const [modelId, setModelId] = useState('')
  const model = models.find(item => item.id === modelId) ?? models[0]
  const [effort, setEffort] = useState<string | null>(null)
  const reasoning = effort ?? model?.defaultReasoningEffort ?? ''
  const efforts = effortChoices(model, reasoning)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const start = async (): Promise<void> => {
    const provider = model === undefined ? null : watcherProviderOf(model)
    if (model === undefined || provider === null || room.open === null) return
    setStarting(true); setError(null)
    try {
      const refusal = room.settle(await room.open({ provider, modelId: model.id, ...(reasoning ? { reasoningEffort: reasoning } : {}) }))
      if (refusal !== null) { setError(refusal); setStarting(false) }
    } catch {
      setError('Sotto could not start Watcher. Nothing was started. Try again.')
      setStarting(false)
    }
  }
  return <div className="thread-workspace__empty thread-workspace__empty--page watcher-first">
    <WatcherOwl size={30} className="watcher-first__owl" />
    <h2 ref={heading} tabIndex={-1}>Start Watcher</h2>
    <p>Watcher is a thread that starts and briefs your other threads, and keeps an eye on them while they work.</p>
    <p>It runs on your own Codex, Claude Code or Grok Build account, with that provider’s own tools. It asks before it changes anything, and only you answer a thread’s questions and permissions.</p>
    {model === undefined ? <>
      <p className="watcher-first__missing">Connect Codex, Claude Code or Grok Build in Settings, under Providers, to start Watcher.</p>
      {app ? <div className="thread-workspace__empty-actions"><Button variant="secondary" onClick={() => app.actions.navigate('settings')}>Open Settings</Button></div> : null}
    </> : <>
      <div className="watcher-first__choices thread-options thread-options--chips" role="group" aria-label="Watcher’s model">
        <ModelPicker models={models} modelId={model.id} disabled={starting} onChange={id => { setModelId(id); setEffort(null) }} />
        {efforts.length > 0 ? <EffortPicker key={model.id} value={reasoning} options={efforts} disabled={starting} onChange={setEffort}
          defaultValue={model.defaultReasoningEffort} modelName={model.name} /> : null}
      </div>
      <div className="thread-workspace__empty-actions">
        <Button disabled={starting || room.open === null} onClick={() => void start()}>{starting ? 'Starting Watcher…' : 'Start Watcher'}</Button>
      </div>
    </>}
    {error ? <p className="agent-error watcher-first__error" role="alert">{error}</p> : null}
  </div>
}

/** The current Watcher's real thread pane: its transcript, its request cards and its composer, under Watcher's header. */
function WatcherMaster({ state, room, threadId, now }: { readonly state: AgentState; readonly room: WatcherRoom; readonly threadId: string; readonly now: number | undefined }): ReactNode {
  const agents = useAgents()
  const app = useOptionalApp()
  const command = agents.command
  const clock = useClock(now)
  const rows = useShared(useMemo(() => describeThreads(state, clock), [state, clock]))
  const row = rows.find(item => item.thread.id === threadId)
  // The room reads Watcher's history while it is on screen, as Threads does for its panes, and lets it go after.
  useEffect(() => {
    void command({ type: 'observe-threads', threadIds: [threadId] })
    return () => { void command({ type: 'observe-threads', threadIds: [] }) }
  }, [command, threadId])
  if (row === undefined) return <p className="watcher-room__status" role="status">Opening Watcher…</p>
  const limit = room.state?.inFlightLimit ?? app?.settings?.watcherInFlightLimit ?? 4
  return <div className="thread-panes">
    <div className="thread-panes__area">
      <section className="thread-pane watcher-pane" data-thread-id={threadId} data-focused data-under-controls role="region" aria-label="Watcher">
        <ThreadPane row={row} state={state} command={command} store={agents.threadDrafts} focused promptId={WATCHER_PROMPT_ID}
          error={state.error ?? agents.error} now={now} watcherHeader={<WatcherHeader room={room} limit={limit} />} />
      </section>
    </div>
  </div>
}

/**
 * Watcher's room (ADR-0073): the Overview in the sidebar's frame, and Watcher's own conversation beside it. The
 * room keeps its own view: it never selects a thread or a project on the Threads page, and Watcher itself is
 * listed in neither the Overview nor Threads.
 */
export function WatcherView({ now: fixedNow, updateControl }: {
  /** A fixed clock for captures; the rows' times then hold still. */
  readonly now?: number | undefined
  readonly updateControl?: ReactNode
}): ReactNode {
  const agents = useAgents()
  const app = useOptionalApp()
  const room = useWatcherRoom()
  const now = useClock(fixedNow)
  const state = agents.state
  const mac = app?.platform === 'darwin'
  const current = room?.state?.current ?? null
  let main: ReactNode
  if (room === null || room.status === 'unavailable') main = <p className="watcher-room__status" role="status">Watcher is not available in this build. Nothing was started.</p>
  else if (state === null || room.status === 'loading') main = <p className="watcher-room__status" role="status">{agents.error ?? 'Opening Watcher…'}</p>
  else if (room.error !== null && room.state === null) main = <p className="agent-error watcher-room__status" role="alert">{room.error}</p>
  else if (current === null) main = <WatcherFirstEntry state={state} room={room} />
  else if (room.currentThreadId === null) main = <p className="watcher-room__status" role="status">Opening Watcher…</p>
  else main = <WatcherMaster state={state} room={room} threadId={room.currentThreadId} now={fixedNow} />
  return <SidebarChromeProvider updateControl={updateControl}><div className={`management-view threads-view watcher-room${mac ? ' threads-view--mac' : ''}`}>
    <OverviewSidebarFrame label="Overview" title="Watcher">
      {state === null ? <p className="thread-nav__empty">{agents.error ?? 'Preparing agent controls…'}</p>
        : <WatcherOverview state={state} now={now} liveClock={fixedNow === undefined} watched={room?.watchedThreadIds ?? new Set()} exclude={room?.currentThreadId ?? null} />}
    </OverviewSidebarFrame>
    <section className="thread-workspace" aria-label="Watcher’s room">
      <div className="thread-workspace__body">{main}</div>
    </section>
    <PageWindowControls />
  </div></SidebarChromeProvider>
}
