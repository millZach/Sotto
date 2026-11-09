import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type AgentModel, type AgentProject, type AgentThread } from '../../../../shared/agents'
import { COUNCIL_CHAIR, COUNCIL_KINDS, COUNCIL_LETTERS, COUNCIL_SEAT_EFFORT, DEFAULT_COUNCIL_LAYOUT, councilEffort, councilSeatsInForce, councilSeatsReady, type CouncilBridge, type CouncilCommand, type CouncilCounts, type CouncilEstimate, type CouncilKind,
  type CouncilRoundView, type CouncilRow, type CouncilRowAction, type CouncilThreadState, type CouncilTurnStage, type CouncilView as CouncilRecord } from '../../../../shared/council'
import { chosenModelId, resolveModel } from '../../../../shared/modelCatalog'
import { useOptionalAgents } from '../../agents/AgentContext'
import { ModelPicker } from '../../agents/ModelPicker'
import { ProviderMark } from '../../agents/ProviderMark'
import { newThreadDefaultsCatalog } from '../../agents/newThread'
import { useOptionalApp } from '../../state/AppContext'
import { CouncilChamber } from './CouncilChamber'
import { CouncilSeats, type CouncilPanel } from './CouncilSeats'
import { useCouncils } from './useCouncils'
import { clearCouncilDraft, councilAskable, councilMode, heldCouncilForm, holdCouncilForm, holdCouncilMode, onCouncilDraft, onCouncilMode, readCouncilDraft, type CouncilDraft } from './councilDraft'
import { supportsClimbJudging, type ClimbRecord } from '../../../../shared/councilClimb'
import { ClimbPanel, type ClimbSeatsState } from './ClimbPanel'
import { SegmentedControl } from '../../components/SegmentedControl'
import { ULTRACODE, withoutUltracode } from '../../../../shared/ultracode'
import { AskedByLine } from './AskedByLine'
import { CouncilGrid } from './CouncilGrid'
import { groupCellTurns, turnNeedsYou } from './councilGridModel'
import './council.css'


/**
 * The Council the chamber shows: the one being worked now, the newest if several are; with none, the newest Council
 * when it is finished, holding its last scene until the user starts a new question in the Ask form (`drafting`) or
 * another Council starts; otherwise none, for the Ask view. A stopped or settled newest Council gives the Ask view.
 */
export function chamberCouncil(councils: readonly CouncilRecord[] | null, drafting: boolean): CouncilRecord | null {
  let live: CouncilRecord | null = null, newest: CouncilRecord | null = null
  for (const council of councils ?? []) {
    if (newest === null || council.createdAt > newest.createdAt) newest = council
    if (council.status !== 'working' && council.status !== 'waiting') continue
    if (live === null || council.createdAt > live.createdAt) live = council
  }
  return live ?? (!drafting && newest?.status === 'done' ? newest : null)
}

type CouncilViewProps = { readonly thread?: string | undefined; readonly bridge?: CouncilBridge | undefined }

/**
 * The Council (ADR-0177), the Council tab of a thread pane's drawer: the chamber (`CouncilChamber`, decision 6), the
 * seats across the drawer's whole width under it, and beside the chamber the Ask form and each Council as a text record
 * of its stages, its threads' states and the actions their turns offer, the verdict with Sotto's counts, and Send to the
 * thread. The record is the accessible form of the deliberation. `thread` is the pane's thread, where a question starts
 * from unless the user changes it. Records belong to their origin; drafts and mode belong to this pane’s thread.
 */
export function CouncilView(props: CouncilViewProps): ReactNode {
  return <ThreadCouncilView key={props.thread ?? ''} {...props} />
}

function ThreadCouncilView({ thread, bridge = window.sotto?.council }: CouncilViewProps): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const { councils, failed } = useCouncils(bridge)
  const ownCouncils = thread === undefined ? councils : councils?.filter(council => council.origin.thread === thread) ?? null
  const [mode, setMode] = useState<'ask' | 'climb'>(() => councilMode(thread ?? ''))
  useEffect(() => { holdCouncilMode(thread ?? '', mode) }, [mode, thread])
  // A thread's agent that starts a Climb, or a Council, brings this tab to it (ADR-0177, November 5, 2026).
  useEffect(() => onCouncilMode(() => setMode(councilMode(thread ?? ''))), [thread])
  const settings = app?.settings
  const state = agents?.state
  const catalog = useMemo(() => state ? newThreadDefaultsCatalog(state) : [], [state])
  // What the tab held when the drawer last showed a shell or hid.
  const [held] = useState(() => heldCouncilForm(thread ?? ''))
  // The Ask form's seats, starting from Settings → Council; the chamber seats a figure for each.
  const [panel, setPanel] = useState<CouncilPanel | null>(held?.panel ?? null)
  const [climbRecord, setClimbRecord] = useState<ClimbRecord | null>(null)
  const [climbSeats, setClimbSeats] = useState<ClimbSeatsState | null>(null)
  const judgingCatalog = useMemo(() => (state?.host.models ?? []).filter(model => supportsClimbJudging(model.providerId, app?.platform ?? 'win32') && model.ready && !model.legacy)
    .map(model => ({ ...model, reasoningEfforts: withoutUltracode(model.reasoningEfforts ?? []), defaultReasoningEffort: model.defaultReasoningEffort === ULTRACODE ? withoutUltracode(model.reasoningEfforts ?? [])[0] : model.defaultReasoningEffort })), [state?.host.models, app?.platform])
  // Ask the Council on a reply opens this tab with that thread and reply filled in, or fills it in when it is open.
  const [taken, setTaken] = useState(() => ({ draft: ownDraft(thread), revision: 0 }))
  const draft = taken.draft
  const [question, setQuestion] = useState(draft?.question ?? held?.question ?? '')
  const [chosenOrigin, setChosenOrigin] = useState<string | null>(draft ? null : held?.origin ?? null)
  useEffect(() => {
    const take = (): void => {
      const next = ownDraft(thread)
      if (!next) return
      clearCouncilDraft()
      setTaken(current => current.draft === next ? current : { draft: next, revision: current.revision + 1 })
      setQuestion(next.question)
      setChosenOrigin(null)
    }
    take()
    return onCouncilDraft(take)
  }, [thread])
  useEffect(() => { holdCouncilForm(thread ?? '', { question, panel, origin: chosenOrigin }) }, [thread, question, panel, chosenOrigin])
  const seatsPanel: CouncilPanel = panel ?? { panelists: settings?.councilPanelists ?? [null, null, null], chair: settings?.councilChair ?? null }
  const seats = useSeatsInForce(mode === 'climb' ? climbSeats?.panel ?? { panelists: [], chair: null } : seatsPanel, mode === 'climb' ? judgingCatalog : catalog)
  const layout = settings?.councilLayout ?? DEFAULT_COUNCIL_LAYOUT
  const shownCouncil = chamberCouncil(ownCouncils, question.trim() !== '' || panel !== null)
  return <div className="council-view" data-layout={layout}>
    <CouncilChamber climb={mode === 'climb' ? climbRecord : null} council={mode === 'climb' ? null : shownCouncil} askSeats={seats} layout={layout} />
    {/* The seats, under the figures they seat and as wide as the drawer, before the question in the Tab order. */}
    {mode === 'ask' && bridge && state && settings ? <div className="council-seats-bar"><CouncilSeats panel={seatsPanel} catalog={catalog} onChange={setPanel} /></div> : null}
    {mode === 'climb' && climbSeats?.visible ? <div className="council-seats-bar"><CouncilSeats panel={climbSeats.panel} catalog={judgingCatalog} onChange={climbSeats.onChange} disabled={climbSeats.disabled} judging /></div> : null}
    <div className="council-scroll"><div className="council-page">
      {bridge?.climb ? <SegmentedControl label={t`Council mode`} value={mode} options={[{ value: 'ask', label: t`Ask` }, { value: 'climb', label: t`Climb` }]} onChange={value => setMode(value as 'ask' | 'climb')} /> : null}
      {mode === 'climb' && bridge ? <ClimbPanel thread={thread} bridge={bridge} onPanel={setClimbSeats} onRecord={setClimbRecord} /> : <>
      {/* A new draft is a new question from its thread: the form starts again from it. */}
      {bridge ? <AskForm key={taken.revision} bridge={bridge} origin={draft?.originThread ?? chosenOrigin ?? thread} onOrigin={setChosenOrigin} panel={seatsPanel}
        onPanel={setPanel} question={question} onQuestion={setQuestion} /> : null}
      {bridge && councils === null && !failed ? <p className="council-muted tt-paragraph" role="status">{t`Reading the Councils…`}</p> : null}
      {failed ? <p className="council-notice tt-paragraph" role="status">{t`Sotto could not read the Councils. Nothing was changed. Open the Council again.`}</p> : null}
      <div className="council-list">{(ownCouncils ?? []).map(council => <CouncilEntry key={council.id} council={council} bridge={bridge!}
        showSeats={shownCouncil?.id !== council.id || (layout === 'long-table' && council.rounds.at(-1)?.verdict != null)} />)}</div>
      </>}
    </div></div>
  </div>
}

/** The draft waiting for this tab: one asked from its thread, or any while the tab stands for no thread. */
function ownDraft(thread: string | undefined): CouncilDraft | null {
  const draft = readCouncilDraft()
  return draft && (thread === undefined || draft.originThread === thread) ? draft : null
}

/**
 * The seats as they would start now, the same object for as long as what they hold is the same: every update of every
 * thread brings a new catalog, and a new seats object would redraw the chamber for nothing.
 */
export function useSeatsInForce(panel: CouncilPanel, catalog: readonly AgentModel[]): ReturnType<typeof councilSeatsInForce> {
  // The panel by its content: a new object for the same seats is the same seats.
  const panelKey = JSON.stringify(panel)
  const seats = useMemo(() => councilSeatsInForce(panel.panelists, panel.chair, catalog), [panelKey, catalog])
  const seatsKey = JSON.stringify([...seats.panelists, seats.chair].map(seat => seat && [seat.modelId, seat.model?.name, seat.provider, seat.ready, seat.reasoningEffort, seat.from]))
  return useMemo(() => seats, [seatsKey])
}

/**
 * The thread a Council question comes from: the thread the user was on when they opened the Council, shown as one line.
 * Its title opens a list grouped by project, as the sidebar groups threads, that typing narrows by title or project.
 */
export function OriginPicker({ threads, projects, chosen, onChoose }: { readonly threads: readonly AgentThread[]; readonly projects: readonly AgentProject[]
  readonly chosen: string; readonly onChoose: (id: string) => void }): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const change = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const projectTitle = (thread: AgentThread): string => projects.find(project => project.id === thread.projectId)?.title ?? ''
  const thread = threads.find(item => item.id === chosen)
  const close = (): void => { setOpen(false); setQuery(''); change.current?.focus() }
  const words = query.trim().toLocaleLowerCase()
  const hits = threads.filter(item => !words || `${item.title} ${projectTitle(item)}`.toLocaleLowerCase().includes(words))
  const groups = [...new Set(hits.map(item => item.projectId))]
  const choose = (id: string): void => { onChoose(id); close() }
  return <div className="council-field">
    <div className="council-origin">
      {thread ? <><ProviderMark provider={thread.providerId} name={thread.title} size={14} />
        {threads.length > 1 ? <button ref={change} type="button" className="council-origin__title council-origin__change tt-focusable"
          aria-label={t`Ask from another thread. Now ${thread.title}`} aria-expanded={open} aria-controls={open ? listId : undefined}
          onClick={() => open ? close() : setOpen(true)}>{thread.title}</button>
          : <span className="council-origin__title">{thread.title}</span>}</>
        : <span className="council-origin__title">{t`No open thread on this computer`}</span>}
    </div>
    {open && threads.length > 1 ? <div id={listId} className="council-origin__list" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <input className="tt-input tt-focusable council-origin__search" autoFocus value={query} aria-label={t`Find a thread`} placeholder={t`Find a thread`}
        onChange={event => setQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && hits[0]) { event.preventDefault(); choose(hits[0].id) } }} />
      <div className="council-origin__rows">
        {hits.length === 0 ? <p className="council-origin__empty tt-paragraph">{t`No thread matches.`}</p> : groups.map(group => { const items = hits.filter(item => item.projectId === group), title = projectTitle(items[0]!); return <div key={group} role="group" aria-label={title || undefined}>
          {title ? <p className="council-origin__group">{title}</p> : null}
          {items.map(item => <button key={item.id} type="button" className="council-origin__row tt-focusable"
            aria-current={item.id === chosen || undefined} onClick={() => choose(item.id)}>
            <ProviderMark provider={item.providerId} name={item.title} size={14} /><span className="council-origin__title">{item.title}</span></button>)}
        </div> })}
      </div>
    </div> : null}
  </div>
}

function AskForm({ bridge, origin: offeredOrigin, onOrigin, panel: seatsPanel, onPanel: setPanel, question, onQuestion: setQuestion }: { readonly bridge: CouncilBridge; readonly origin: string | undefined
  readonly onOrigin: (origin: string) => void; readonly panel: CouncilPanel
  readonly onPanel: (panel: CouncilPanel | null) => void; readonly question: string; readonly onQuestion: (question: string) => void }): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const state = agents?.state
  const settings = app?.settings
  const questionId = useId()
  const catalog = useMemo(() => state ? newThreadDefaultsCatalog(state) : [], [state])
  const local = state?.connections?.find(connection => connection.kind === 'local')?.hostId
  const threads = useMemo(() => (state?.host.threads ?? []).filter(thread => councilAskable(thread, local))
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')), [state, local])
  const [origin, setOrigin] = useState<string>(offeredOrigin ?? '')
  const [estimate, setEstimate] = useState<CouncilEstimate | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const shownOrigin = threads.some(thread => thread.id === origin) ? origin : (threads.some(thread => thread.id === state?.activeThreadId) ? state!.activeThreadId! : threads[0]?.id ?? '')
  useEffect(() => {
    setEstimate(null)
    if (!shownOrigin) return
    let live = true
    void bridge.estimate({ originThread: shownOrigin }).then(read => { if (live) setEstimate(read) }, () => undefined)
    return () => { live = false }
  }, [bridge, shownOrigin])
  if (!state || !settings) return <p className="council-notice tt-paragraph" role={agents?.error ? 'alert' : 'status'}>{agents?.error ?? t`Preparing the Council…`}</p>
  const seats = councilSeatsInForce(seatsPanel.panelists, seatsPanel.chair, catalog)
  const ready = councilSeatsReady(seats)
  const reads = estimate && 'words' in estimate ? estimate : null
  // About four characters a token. A seat's model is warned of only when a thread on it reported a smaller context window.
  const tokens = Math.ceil((reads?.characters ?? 0) / 4)
  const windows = new Map<string, number>()
  for (const thread of state.host.threads) {
    const window = thread.usage?.contextWindow
    if (window && window > (windows.get(thread.modelId) ?? 0)) windows.set(thread.modelId, window)
  }
  const small = reads ? [...seats.panelists.map((seat, index) => ({ seat, who: COUNCIL_LETTERS[index]! })), { seat: seats.chair, who: t`Chair` }]
    .flatMap(({ seat, who }) => { const window = seat ? windows.get(seat.modelId) : undefined; return seat && window && window < tokens ? [{ who, model: seat.model?.name ?? seat.modelId }] : [] }) : []
  const ask = async (): Promise<void> => {
    if (!ready || !question.trim() || !shownOrigin || busy) return
    setBusy(true); setMessage(null)
    const choice = (seat: (typeof seats.panelists)[number]) => ({ modelId: seat!.modelId, reasoningEffort: seat!.reasoningEffort })
    const result = await bridge.command({ type: 'start', originThread: shownOrigin, question: question.trim(), panelists: seats.panelists.map(choice), chair: choice(seats.chair) })
      .catch(() => ({ ok: false as const, message: t`Sotto could not ask the Council. Nothing was started. Try again.` }))
    setBusy(false)
    if (result.ok) { setQuestion(''); setPanel(null) } else setMessage(result.message)
  }
  return <section className="council-ask" aria-labelledby={questionId}>
    <h2 id={questionId} className="tt-visually-hidden">{t`Ask the Council`}</h2>
    <div className="council-composer">
      <textarea className="tt-input tt-focusable council-ask__question" value={question} rows={2} aria-label={t({ message: 'Question', comment: 'The question put to the Council' })}
        onChange={event => setQuestion(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask() } }} />
      <div className="council-composer__footer">
        <OriginPicker threads={threads} projects={state.host.projects} chosen={shownOrigin} onChoose={id => { setOrigin(id); onOrigin(id) }} />
        <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={!ready || !question.trim() || !shownOrigin || busy} onClick={() => void ask()}>
          {busy ? t`Asking the Council…` : t`Ask the Council`}</button>
      </div>
    </div>
    {small.map(({ who, model }) => <p key={who} className="council-notice tt-paragraph">
      {t`${who}’s model, ${model}, holds less than this conversation and may lose its start.`}</p>)}
    {estimate && 'unavailable' in estimate ? <p className="council-notice tt-paragraph">{estimate.unavailable}</p> : null}
    {message ? <p className="council-notice tt-paragraph" role="status">{message}</p> : null}
  </section>
}

function useWords() {
  const { t } = useLingui()
  return {
    state: (state: CouncilThreadState): string => ({ working: t`Working`, waiting: t`Waiting on you`, done: t`Done`, failed: t`Failed`, stopped: t`Stopped`, unknown: t`Unknown` })[state],
    stage: (stage: CouncilTurnStage): string => ({ history: t`Reading the conversation`, framing: t`Framing`, answer: t`Answer`, review: t`Review`, crux: t`Crux check`, verdict: t`Verdict`, fairness: t`Fairness check`,
      amend: t`Answer to objections` })[stage],
    action: (action: CouncilRowAction): string => ({ retry: t`Retry`, replace: t`Use another model`, skip: t`Go on without it` })[action],
    seat: (seat: string): string => seat === COUNCIL_CHAIR ? t`Chair` : seat,
  }
}

function CouncilEntry({ council, bridge, showSeats }: { readonly council: CouncilRecord; readonly bridge: CouncilBridge; readonly showSeats: boolean }): ReactNode {
  const { t } = useLingui()
  const words = useWords()
  const [notice, setNotice] = useState<string | null>(null)
  const headingId = useId()
  const run = async (command: CouncilCommand): Promise<void> => {
    setNotice(null)
    const result = await bridge.command(command).catch(() => ({ ok: false as const, message: t`Sotto could not do that. Nothing was changed. Try again.` }))
    if (!result.ok) setNotice(result.message)
  }
  const first = council.rounds[0]!
  const open = council.status !== 'settled'
  const running = council.status === 'working' || council.status === 'waiting'
  const seatNames = council.seats.map(seat => `${words.seat(seat.seat)}: ${seat.modelName}${seat.provider ? ` (${PROVIDER_LABELS[seat.provider]})` : ''}`).join(' · ')
  return <article className="council-entry" aria-labelledby={headingId} data-status={council.status}>
    <header className="council-entry__head">
      <div className="council-entry__title">
        <h2 id={headingId}>{first.question ?? t`A question whose words are not kept`}</h2>
      </div>
      <div className="council-entry__actions">
        {council.status === 'stopped' || council.status === 'settled' ? <span className="council-entry__meta">{council.status === 'stopped' ? t`Stopped` : t`Settled`}</span> : null}
        {running ? <button type="button" className="tt-button tt-focusable" onClick={() => void run({ type: 'stop', council: council.id })}>{t`Stop`}</button> : null}
        {open && !running ? <button type="button" className="tt-button tt-focusable" onClick={() => void run({ type: 'settle', council: council.id })}>{t`Settle`}</button> : null}
      </div>
    </header>
    <AskedByLine askedBy={council.askedBy} />
    {showSeats ? <p className="council-entry__seats tt-paragraph">{seatNames}</p> : null}
    {!council.snapshot ? <p className="council-entry__meta tt-paragraph">{t`Not a Git repository, so Sotto can’t check cited lines.`}</p> : null}
    {council.stoppedBecause === 'words-lost' ? <p className="council-notice tt-paragraph">{t`Sotto restarted while Keep local history was off, so this Council’s words are gone and it cannot go on.`}</p> : null}
    {council.rounds.map(round => <RoundRecord key={round.index} council={council} round={round} run={run} />)}
    {notice ? <p className="council-notice tt-paragraph" role="status">{notice}</p> : null}
  </article>
}

export function RoundRecord({ council, round, run }: { readonly council: CouncilRecord; readonly round: CouncilRoundView; readonly run: (command: CouncilCommand) => Promise<void> }): ReactNode {
  const { t } = useLingui()
  const [expanded, setExpanded] = useState(false)
  const latest = round.index === council.rounds.at(-1)?.index
  const leftOut = round.leftOut.filter(seat => seat !== COUNCIL_CHAIR).join(', ')
  const seats = [...council.seats.filter(seat => seat.seat !== COUNCIL_CHAIR), ...council.seats.filter(seat => seat.seat === COUNCIL_CHAIR)]
  const framingAbove = round.reframable || !round.rows.some(row => row.seat === COUNCIL_CHAIR && (row.stage === 'framing' || row.stage === 'history'))
  const crux = round.crux ? <p className="council-crux tt-paragraph">{round.crux.lookup ? t`Crux check, a lookup: ${round.crux.test}` : t`Crux check: ${round.crux.test}`}{round.crux.result ? ` ${t`Result: ${round.crux.result}`}` : ''}</p> : null
  const content = <>
    {round.framing && framingAbove ? <Framing framing={round.framing} council={council} round={round} run={run} /> : null}
    <CouncilGrid round={round} seats={seats}>{cell => <>
      {cell.stage === 'framing' && cell.seat.seat === COUNCIL_CHAIR && round.framing && !framingAbove
        ? <Framing framing={round.framing} council={council} round={round} run={run} /> : null}
      {cell.stage === 'crux' ? crux : null}
      {cell.stage === 'verdict' && round.verdict ? <Verdict council={council} round={round} inReader /> : null}
      {groupCellTurns(cell.rows).map(({ row, repairs }) => <div key={row.turn} className="council-turn-group">
        <TurnRecord council={council} row={row} run={run} />
        {repairs.length ? <div className="council-turn-repairs">{repairs.map(repair => <TurnRecord key={repair.turn} council={council} row={repair} run={run} />)}</div> : null}
      </div>)}
    </>}</CouncilGrid>
    {!round.rows.some(row => row.stage === 'crux') ? crux : null}
    {round.verdict && !round.rows.some(row => row.stage === 'verdict') ? <Verdict council={council} round={round} /> : null}
    {leftOut ? <p className="council-entry__meta tt-paragraph">{t`The Council went on without ${leftOut}.`}</p> : null}
    {round.stage === 'done' && council.status !== 'stopped' && council.status !== 'settled' && latest ? <FollowUp council={council} run={run} /> : null}
  </>
  const question = round.question ?? t`A question whose words are not kept`
  return <section className="council-round" aria-label={round.index === 0 ? t`First question` : t`Follow-up ${round.index}`}
    onKeyDown={event => {
      if (!latest && expanded && event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); setExpanded(false); event.currentTarget.querySelector<HTMLButtonElement>('.council-round__toggle')?.focus()
      }
    }}>
    {!latest ? <button type="button" className="council-round__question council-round__toggle tt-focusable" aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {question}</button>
      : round.index > 0 ? <h3 className="council-round__question">{t`Follow-up: ${question}`}</h3> : null}
    <div className="council-round__body" hidden={!latest && !expanded}>{content}</div>
  </section>
}

/**
 * The framing as the record shows it: the kind, the criteria by source, and whether the panelists research outside the
 * snapshot, or the thread's folder when it has none. Once framing is in and before the verdict, the user can change the
 * kind or the research, and every panelist answers again (ADR-0177 decision 4).
 */
function Framing({ framing, council, round, run }: { readonly framing: NonNullable<CouncilRoundView['framing']>; readonly council: CouncilRecord; readonly round: CouncilRoundView
  readonly run: (command: CouncilCommand) => Promise<void> }): ReactNode {
  const { t, i18n } = useLingui()
  const kindId = useId(), secondId = useId()
  const first = framing.kinds[0]!, second = framing.kinds[1]
  const choose = (kinds: CouncilKind[]): void => { void run({ type: 'reframe', council: council.id, kinds }) }
  const names: Record<CouncilKind, string> = { decision: t`a decision`, fact: t`a fact to check`, review: t`a review`, ideas: t`ideas` }
  const kinds = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(framing.kinds.map(kind => names[kind]))
  const reason = framing.research.reason
  const research = framing.research.needed
    ? reason ? t`Outside research: ${reason}` : t`Outside research.`
    : t`No outside research.`
  const heading = framing.fallback ? t`The chair’s framing could not be read, so the panel answers the question alone, as ${kinds}.` : t`Framed as ${kinds}.`
  const body = <div className="council-framing__body">
    {framing.criteria.length ? <ul>{framing.criteria.map(criterion => <li key={criterion.id}>{criterion.id}{criterion.source === 'assumed' ? <span className="council-muted"> ({t`assumed`})</span> : null}: {criterion.text}</li>)}</ul> : null}
    <p className="tt-paragraph">{research}</p>
    {round.reframable ? <div className="council-framing__change">
      <label className="council-field council-field--inline" htmlFor={kindId}><span>{t`Answer again as`}</span>
        <select id={kindId} className="tt-input tt-focusable" value={first}
          onChange={event => { const kind = event.currentTarget.value as CouncilKind; choose(second && second !== kind ? [kind, second] : [kind]) }}>
          {COUNCIL_KINDS.map(kind => <option key={kind} value={kind}>{names[kind]}</option>)}
        </select>
      </label>
      <label className="council-field council-field--inline" htmlFor={secondId}><span>{t`Also answer again as`}</span>
        <select id={secondId} className="tt-input tt-focusable" value={second ?? ''}
          onChange={event => { const kind = event.currentTarget.value as CouncilKind | ''; choose(kind ? [first, kind] : [first]) }}>
          <option value="">{t({ message: 'None', comment: 'No second kind for a Council question' })}</option>
          {COUNCIL_KINDS.filter(kind => kind !== first).map(kind => <option key={kind} value={kind}>{names[kind]}</option>)}
        </select>
      </label>
      <button type="button" className="tt-button tt-focusable" onClick={() => void run({ type: 'reframe', council: council.id, research: !framing.research.needed })}>
        {framing.research.needed ? t`Answer again without outside research` : t`Answer again with outside research`}</button>
      <CriteriaEditor key={framing.criteria.map(criterion => criterion.text).join('\n')} criteria={framing.criteria.map(criterion => criterion.text)}
        onChange={criteria => void run({ type: 'reframe', council: council.id, criteria })} />
    </div> : null}
  </div>
  return round.reframable ? <details className="council-framing" onKeyDown={event => {
    if (event.key === 'Escape' && event.currentTarget.open && !event.defaultPrevented) {
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus()
    }
  }}><summary className="tt-focusable">{heading}</summary>{body}</details>
    : <div className="council-framing"><p className="tt-paragraph">{heading}</p>{body}</div>
}

/** The criteria as lines to change, one to five; the panelists answer again against them. */
function CriteriaEditor({ criteria, onChange }: { readonly criteria: readonly string[]; readonly onChange: (criteria: string[]) => void }): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(criteria.join('\n'))
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const close = (): void => { setOpen(false); requestAnimationFrame(() => container.current?.querySelector('button')?.focus()) }
  const lines = draft.split('\n').map(line => line.trim()).filter(Boolean)
  const valid = lines.length >= 1 && lines.length <= 5 && lines.every(line => line.length <= 2_000)
  if (!open) return <div ref={container}><button type="button" className="tt-button tt-focusable" onClick={() => setOpen(true)}>{t`Change the criteria`}</button></div>
  return <div ref={container} className="council-criteria" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); setDraft(criteria.join('\n')) }
  }}>
    <label className="council-field" htmlFor={id}><span>{t`Criteria, one to five, one on each line`}</span>
      <textarea id={id} className="tt-input tt-focusable" rows={Math.max(3, lines.length + 1)} value={draft} onChange={event => setDraft(event.currentTarget.value)} />
    </label>
    <div className="council-ask__actions">
      <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={!valid} onClick={() => { close(); onChange(lines) }}>{t`Answer again with these criteria`}</button>
      <button type="button" className="tt-button tt-focusable" onClick={() => { close(); setDraft(criteria.join('\n')) }}>{t`Cancel`}</button>
    </div>
  </div>
}

function TurnRecord({ council, row, run }: { readonly council: CouncilRecord; readonly row: CouncilRow; readonly run: (command: CouncilCommand) => Promise<void> }): ReactNode {
  const { t } = useLingui()
  const words = useWords()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const [choosing, setChoosing] = useState(false)
  const catalog = useMemo(() => agents?.state ? newThreadDefaultsCatalog(agents.state) : [], [agents?.state])
  const seat = council.seats.find(item => item.seat === row.seat)
  const openThread = (): void => { void agents?.command({ type: 'select-thread', threadId: row.thread }); app?.actions.navigate('threads') }
  const who = words.seat(row.seat)
  const noResult = !turnNeedsYou(row) && row.state !== 'working' && (row.result === 'unavailable' || ['failed', 'stopped', 'unknown'].includes(row.state))
  const checked = (row.citations ?? []).map(citation => {
    const finding = citation.finding
    if (citation.of === 'command') return t`${finding} rests on a command, unchecked`
    if (citation.of === 'source') return t`${finding} cites a source though the question needs no research, unchecked`
    return `${citation.path}:${citation.lines} ${({ matches: t`matches`, differs: t`does not match what it quoted`, missing: t`is not in the snapshot`, unchecked: t`unchecked` })[citation.check]}`
  })
  return <article className="council-turn" data-state={row.state} data-no-result={noResult || undefined}>
    {row.repair || row.stage === 'history' || row.stage === 'amend' || row.state !== 'done' || row.late || row.result === 'unavailable' ? <header className="council-turn__head">
      {row.repair || row.stage === 'history' || row.stage === 'amend' ? <span className="council-turn__stage">{row.repair ? t`Asked again` : words.stage(row.stage)}</span> : null}
      <span className="council-turn__state">{[noResult ? t`No result` : row.state !== 'done' ? words.state(row.state) : '', row.late ? t`past the stage deadline` : '', !noResult && row.result === 'unavailable' ? t`No result` : ''].filter(Boolean).join(' · ')}</span>
    </header> : null}
    {row.changed ? <span className="council-turn__changed">{t`Changed its answer`}</span> : null}
    {row.summary && row.stage !== 'framing' ? <p className="council-turn__summary">{row.summary}</p> : null}
    {checked.length ? <ul className="council-turn__evidence">{checked.map((citation, index) => <li key={index}>{citation}</li>)}</ul> : null}
    {row.sources?.length ? <div className="council-turn__evidence"><p>{t`Sources:`}</p>
      <ul>{row.sources.map((source, index) => <li key={index}>{source.finding} <span className="council-source">{source.url}</span></li>)}</ul></div> : null}
    <span className="council-turn__actions">
      <button type="button" className="council-link tt-focusable" onClick={openThread}>{t`Open thread`}</button>
      {row.actions.filter(action => action !== 'replace').map(action => <button key={action} type="button" className="council-link tt-focusable"
        onClick={() => void run({ type: action as 'retry' | 'skip', council: council.id, turn: row.turn })}>{words.action(action)}</button>)}
      {row.actions.includes('replace') ? choosing
        ? <ModelPicker models={[...catalog]} modelId={seat?.modelId ?? ''} disabled={false} openOnMount label={t`Choose another model for ${who}`}
          onChange={id => {
            setChoosing(false)
            const modelId = chosenModelId(catalog, id, seat?.modelId ?? '')
            void run({ type: 'replace', council: council.id, turn: row.turn, seat: { modelId, reasoningEffort: councilEffort(seat?.effort ?? COUNCIL_SEAT_EFFORT, resolveModel(catalog, modelId)) } })
          }} />
        : <button type="button" className="council-link tt-focusable" onClick={() => setChoosing(true)}>{words.action('replace')}</button> : null}
    </span>
  </article>
}

/** Sotto's own counts from the result blocks (decision 5), each with its denominator, or marked partial. */
function Counts({ counts }: { readonly counts: CouncilCounts }): ReactNode {
  const { t } = useLingui()
  const partial = counts.partial ? ` ${t`Partial: a result was unavailable.`}` : ''
  const ranked = counts.rankings.map(item => t`${item.letter} by ${item.first} of ${item.of}`).join(', ')
  const found = counts.findings.map(item => t`${item.finding} confirmed by ${item.confirmed}, rejected by ${item.rejected}, unchecked by ${item.unchecked} of ${item.of}`).join('; ')
  const supported = counts.supports.map(item => t`${item.letter} for ${item.count} of ${item.of}`).join(', ')
  const liked = counts.favourites.map(item => t`${item.finding} for ${item.count} of ${item.of}`).join(', ')
  const changed = counts.changed.join(', ')
  const lines = [
    ...ranked ? [t`Ranked first: ${ranked}.` + partial] : [],
    ...found ? [t`Findings: ${found}.` + partial] : [],
    ...supported ? [t`The evidence supports: ${supported}.`] : [],
    ...liked ? [t`Favourites: ${liked}.`] : [],
    ...changed ? [t`Changed their answers: ${changed}.`] : [],
  ]
  return <>{lines.map(line => <p key={line} className="council-verdict__counts tt-paragraph">{line}</p>)}</>
}

function Verdict({ council, round, inReader = false }: { readonly council: CouncilRecord; readonly round: CouncilRoundView; readonly inReader?: boolean }): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const [notice, setNotice] = useState<string | null>(null)
  const verdict = round.verdict!
  const title = council.origin.title
  const send = async (): Promise<void> => {
    if (!round.draft || !agents) return
    // A box answering the thread's question holds that answer: the verdict waits rather than joining it.
    if (agents.threadDrafts.draft(council.origin.thread).requestId !== null) { setNotice(t`The thread’s message box holds an answer to its question. Send or clear it, then try again. Nothing was put there.`); return }
    const placed = await agents.threadDrafts.place(council.origin.thread, { text: round.draft, attachments: [] })
    if (placed === 'saved') { void agents.command({ type: 'select-thread', threadId: council.origin.thread }); app?.actions.navigate('threads'); return }
    setNotice(placed === 'too-long' ? t`The verdict and what the message box holds are too long together for one message. Nothing was put there.`
      : t`Sotto could not save the verdict in the thread’s message box. Nothing was sent. Try again.`)
  }
  return <section className="council-verdict" aria-label={t`Verdict`}>
    {!inReader ? <h3>{t`Verdict`}</h3> : null}
    {verdict.text === null ? <p className="council-muted tt-paragraph">{t`The verdict’s words are not kept while Keep local history is off.`}</p>
      : <div className="council-verdict__text">{verdict.text}</div>}
    <Counts counts={verdict.counts} />
    {verdict.objections.map(objection => <blockquote key={objection.seat} className="council-objection">
      <p className="tt-paragraph">{t`${objection.seat} says this passage misstates it: “${objection.passage}”`}</p>
      <p className="council-muted tt-paragraph">{objection.answer === 'amended' ? t`The chair amended it.` : objection.answer === 'stands' ? t`The chair let it stand: ${objection.reason ?? ''}` : t`The chair has not answered it.`}</p>
    </blockquote>)}
    <div className="council-ask__actions">
      {verdict.fairnessDone ? null : <span className="council-pending">{t`Fairness check pending`}</span>}
      <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={!round.draft} onClick={() => void send()}>{t`Send to ${title}`}</button>
      {notice ? <p className="council-notice tt-paragraph" role="status">{notice}</p> : null}
    </div>
  </section>
}

function FollowUp({ council, run }: { readonly council: CouncilRecord; readonly run: (command: CouncilCommand) => Promise<void> }): ReactNode {
  const { t } = useLingui()
  const [question, setQuestion] = useState('')
  const ask = (): void => { if (question.trim()) { void run({ type: 'follow-up', council: council.id, question: question.trim() }); setQuestion('') } }
  return <div className="council-follow-up council-composer">
    <textarea aria-label={t`Ask a follow-up`} className="tt-input tt-focusable" rows={2} value={question} onChange={event => setQuestion(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); ask() } }} />
    <div className="council-composer__footer council-composer__footer--follow-up"><button type="button" className="tt-button tt-focusable" disabled={!question.trim()} onClick={ask}>{t`Ask a follow-up`}</button></div>
  </div>
}
