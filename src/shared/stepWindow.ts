import type { AgentActivity } from './agentActivity'
import type { AgentMessageDelta, AgentThreadDetail, AgentThreadDetailDelta } from './agents'

/**
 * How many of a thread's newest steps a phone that accepts `step-window` opens it on, and how many more each Show earlier
 * messages adds (ADR-0194; Zach's pick B on November 5, 2026).
 */
export const STEP_WINDOW_STEPS = 200

/** Where a step window starts: at a message, with the steps from one sequence on. */
export interface StepWindowStart {
  /** The message the window starts at: the one just before its oldest step. */
  readonly from: string
  /** The oldest step's sequence. A step below it is above the window, even one of the same run. */
  readonly minSequence: number
}

/** Where one phone's step window starts and what lies above it, made from the last whole detail it was sent. */
export interface StepWindowCut {
  /** Null while the phone holds the whole detail. */
  readonly start: StepWindowStart | null
  /** The messages above the window, which a delta must not hand the phone as new. */
  readonly above: ReadonlySet<string>
  /** The steps inside the window, counting those its deltas brought since it was cut. */
  readonly steps: number
  /** The newest step's sequence the phone was sent, so a delta's new steps can be counted. */
  readonly newest: number
}

/** The steps of a detail, oldest first by sequence, as the iPhone's timeline orders them. Turn records are not steps. */
function stepsOf(detail: AgentThreadDetail): AgentActivity[] {
  return (detail.activities ?? []).filter(record => record.kind !== 'turn').sort((a, b) => a.sequence - b.sequence)
}

/**
 * Each step's slot, the number of messages before it, as the iPhone places it (`ThreadTimeline.merge`, which this follows
 * rule for rule): after the message it names when the detail holds it; otherwise after every message written no later than
 * it started, a step with no time taking the time of the step before it, or of the first timed step; with no times to
 * compare, after the last message from the user. Slots never go back. A step the iPhone leaves out of a window it hasn't
 * loaded keeps the slot of the step before it, so the count stays the detail's.
 */
function slotsOf(messages: AgentThreadDetail['messages'], steps: readonly AgentActivity[], earlierAvailable: boolean): number[] {
  const time = (stamp: string | undefined): number | undefined => {
    const parsed = stamp === undefined ? Number.NaN : Date.parse(stamp)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  const positions = new Map<string, number>()
  messages.forEach((message, index) => { if (!positions.has(message.id)) positions.set(message.id, index) })
  const messageTimes: (number | undefined)[] = []
  let latest: number | undefined
  for (const message of messages) {
    const own = time(message.createdAt)
    if (own !== undefined) latest = latest === undefined ? own : Math.max(latest, own)
    messageTimes.push(latest)
  }
  const firstMessageTime = messageTimes.find(value => value !== undefined)
  const stepTimes: (number | undefined)[] = []
  let carried: number | undefined
  for (const step of steps) {
    const own = time(step.startedAt)
    if (own !== undefined) carried = carried === undefined ? own : Math.max(carried, own)
    stepTimes.push(carried)
  }
  const firstStepTime = stepTimes.find(value => value !== undefined)
  let lastUser = -1
  messages.forEach((message, index) => { if (message.role === 'user') lastUser = index })
  const afterLastUser = lastUser >= 0 ? lastUser + 1 : messages.length
  const slots: number[] = []
  let floor = 0, cursor = 0
  steps.forEach((step, index) => {
    const after = step.afterMessageId === undefined ? undefined : positions.get(step.afterMessageId)
    const at = stepTimes[index] ?? firstStepTime
    let slot: number
    if (after !== undefined) slot = after + 1
    else if (step.afterMessageId !== undefined && earlierAvailable) slot = floor
    else if (firstMessageTime !== undefined && at !== undefined) {
      if (earlierAvailable && at < firstMessageTime) slot = floor
      else {
        while (cursor < messages.length && (messageTimes[cursor] === undefined || messageTimes[cursor]! <= at)) cursor++
        slot = cursor
      }
    } else slot = afterLastUser
    slot = Math.max(slot, floor)
    floor = slot
    slots.push(slot)
  })
  return slots
}

/**
 * Where a window of a detail's newest `count` steps starts: at the message just before the oldest of them, which the
 * iPhone places after that message. A run longer than the window is cut inside, so the window holds `count` steps however
 * long the run. Null when the detail holds no more steps than that, or when the oldest of them comes before every message.
 */
export function stepWindowStart(detail: AgentThreadDetail, count: number): StepWindowStart | null {
  const steps = stepsOf(detail)
  if (steps.length <= count) return null
  const oldest = steps.length - count
  const slot = slotsOf(detail.messages, steps, detail.earlierAvailable === true)[oldest]!
  return slot > 0 ? { from: detail.messages[slot - 1]!.id, minSequence: steps[oldest]!.sequence } : null
}

/**
 * A detail from `start` on: the messages from its message, the steps from its sequence and every turn record, with
 * `earlierAvailable` and `earlierSteps`, the steps above it. A start whose message the detail no longer holds gives the
 * whole detail.
 */
export function detailInStepWindow(detail: AgentThreadDetail, start: StepWindowStart | null): { detail: AgentThreadDetail; cut: StepWindowCut } {
  const index = start === null ? -1 : detail.messages.findIndex(message => message.id === start.from)
  const steps = stepsOf(detail)
  const newest = steps.at(-1)?.sequence ?? Number.NEGATIVE_INFINITY
  if (start === null || index < 0) return { detail, cut: { start: null, above: new Set(), steps: steps.length, newest } }
  const kept = steps.filter(step => step.sequence >= start.minSequence).length
  const activities = detail.activities?.filter(record => record.kind === 'turn' || record.sequence >= start.minSequence)
  return {
    detail: { ...detail, messages: detail.messages.slice(index), ...(activities ? { activities } : {}), earlierAvailable: true, earlierSteps: steps.length - kept },
    cut: { start, above: new Set(detail.messages.slice(0, index).map(message => message.id)), steps: kept, newest },
  }
}

/**
 * A delta as a phone holding a step window reads it: a record above the window and a change to a message above it are
 * left out, since the phone holds neither and would take them for new. A removal stays: it removes nothing the phone
 * does not hold. The same delta when nothing is left out.
 */
export function deltaInStepWindow(delta: AgentThreadDetailDelta, cut: StepWindowCut): AgentThreadDetailDelta {
  const start = cut.start
  if (start === null) return delta
  const aboveRecord = (item: AgentThreadDetailDelta['activityDeltas'][number]): boolean =>
    'record' in item && item.record.kind !== 'turn' && item.record.sequence < start.minSequence
  const aboveMessage = (item: AgentMessageDelta): boolean => cut.above.has('message' in item ? item.message.id : item.id)
  if (!delta.activityDeltas.some(aboveRecord) && !delta.messageDeltas.some(aboveMessage)) return delta
  return { ...delta, messageDeltas: delta.messageDeltas.filter(item => !aboveMessage(item)), activityDeltas: delta.activityDeltas.filter(item => !aboveRecord(item)) }
}

/**
 * The cut once the phone holds what a delta sent it: each step newer than any it was sent counts. The same cut when the
 * delta brings no new step.
 */
export function stepWindowAfterDelta(cut: StepWindowCut, delta: AgentThreadDetailDelta): StepWindowCut {
  let steps = cut.steps, newest = cut.newest
  for (const item of delta.activityDeltas) {
    if (!('record' in item) || item.record.kind === 'turn' || item.record.sequence <= cut.newest) continue
    steps++
    newest = Math.max(newest, item.record.sequence)
  }
  return steps === cut.steps ? cut : { ...cut, steps, newest }
}
