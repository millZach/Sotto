import { PROVIDER_LABELS, type AgentThread } from '../../../../shared/agents'
import { COUNCIL_CHAIR, COUNCIL_STAGES, type CouncilRow, type CouncilSeatInForce, type CouncilStage, type CouncilThreadState, type CouncilTurnStage,
  type CouncilView } from '../../../../shared/council'
import { reviewAssignments } from '../../../../shared/councilFlow'
import { IDLE_CHECK_MS, MOVING_MS } from '../../watcher/nightScene'
import type { ProviderId } from '../../../../shared/providerIds'
import { isThreadTurnRunning } from '../../../../shared/threadActivity'
import { activityLabel } from '../../agents/threadActivityView'

/**
 * What the Council's chamber shows (ADR-0177 decision 6), worked out from the record and each seat's own thread, never
 * from a script: who sits, what each figure does and says, the scrolls on the table and in hand, and the chair's verdict
 * scroll. It is derived once per update; the frames that draw it read only this.
 */

/** A figure's pose. `done` is listening, turned toward whoever is active; `present` is the chair holding up the verdict. */
export type ChamberAct = 'idle' | 'listen' | 'think' | 'write' | 'read' | 'speak' | 'ask' | 'done' | 'present'

/** What a figure's bubble holds, put into words where it is drawn. */
export type ChamberSpeech =
  | { readonly kind: 'none' }
  /** Waiting on the user: Needs your answer. */
  | { readonly kind: 'ask' }
  /** Its own newest words, as its thread writes them. */
  | { readonly kind: 'words'; readonly text: string }
  /** What its thread is reading or running now, as the thread's activity names it. */
  | { readonly kind: 'activity'; readonly text: string }
  | { readonly kind: 'thinking' }
  /** Reading the origin thread's conversation, in parts before the question. */
  | { readonly kind: 'conversation' }
  /** The chair framing the question. */
  | { readonly kind: 'framing' }
  /** Reading the other answers, by letter. */
  | { readonly kind: 'answers'; readonly letters: readonly string[] }
  /** The chair reading every answer and review before the verdict. */
  | { readonly kind: 'everything' }
  /** A panelist reading the verdict for the fairness check. */
  | { readonly kind: 'verdict' }

export type ChamberLook = 'curls' | 'bald' | 'beard'

export interface ChamberSeat {
  /** The seat: a panelist's letter, or `chair`. */
  readonly key: string
  /**
   * Whose figure sits there, which keeps its pose: the seat's thread in a Council, so a seat moved to another model is a
   * new figure; in the Ask view its model and its place among seats on that model, so removing a seat moves no one else.
   */
  readonly figure: string
  readonly chair: boolean
  /** Its provider's name, on the first line of its plate. */
  readonly provider: string
  readonly model: string
  readonly look: ChamberLook
  /** The thread a press on the figure opens; null in the Ask view, where no thread has started. */
  readonly thread: string | null
  readonly act: ChamberAct
  readonly speech: ChamberSpeech
  /** The letters on the scrolls it holds while it reads the others. */
  readonly scrolls: readonly string[]
  /** Its answer is in, so its scroll lies on the table until the chair gathers them. */
  readonly answered: boolean
  /** It changed its answer in review. */
  readonly changed: boolean
  /** What its row in the record says, and the stage that row is for; null in the Ask view or before its first prompt. */
  readonly state: CouncilThreadState | null
  readonly stage: CouncilTurnStage | null
}

export interface ChamberScene {
  /** The Council and round shown, or null for the Ask view. */
  readonly id: string | null
  readonly stage: CouncilStage | null
  readonly panelists: readonly ChamberSeat[]
  readonly chair: ChamberSeat
  /** The letters whose answers are in, and who reads whose in review: where the scrolls fly. */
  readonly answered: readonly string[]
  readonly reviews: ReadonlyMap<string, readonly string[]>
  /** The chair's verdict scroll: its words, and whether it is finished and held up rather than being written. */
  readonly verdict: { readonly text: string; readonly finished: boolean } | null
  /** The Council is done: its last scene holds still, the chair holding up the verdict and the panelists listening. */
  readonly finished: boolean
}

/** What a seat's thread is doing now, read once per update from its own state. */
export interface ThreadFacts {
  readonly running: boolean
  /** It holds a question or permission for the user. */
  readonly waiting: boolean
  /** What it reads or runs right now, named as its activity names it. */
  readonly activity: string | null
  /** Its own newest words in the turn that runs, as plain text. */
  readonly words: string | null
}

const QUIET: ThreadFacts = { running: false, waiting: false, activity: null, words: null }
const NONE: ChamberSpeech = { kind: 'none' }
const ASK: ChamberSpeech = { kind: 'ask' }
/** The kinds of activity that read or run something, which a thought bubble names. Reasoning is thinking. */
const NAMED = new Set(['tool', 'command', 'file-change', 'subagent'])
/** How far back from its newest activity a thread is searched for one still running. */
const ACTIVITY_LOOKBACK = 40
/** The most of a thread's words a bubble keeps: its tail, a little over three lines. */
export const SPOKEN_MAX = 240
/** The most of the verdict the chair's scroll keeps. */
export const VERDICT_MAX = 900

/** Each provider's senator: two seats on one provider look alike, as two copies of a model do. */
const LOOKS: Partial<Record<ProviderId, ChamberLook>> = { claude: 'curls', codex: 'bald', grok: 'beard', muse: 'curls', deepseek: 'beard', devin: 'bald', opencode: 'bald', cursor: 'beard' }
const BY_PLACE: readonly ChamberLook[] = ['curls', 'bald', 'beard']
function lookOf(provider: ProviderId | undefined, place: number): ChamberLook {
  return (provider ? LOOKS[provider] : undefined) ?? BY_PLACE[place % BY_PLACE.length]!
}

/** How much of a message is made plain: a little more than any bubble or the verdict's scroll shows, whatever its length. */
const PLAIN_SPAN = 2_000

/**
 * Text as one plain line: markdown's headings, marks and the result block left out, spaces collapsed. Only its first or
 * last PLAIN_SPAN characters before the result block are read, so the work stays the same however long the message grows.
 */
export function plainWords(text: string, end: 'head' | 'tail' = 'tail'): string {
  const fence = text.indexOf('```')
  const body = fence >= 0 ? text.slice(0, fence) : text
  const part = end === 'head' ? body.slice(0, PLAIN_SPAN) : body.slice(-PLAIN_SPAN)
  return part.replace(/^[ \t]*#{1,6}[ \t].*$/gm, '').replace(/[`*_#>|]+/g, '').replace(/\s+/g, ' ').trim()
}

/** The tail of a thread's words a bubble shows, starting on a whole word; null when there are none. */
export function spoken(text: string, max = SPOKEN_MAX): string | null {
  const plain = plainWords(text)
  if (!plain) return null
  if (plain.length <= max) return plain
  const tail = plain.slice(plain.length - max + 1)
  const space = tail.indexOf(' ')
  return `…${space >= 0 && space < 24 ? tail.slice(space + 1) : tail}`
}

/** What a seat's thread is doing now. Only a running turn reads or writes; a question waits whether or not it runs. */
export function threadFacts(thread: AgentThread | undefined): ThreadFacts {
  if (thread === undefined) return QUIET
  const waiting = thread.requests.length > 0
  if (!isThreadTurnRunning(thread)) return waiting ? { ...QUIET, waiting } : QUIET
  return { running: true, waiting, activity: runningActivity(thread), words: newestWords(thread) }
}

function runningActivity(thread: AgentThread): string | null {
  const list = thread.activities
  if (list === undefined) return null
  for (let at = list.length - 1, seen = 0; at >= 0 && seen < ACTIVITY_LOOKBACK; at--, seen++) {
    const record = list[at]!
    if (record.status !== 'running' || !NAMED.has(record.kind)) continue
    const label = activityLabel(record)
    const line = [label.lead, label.subject, label.preview].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    return line || null
  }
  return null
}

/** Its newest words when its newest message is its own: from the history the window holds, or else the row's excerpt. */
function newestWords(thread: AgentThread): string | null {
  const last = thread.messages.at(-1)
  if (last !== undefined) return last.role === 'assistant' ? spoken(last.text) : null
  const summary = thread.summary
  const reply = summary?.lastAssistant
  if (reply === undefined || (summary?.lastUser !== undefined && summary.lastUser.createdAt > reply.createdAt)) return null
  return spoken(reply.text)
}

/** The Ask view: the seats as they would start now, sitting idle. A seat with no connected provider still sits, unnamed. */
export function askScene(seats: { readonly panelists: readonly (CouncilSeatInForce | undefined)[]; readonly chair: CouncilSeatInForce | undefined }): ChamberScene {
  const held = new Map<string, number>()
  const seat = (inForce: CouncilSeatInForce | undefined, key: string, place: number): ChamberSeat => {
    const model = inForce?.modelId ?? ''
    const copy = held.get(model) ?? 0
    held.set(model, copy + 1)
    return { key, figure: `${key === COUNCIL_CHAIR ? 'chair' : 'seat'}:${model}:${copy}`, chair: key === COUNCIL_CHAIR, provider: inForce?.provider ? PROVIDER_LABELS[inForce.provider] : '', model: inForce?.model?.name ?? inForce?.modelId ?? '',
    look: lookOf(inForce?.provider, place), thread: null, act: 'idle', speech: NONE, scrolls: [], answered: false, changed: false, state: null, stage: null }
  }
  const letters = 'ABCDE'
  return { id: null, stage: null, panelists: seats.panelists.map((inForce, place) => seat(inForce, letters[place] ?? String(place + 1), place)),
    chair: seat(seats.chair, COUNCIL_CHAIR, seats.panelists.length), answered: [], reviews: new Map(), verdict: null, finished: false }
}

const STAGE_RANK = new Map<CouncilStage, number>(COUNCIL_STAGES.map((stage, rank) => [stage, rank]))
const rank = (stage: CouncilStage): number => STAGE_RANK.get(stage) ?? 0

/** A panelist at work on its row's stage: its pose, its bubble and the scrolls in its hands. */
function working(stage: CouncilTurnStage, facts: ThreadFacts, reads: readonly string[]): { act: ChamberAct; speech: ChamberSpeech; scrolls: readonly string[] } {
  const activity: ChamberSpeech | null = facts.activity ? { kind: 'activity', text: facts.activity } : null
  const words: ChamberSpeech | null = facts.words ? { kind: 'words', text: facts.words } : null
  switch (stage) {
    case 'history': return { act: 'think', speech: { kind: 'conversation' }, scrolls: [] }
    case 'answer': return activity ? { act: 'think', speech: activity, scrolls: [] } : words ? { act: 'write', speech: words, scrolls: [] } : { act: 'think', speech: { kind: 'thinking' }, scrolls: [] }
    // Reading the others holds their scrolls, whatever it opens to check them; once it talks, it stands to give its review.
    case 'review': return activity ? { act: 'read', speech: activity, scrolls: reads } : words ? { act: 'speak', speech: words, scrolls: [] } : { act: 'read', speech: { kind: 'answers', letters: reads }, scrolls: reads }
    case 'fairness': return words ? { act: 'speak', speech: words, scrolls: [] } : { act: 'read', speech: { kind: 'verdict' }, scrolls: [] }
    default: return activity ? { act: 'think', speech: activity, scrolls: [] } : words ? { act: 'speak', speech: words, scrolls: [] } : { act: 'think', speech: { kind: 'thinking' }, scrolls: [] }
  }
}

/**
 * A Council's chamber: each figure follows its seat's newest row in the current round and its thread's own state. A
 * finished Council keeps its last scene, still. `facts` reads a thread by its Sotto thread ID.
 */
export function councilScene(council: CouncilView, facts: (thread: string) => ThreadFacts): ChamberScene {
  const round = council.rounds.at(-1)!
  // Rows come in stage order, so the last one of a seat is its newest.
  const newest = new Map<string, CouncilRow>()
  for (const row of round.rows) newest.set(row.seat, row)
  const changed = new Set(round.verdict?.counts.changed ?? [])
  for (const row of round.rows) if (row.changed) changed.add(row.seat)
  const panel = council.seats.filter(seat => seat.role === 'panelist')
  const sitting = panel.map(seat => seat.seat).filter(letter => !round.leftOut.includes(letter))
  const answered = panel.map(seat => seat.seat).filter(letter => round.rows.some(row => row.seat === letter && row.stage === 'answer' && row.state === 'done'))
  const reviews = reviewAssignments(answered, sitting)
  const panelists = panel.map((seat, place): ChamberSeat => {
    const row = newest.get(seat.seat)
    const thread = facts(seat.thread)
    let act: ChamberAct = 'done', speech = NONE, scrolls: readonly string[] = []
    if (!round.leftOut.includes(seat.seat)) {
      // A question its thread holds raises the hand whatever the record says, between stages too.
      if (thread.waiting || row?.state === 'waiting') { act = 'ask'; speech = ASK }
      else if (row?.state === 'working') ({ act, speech, scrolls } = working(row.stage, thread, reviews.get(seat.seat) ?? []))
    }
    return { key: seat.seat, figure: seat.thread, chair: false, provider: seat.provider ? PROVIDER_LABELS[seat.provider] : '', model: seat.modelName, look: lookOf(seat.provider, place),
      thread: seat.thread, act, speech, scrolls, answered: answered.includes(seat.seat), changed: changed.has(seat.seat), state: row?.state ?? null, stage: row?.stage ?? null }
  })
  const seat = council.seats.find(item => item.role === 'chair')
  const row = seat ? newest.get(seat.seat) : undefined
  const thread = seat ? facts(seat.thread) : QUIET
  let act: ChamberAct = 'listen', speech = NONE
  let verdict: ChamberScene['verdict'] = null
  const work = row?.state === 'working'
  if (!round.leftOut.includes(COUNCIL_CHAIR) && (thread.waiting || row?.state === 'waiting')) { act = 'ask'; speech = ASK }
  // Reading the conversation in parts, as a panelist does, then framing the question.
  else if (work && row?.stage === 'history') { act = 'think'; speech = { kind: 'conversation' } }
  else if (round.stage === 'framing' && work) { act = 'think'; speech = thread.activity ? { kind: 'activity', text: thread.activity } : { kind: 'framing' } }
  else if (round.stage === 'verdict' && work && row?.stage === 'verdict') {
    if (thread.words && !thread.activity) { act = 'write'; verdict = { text: thread.words, finished: false } }
    else {
      act = 'read'
      speech = thread.activity ? { kind: 'activity', text: thread.activity } : { kind: 'everything' }
    }
  } else if (round.stage === 'fairness' || round.stage === 'done') {
    act = 'present'
    const text = round.verdict?.text
    verdict = { text: text ? plainWords(text, 'head').slice(0, VERDICT_MAX) : '', finished: true }
  }
  const chair: ChamberSeat = { key: COUNCIL_CHAIR, figure: seat?.thread ?? COUNCIL_CHAIR, chair: true, provider: seat?.provider ? PROVIDER_LABELS[seat.provider] : '', model: seat?.modelName ?? '',
    look: lookOf(seat?.provider, panel.length), thread: seat?.thread ?? null, act, speech, scrolls: [], answered: false, changed: false, state: row?.state ?? null, stage: row?.stage ?? null }
  return { id: `${council.id}:${round.index}`, stage: round.stage, panelists, chair, answered, reviews, verdict, finished: council.status === 'done' }
}

/**
 * The acts in which a figure moves on its own, which want about 30 frames a second. Holding up the verdict is not one:
 * that pose is still, and the panelists turned toward it nod at the slow pace.
 */
const BUSY: ReadonlySet<ChamberAct> = new Set<ChamberAct>(['think', 'write', 'read', 'speak', 'ask'])

/** Whether a figure moves on its own now. Nobody does in a finished Council's last scene. */
export function sceneBusy(scene: ChamberScene): boolean {
  return !scene.finished && (BUSY.has(scene.chair.act) || scene.panelists.some(seat => BUSY.has(seat.act)))
}

/**
 * How long until the chamber draws again, or null to draw nothing until something changes: about 30 frames a second
 * while a figure is busy or something is on its way, 8 while only the fire flickers and the idle glance about or
 * throughout the fairness check, and nothing with motion reduced. A reduced-motion draw lands
 * every pose and scroll at once, so it never needs another frame until the scene changes.
 */
export function chamberPace(still: boolean, moving: boolean, busy: boolean, stage: ChamberScene['stage']): number | null {
  if (still) return null
  // Nodding can lag its target enough to count as moving. It must never switch the fairness check to the fast pace.
  if (stage === 'fairness') return IDLE_CHECK_MS
  return moving || busy ? MOVING_MS : IDLE_CHECK_MS
}

/** One scroll in the air, from a seat's place at the table to another's, `delay` seconds after the stage changed. */
export interface ChamberFlight { readonly from: string; readonly to: string; readonly label: string; readonly delay: number }

/**
 * The scrolls a change of stage sends across the table: into review, each answer to every panelist who reads it; into
 * the verdict, every answer to the chair. Any other change, a reframe sending the panel back to answer again included,
 * sends none.
 */
export function flightsBetween(before: CouncilStage | null, scene: ChamberScene): ChamberFlight[] {
  const after = scene.stage
  if (before === null || after === null || before === after || rank(after) < rank(before)) return []
  const flights: ChamberFlight[] = []
  if (rank(before) < rank('reviews') && rank(after) >= rank('reviews') && rank(after) < rank('verdict')) {
    let reader = 0
    for (const [to, letters] of scene.reviews) {
      letters.forEach((letter, k) => flights.push({ from: letter, to, label: letter, delay: reader * 0.25 + k * 0.08 }))
      reader++
    }
  }
  if (rank(before) < rank('verdict') && rank(after) >= rank('verdict')) {
    scene.answered.forEach((letter, k) => flights.push({ from: letter, to: COUNCIL_CHAIR, label: letter, delay: k * 0.45 }))
  }
  return flights
}
