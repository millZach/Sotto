import React, { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type AgentModel, type AgentThread } from '../../../../shared/agents'
import { COUNCIL_CHAIR, COUNCIL_KINDS, COUNCIL_LETTERS, COUNCIL_SEAT_EFFORT, DEFAULT_COUNCIL_LAYOUT, councilEffort, councilSeatsInForce, councilSeatsReady, type CouncilBridge, type CouncilCommand, type CouncilCounts, type CouncilEstimate, type CouncilKind,
  type CouncilLayout, type CouncilRoundView, type CouncilRow, type CouncilRowAction, type CouncilThreadState, type CouncilTurnStage, type CouncilView as CouncilRecord } from '../../../../shared/council'
import { chosenModelId, resolveModel } from '../../../../shared/modelCatalog'
import { isThreadClosed } from '../../../../shared/threadActivity'
import { useOptionalAgents } from '../../agents/AgentContext'
import { ModelPicker } from '../../agents/ModelPicker'
import { newThreadDefaultsCatalog } from '../../agents/newThread'
import { useOptionalApp } from '../../state/AppContext'
import { ChoiceMenu } from '../usage/UsageMenu'
import { CouncilChamber } from './CouncilChamber'
import { CouncilSeats, type CouncilPanel } from './CouncilSeats'
import { useCouncils } from './useCouncils'
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

/**
 * The Council page (ADR-0177): the chamber (`CouncilChamber`, decision 6), then beside or under it the Ask form and each
 * Council as a text record of its stages, its threads' states and the actions their rows offer, the verdict with
 * Sotto's counts, and Send to the thread. The record is the accessible form of the deliberation. The header's Layout
 * menu changes the same setting as Settings → Council.
 */
export function CouncilView({ bridge = window.sotto?.council }: { readonly bridge?: CouncilBridge | undefined }): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const { councils, failed } = useCouncils(bridge)
  const settings = app?.settings
  const state = agents?.state
  const catalog = useMemo(() => state ? newThreadDefaultsCatalog(state) : [], [state])
  // The Ask form's seats, starting from Settings → Council; the chamber seats a figure for each.
  const [panel, setPanel] = useState<CouncilPanel | null>(null)
  const [question, setQuestion] = useState('')
  const seatsPanel: CouncilPanel = panel ?? { panelists: settings?.councilPanelists ?? [null, null, null], chair: settings?.councilChair ?? null }
  const seats = useSeatsInForce(seatsPanel, catalog)
  const layout = settings?.councilLayout ?? DEFAULT_COUNCIL_LAYOUT
  const layouts: { value: CouncilLayout; label: string }[] = [
    { value: 'long-table', label: t({ message: 'Long table', comment: 'A Council chamber layout: the panelists in a row behind a table, the chair at its centre.' }) },
    { value: 'half-circle', label: t({ message: 'Half circle', comment: 'A Council chamber layout: tiered seats round an altar, the chair at the back.' }) },
    { value: 'round-table', label: t({ message: 'Round table', comment: 'A Council chamber layout: seen from a little above, the chair at the far side.' }) },
  ]
  return <div className="council-view" data-layout={layout}>
    <header className="council-head">
      <h1>{t({ message: 'Council', comment: 'The Council page: one question put to several models, which answer, review each other and get a verdict.' })}</h1>
      {app ? <ChoiceMenu name={t({ message: 'Layout', comment: 'The Council chamber\'s layout menu' })} value={layout} options={layouts}
        onChoose={value => void app.actions.updateSettings({ councilLayout: value })} /> : null}
    </header>
    <div className="council-body">
      <CouncilChamber council={chamberCouncil(councils, question.trim() !== '' || panel !== null)} askSeats={seats} layout={layout} />
      <div className="council-scroll"><div className="council-page">
        {bridge ? <AskForm bridge={bridge} panel={seatsPanel} onPanel={setPanel} question={question} onQuestion={setQuestion} /> : null}
        {failed ? <p className="council-notice tt-paragraph" role="status">{t`Sotto could not read the Councils. Nothing was changed. Open the page again.`}</p> : null}
        <div className="council-list">{(councils ?? []).map(council => <CouncilEntry key={council.id} council={council} bridge={bridge!} />)}</div>
      </div></div>
    </div>
  </div>
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

/** A thread the Council can start from: an ordinary thread on this computer, open, not one another thread started. */
function askable(thread: AgentThread, localHostId: string | undefined): boolean {
  return thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && thread.remoteHost !== true && (thread.hostId === undefined || thread.hostId === localHostId)
    && thread.delegatedBy === undefined && !isThreadClosed(thread)
}

function AskForm({ bridge, panel: seatsPanel, onPanel: setPanel, question, onQuestion: setQuestion }: { readonly bridge: CouncilBridge; readonly panel: CouncilPanel
  readonly onPanel: (panel: CouncilPanel | null) => void; readonly question: string; readonly onQuestion: (question: string) => void }): ReactNode {
  const { t, i18n } = useLingui()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const state = agents?.state
  const settings = app?.settings
  const questionId = useId(), originId = useId(), estimateId = useId()
  const catalog = useMemo(() => state ? newThreadDefaultsCatalog(state) : [], [state])
  const local = state?.connections?.find(connection => connection.kind === 'local')?.hostId
  const threads = useMemo(() => (state?.host.threads ?? []).filter(thread => askable(thread, local))
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')), [state, local])
  const [origin, setOrigin] = useState<string>('')
  const [estimate, setEstimate] = useState<CouncilEstimate | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const shownOrigin = origin || (threads.some(thread => thread.id === state?.activeThreadId) ? state!.activeThreadId! : threads[0]?.id ?? '')
  useEffect(() => {
    setEstimate(null)
    if (!shownOrigin) return
    let live = true
    void bridge.estimate({ originThread: shownOrigin }).then(read => { if (live) setEstimate(read) }, () => undefined)
    return () => { live = false }
  }, [bridge, shownOrigin])
  if (!state || !settings) return <p className="council-notice tt-paragraph">{t`Preparing the Council…`}</p>
  const seats = councilSeatsInForce(seatsPanel.panelists, seatsPanel.chair, catalog)
  const ready = councilSeatsReady(seats)
  const providers = [...new Set([...seats.panelists, seats.chair].flatMap(seat => seat?.provider ? [PROVIDER_LABELS[seat.provider]] : []))]
  const providerList = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(providers)
  const threadCount = seats.panelists.length + 1
  const minutes = settings.councilStageDeadline
  const reads = estimate && 'words' in estimate ? estimate : null
  const messages = reads?.messages ?? 0, words = (reads?.words ?? 0).toLocaleString(i18n.locale), parts = reads?.parts ?? 1
  // About four characters a token. A seat's model is warned of only when a thread on it reported a smaller context window.
  const tokens = Math.ceil((reads?.characters ?? 0) / 4)
  const windows = new Map<string, number>()
  for (const thread of state.host.threads) {
    const window = thread.usage?.contextWindow
    if (window && window > (windows.get(thread.modelId) ?? 0)) windows.set(thread.modelId, window)
  }
  const small = reads ? [...seats.panelists.map((seat, index) => ({ seat, who: COUNCIL_LETTERS[index]! })), { seat: seats.chair, who: t`Chair` }]
    .flatMap(({ seat, who }) => { const window = seat ? windows.get(seat.modelId) : undefined; return seat && window && window < tokens ? [{ who, model: seat.model?.name ?? seat.modelId, window }] : [] }) : []
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
    <div className="council-ask__row">
      <label className="council-field" htmlFor={originId}><span>{t({ message: 'Thread', comment: 'The thread a Council question comes from' })}</span>
        <select id={originId} className="tt-input tt-focusable" value={shownOrigin} onChange={event => setOrigin(event.currentTarget.value)} disabled={threads.length === 0}>
          {threads.length === 0 ? <option value="">{t`No open thread on this computer`}</option> : threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </select>
      </label>
    </div>
    <label className="council-field"><span>{t({ message: 'Question', comment: 'The question put to the Council' })}</span>
      <textarea className="tt-input tt-focusable council-ask__question" value={question} rows={3} aria-describedby={estimateId}
        onChange={event => setQuestion(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask() } }} />
    </label>
    <CouncilSeats panel={seatsPanel} catalog={catalog} onChange={setPanel} />
    <p id={estimateId} className="council-ask__estimate tt-paragraph">
      {reads && providers.length ? parts > 1
        ? t`Starts ${threadCount} threads. ${providerList} each read the thread’s conversation, ${messages} messages and about ${words} words, in ${parts} parts before the question. A stage waits up to ${minutes} minutes for a thread.`
        : t`Starts ${threadCount} threads. ${providerList} each read the thread’s conversation, ${messages} messages and about ${words} words, with the question. A stage waits up to ${minutes} minutes for a thread.`
        : t`Starts ${threadCount} threads. A stage waits up to ${minutes} minutes for a thread.`}
    </p>
    {small.map(({ who, model, window }) => <p key={who} className="council-notice tt-paragraph">
      {t`${who}’s model, ${model}, holds about ${window.toLocaleString(i18n.locale)} tokens, and the conversation is about ${tokens.toLocaleString(i18n.locale)}. It may lose the start of the conversation. Choose a model with a larger context, or ask from a shorter thread.`}</p>)}
    {estimate && 'unavailable' in estimate ? <p className="council-notice tt-paragraph">{estimate.unavailable}</p> : null}
    <div className="council-ask__actions">
      <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={!ready || !question.trim() || !shownOrigin || busy} onClick={() => void ask()}>
        {busy ? t`Asking the Council…` : t`Ask the Council`}</button>
      {message ? <p className="council-notice tt-paragraph" role="status">{message}</p> : null}
    </div>
  </section>
}

function useWords() {
  const { t } = useLingui()
  return {
    state: (state: CouncilThreadState): string => ({ working: t`Working`, waiting: t`Waiting on you`, done: t`Done`, failed: t`Failed`, stopped: t`Stopped`, unknown: t`Unknown` })[state],
    stage: (stage: CouncilTurnStage): string => ({ history: t`Reading the conversation`, framing: t`Framing`, answer: t`Answer`, review: t`Review`, crux: t`Crux check`, verdict: t`Verdict`, fairness: t`Fairness check`,
      amend: t`Answer to objections` })[stage],
    action: (action: CouncilRowAction): string => ({ retry: t`Retry`, replace: t`Use another model`, skip: t`Go on without it` })[action],
    status: (status: CouncilRecord['status']): string => ({ working: t`Working`, waiting: t`Waiting on you`, done: t`Done`, stopped: t`Stopped`, settled: t`Settled` })[status],
    seat: (seat: string): string => seat === COUNCIL_CHAIR ? t`Chair` : seat,
  }
}

function CouncilEntry({ council, bridge }: { readonly council: CouncilRecord; readonly bridge: CouncilBridge }): ReactNode {
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
  const branch = council.snapshot.branch, commit = council.snapshot.commit.slice(0, 8), untracked = council.snapshot.untracked, parts = council.history.parts
  return <article className="council-entry" aria-labelledby={headingId} data-status={council.status}>
    <header className="council-entry__head">
      <div className="council-entry__title">
        <h2 id={headingId}>{first.question ?? t`A question whose words are not kept`}</h2>
        <p className="council-entry__meta tt-paragraph">{t`From ${council.origin.title}`} · {words.status(council.status)}</p>
      </div>
      <div className="council-entry__actions">
        {running ? <button type="button" className="tt-button tt-focusable" onClick={() => void run({ type: 'stop', council: council.id })}>{t`Stop`}</button> : null}
        {open && !running ? <button type="button" className="tt-button tt-focusable" onClick={() => void run({ type: 'settle', council: council.id })}>{t`Settle`}</button> : null}
      </div>
    </header>
    <p className="council-entry__seats tt-paragraph">{seatNames}</p>
    <p className="council-entry__meta tt-paragraph">
      {council.snapshot.removed ? t`Its snapshot of ${branch} has been removed.` : !council.snapshot.dirty ? t`Working in a snapshot of ${branch} at ${commit}.`
        : untracked > 0 ? t`Working in a snapshot of ${branch} at ${commit}, with its uncommitted changes and ${untracked} untracked files.`
        : t`Working in a snapshot of ${branch} at ${commit}, with its uncommitted changes.`}
      {council.history.parts > 1 ? ` ${t`The conversation is too long for one prompt, so each thread reads all of it in ${parts} parts first.`}` : ''}
    </p>
    {council.stoppedBecause === 'words-lost' ? <p className="council-notice tt-paragraph">{t`Sotto restarted while Keep local history was off, so this Council’s words are gone and it cannot go on.`}</p> : null}
    {council.rounds.map(round => <RoundRecord key={round.index} council={council} round={round} run={run} />)}
    {notice ? <p className="council-notice tt-paragraph" role="status">{notice}</p> : null}
  </article>
}

function RoundRecord({ council, round, run }: { readonly council: CouncilRecord; readonly round: CouncilRoundView; readonly run: (command: CouncilCommand) => Promise<void> }): ReactNode {
  const { t } = useLingui()
  const leftOut = round.leftOut.filter(seat => seat !== COUNCIL_CHAIR).join(', ')
  return <section className="council-round" aria-label={round.index === 0 ? t`First question` : t`Follow-up ${round.index}`}>
    {round.index > 0 ? <h3 className="council-round__question">{t`Follow-up: ${round.question ?? ''}`}</h3> : null}
    {round.framing ? <Framing framing={round.framing} council={council} round={round} run={run} /> : null}
    <ol className="council-rows">
      {round.rows.map(row => <RowRecord key={row.turn} council={council} row={row} run={run} />)}
    </ol>
    {leftOut ? <p className="council-entry__meta tt-paragraph">{t`The Council went on without ${leftOut}.`}</p> : null}
    {round.crux ? <p className="council-crux tt-paragraph">{round.crux.lookup ? t`Crux check, a lookup: ${round.crux.test}` : t`Crux check: ${round.crux.test}`}{round.crux.result ? ` ${t`Result: ${round.crux.result}`}` : ''}</p> : null}
    {round.verdict ? <Verdict council={council} round={round} /> : null}
    {round.stage === 'done' && council.status !== 'stopped' && council.status !== 'settled' && round.index === council.rounds.length - 1 ? <FollowUp council={council} run={run} /> : null}
  </section>
}

/**
 * The framing as the record shows it: the kind, the criteria by source, and whether the panelists research outside the
 * snapshot. Once framing is in and before the verdict, the user can change the kind or the research, and every panelist
 * answers again (ADR-0177 decision 4).
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
    ? reason ? t`The panelists research outside the snapshot with their own tools: ${reason}` : t`The panelists research outside the snapshot with their own tools.`
    : t`No outside research: the panelists work from the snapshot and the conversation.`
  return <div className="council-framing">
    <p className="tt-paragraph">{framing.fallback ? t`The chair’s framing could not be read, so the panel answers the question alone, as ${kinds}.` : t`Framed as ${kinds}.`}</p>
    {framing.criteria.length ? <ul>{framing.criteria.map(criterion => <li key={criterion.id}>{criterion.id} <span className="council-muted">({criterion.source === 'question' ? t`from the question`
      : criterion.source === 'user' ? t`set by you` : t`assumed by the chair`})</span>: {criterion.text}</li>)}</ul> : null}
    <p className="tt-paragraph">{research}{framing.research.byUser ? <span className="council-muted"> {t`You set this.`}</span> : null}</p>
    {round.reframable ? <div className="council-framing__change">
      <label className="council-field council-field--inline" htmlFor={kindId}><span>{t`Kind`}</span>
        <select id={kindId} className="tt-input tt-focusable" value={first}
          onChange={event => { const kind = event.currentTarget.value as CouncilKind; choose(second && second !== kind ? [kind, second] : [kind]) }}>
          {COUNCIL_KINDS.map(kind => <option key={kind} value={kind}>{names[kind]}</option>)}
        </select>
      </label>
      <label className="council-field council-field--inline" htmlFor={secondId}><span>{t`Second kind`}</span>
        <select id={secondId} className="tt-input tt-focusable" value={second ?? ''}
          onChange={event => { const kind = event.currentTarget.value as CouncilKind | ''; choose(kind ? [first, kind] : [first]) }}>
          <option value="">{t({ message: 'None', comment: 'No second kind for a Council question' })}</option>
          {COUNCIL_KINDS.filter(kind => kind !== first).map(kind => <option key={kind} value={kind}>{names[kind]}</option>)}
        </select>
      </label>
      <button type="button" className="tt-button tt-focusable" onClick={() => void run({ type: 'reframe', council: council.id, research: !framing.research.needed })}>
        {framing.research.needed ? t`Answer without outside research` : t`Research outside the snapshot`}</button>
      <CriteriaEditor key={framing.criteria.map(criterion => criterion.text).join('\n')} criteria={framing.criteria.map(criterion => criterion.text)}
        onChange={criteria => void run({ type: 'reframe', council: council.id, criteria })} />
      <p className="council-muted tt-paragraph">{t`Changing the kind, the research or the criteria asks every panelist to answer again.`}</p>
    </div> : null}
  </div>
}

/** The criteria as lines to change, one to five; the panel answers again against them. */
function CriteriaEditor({ criteria, onChange }: { readonly criteria: readonly string[]; readonly onChange: (criteria: string[]) => void }): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(criteria.join('\n'))
  const id = useId()
  const lines = draft.split('\n').map(line => line.trim()).filter(Boolean)
  const valid = lines.length >= 1 && lines.length <= 5 && lines.every(line => line.length <= 2_000)
  if (!open) return <button type="button" className="tt-button tt-focusable" onClick={() => setOpen(true)}>{t`Change the criteria`}</button>
  return <div className="council-criteria">
    <label className="council-field" htmlFor={id}><span>{t`Criteria, one to five, one on each line`}</span>
      <textarea id={id} className="tt-input tt-focusable" rows={Math.max(3, lines.length + 1)} value={draft} onChange={event => setDraft(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setDraft(criteria.join('\n')) } }} />
    </label>
    <div className="council-ask__actions">
      <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={!valid} onClick={() => { setOpen(false); onChange(lines) }}>{t`Answer again with these criteria`}</button>
      <button type="button" className="tt-button tt-focusable" onClick={() => { setOpen(false); setDraft(criteria.join('\n')) }}>{t`Cancel`}</button>
    </div>
  </div>
}

function RowRecord({ council, row, run }: { readonly council: CouncilRecord; readonly row: CouncilRow; readonly run: (command: CouncilCommand) => Promise<void> }): ReactNode {
  const { t } = useLingui()
  const words = useWords()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const [choosing, setChoosing] = useState(false)
  const catalog = useMemo(() => agents?.state ? newThreadDefaultsCatalog(agents.state) : [], [agents?.state])
  const seat = council.seats.find(item => item.seat === row.seat)
  const openThread = (): void => { void agents?.command({ type: 'select-thread', threadId: row.thread }); app?.actions.navigate('threads') }
  const who = words.seat(row.seat)
  const checked = (row.citations ?? []).map(citation => {
    const finding = citation.finding
    if (citation.of === 'command') return t`${finding} rests on a command, unchecked`
    if (citation.of === 'source') return t`${finding} cites a source though the question needs no research, unchecked`
    return `${citation.path}:${citation.lines} ${({ matches: t`matches`, differs: t`does not match what it quoted`, missing: t`is not in the snapshot`, unchecked: t`unchecked` })[citation.check]}`
  })
  return <li className="council-row" data-state={row.state}>
    <span className="council-row__stage">{row.repair ? t`${words.stage(row.stage)}, asked again` : words.stage(row.stage)}</span>
    <span className="council-row__seat">{who}{seat ? <span className="council-muted"> {seat.modelName}</span> : null}</span>
    <span className="council-row__state">{words.state(row.state)}{row.late ? <span className="council-muted"> · {t`past the stage deadline`}</span> : null}
      {row.result === 'unavailable' ? <span className="council-muted"> · {t`no result`}</span> : null}</span>
    {row.summary && row.stage !== 'framing' ? <span className="council-row__summary">{row.summary}</span> : null}
    {checked.length ? <span className="council-row__summary council-muted">{checked.join('; ')}</span> : null}
    {row.sources?.length ? <span className="council-row__summary council-muted">{t`Sources, which reviewers open since Sotto checks only a link’s shape:`} {row.sources.map((source, index) => <React.Fragment key={source.finding}>
      {index ? '; ' : ''}{source.finding} <span className="council-source">{source.url}</span></React.Fragment>)}</span> : null}
    <span className="council-row__actions">
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
  </li>
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

function Verdict({ council, round }: { readonly council: CouncilRecord; readonly round: CouncilRoundView }): ReactNode {
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
    <h3>{t`Verdict`}</h3>
    {verdict.text === null ? <p className="council-muted tt-paragraph">{t`The verdict’s words are not kept while Keep local history is off.`}</p>
      : <div className="council-verdict__text">{verdict.text}</div>}
    <Counts counts={verdict.counts} />
    {council.seats.filter(seat => seat.role === 'panelist').length === 2 ? <p className="council-muted tt-paragraph">{t`The Council had two panelists, so nothing is counted.`}</p> : null}
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
  const id = useId()
  const ask = (): void => { if (question.trim()) { void run({ type: 'follow-up', council: council.id, question: question.trim() }); setQuestion('') } }
  return <div className="council-follow-up">
    <label className="council-field" htmlFor={id}><span>{t`Ask a follow-up`}</span>
      <textarea id={id} className="tt-input tt-focusable" rows={2} value={question} onChange={event => setQuestion(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); ask() } }} />
    </label>
    <div className="council-ask__actions"><button type="button" className="tt-button tt-focusable" disabled={!question.trim()} onClick={ask}>{t`Ask a follow-up`}</button></div>
  </div>
}
