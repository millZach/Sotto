import type { AgentActivity } from './agentActivity'
import type { AgentMessageDelta, AgentThreadDetail, AgentThreadDetailDelta } from './agents'

/**
 * How many of a thread's newest steps a phone that accepts `step-window` opens it on, and how many more each Show earlier
 * messages adds (ADR-0194; Zach's pick B on November 5, 2026).
 */
export const STEP_WINDOW_STEPS = 200

/** Where a step window starts: at a message, with the steps placed after it from one sequence on, and every step placed later. */
export interface StepWindowStart {
  /** The message the window starts at: the one just before its oldest step. */
  readonly from: string
  /** The oldest step's sequence. A step placed after `from` below it is above the window, even one of the same run. */
  readonly minSequence: number
}

/** Where one phone's step window starts and what lies above it, made from the last whole detail it was sent. */
export interface StepWindowCut {
  /** Null while the phone holds the whole detail. */
  readonly start: StepWindowStart | null
  /** The messages above the window, which a delta must not hand the phone as new. */
  readonly above: ReadonlySet<string>
  /** The steps the detail held that the window left out, by ID, which a delta must not hand the phone either. */
  readonly outside: ReadonlySet<string>
  /** The steps inside the window, counting those its deltas brought since it was cut. */
  readonly steps: number
  /** The newest step's sequence the phone was sent, so a delta's new steps can be counted. */
  readonly newest: number
}

/** The steps of a detail, oldest first by sequence, the order the iPhone's timeline reads them in. Turn records are not steps. */
function stepsOf(detail: AgentThreadDetail): AgentActivity[] {
  return (detail.activities ?? []).filter(record => record.kind !== 'turn').sort((a, b) => a.sequence - b.sequence)
}

/**
 * Each step's slot, the number of messages before it, as the iPhone places it (`ThreadTimeline.merge`, which this follows
 * rule for rule): after the message it names when the detail holds it, wherever its sequence puts it, as a desktop places
 * it; otherwise after every message written no later than it started, a step with no time taking the time of the step
 * before it, or of the first timed step; with no times to compare, after the last message from the user. A step placed by
 * time never goes above the step before it. A step the iPhone leaves out of a window it hasn't loaded keeps the slot of
 * the step before it, so the count stays the detail's.
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
  let previous = 0, cursor = 0
  steps.forEach((step, index) => {
    const after = step.afterMessageId === undefined ? undefined : positions.get(step.afterMessageId)
    const at = stepTimes[index] ?? firstStepTime
    let slot: number
    // A step's own message wins over its sequence: a thread at the step cap can give old steps sequences past newer ones (#2330).
    if (after !== undefined) slot = after + 1
    else if (step.afterMessageId !== undefined && earlierAvailable) slot = previous
    else if (firstMessageTime !== undefined && at !== undefined) {
      if (earlierAvailable && at < firstMessageTime) slot = previous
      else {
        while (cursor < messages.length && (messageTimes[cursor] === undefined || messageTimes[cursor]! <= at)) cursor++
        slot = Math.max(cursor, previous)
      }
    } else slot = Math.max(afterLastUser, previous)
    previous = slot
    slots.push(slot)
  })
  return slots
}

/** The steps' indexes in the order the iPhone shows them: by slot, and by sequence within one. */
function shownOrder(slots: readonly number[]): number[] {
  return slots.map((_, index) => index).sort((a, b) => slots[a]! - slots[b]! || a - b)
}

/** Whether a step is inside a window that starts after the message at `startSlot - 1`, from `minSequence` in that slot. */
function insideWindow(slot: number, sequence: number, startSlot: number, minSequence: number): boolean {
  return slot > startSlot || slot === startSlot && sequence >= minSequence
}

/**
 * Where a window of a detail's newest `count` steps starts, newest as the iPhone shows them: at the message just before
 * the oldest of them, which the iPhone places after that message. A run longer than the window is cut inside, so the
 * window holds `count` steps however long the run. Null when the detail holds no more steps than that, or when the oldest
 * of them comes before every message.
 */
export function stepWindowStart(detail: AgentThreadDetail, count: number): StepWindowStart | null {
  const steps = stepsOf(detail)
  if (steps.length <= count) return null
  const slots = slotsOf(detail.messages, steps, detail.earlierAvailable === true)
  const oldest = shownOrder(slots)[steps.length - count]!
  const slot = slots[oldest]!
  return slot > 0 ? { from: detail.messages[slot - 1]!.id, minSequence: steps[oldest]!.sequence } : null
}

/**
 * A detail from `start` on: the messages from its message, the steps placed after it from its sequence on, every step
 * placed after a later message, and every turn record, with `earlierAvailable` and `earlierSteps`, the steps above it. A
 * start whose message the detail no longer holds gives the whole detail.
 */
export function detailInStepWindow(detail: AgentThreadDetail, start: StepWindowStart | null): { detail: AgentThreadDetail; cut: StepWindowCut } {
  const index = start === null ? -1 : detail.messages.findIndex(message => message.id === start.from)
  const steps = stepsOf(detail)
  const newest = steps.at(-1)?.sequence ?? Number.NEGATIVE_INFINITY
  if (start === null || index < 0) return { detail, cut: { start: null, above: new Set(), outside: new Set(), steps: steps.length, newest } }
  const slots = slotsOf(detail.messages, steps, detail.earlierAvailable === true)
  const outside = new Set<string>()
  steps.forEach((step, position) => { if (!insideWindow(slots[position]!, step.sequence, index + 1, start.minSequence)) outside.add(step.id) })
  const kept = steps.length - outside.size
  const activities = detail.activities?.filter(record => record.kind === 'turn' || !outside.has(record.id))
  return {
    detail: { ...detail, messages: detail.messages.slice(index), ...(activities ? { activities } : {}), earlierAvailable: true, earlierSteps: steps.length - kept },
    cut: { start, above: new Set(detail.messages.slice(0, index).map(message => message.id)), outside, steps: kept, newest },
  }
}

/**
 * A delta as a phone holding a step window reads it: a record above the window and a change to a message above it are
 * left out, since the phone holds neither and would take them for new. A record is above when the window left it out,
 * or when it names a message above the window. A removal stays: it removes nothing the phone does not hold. The same
 * delta when nothing is left out.
 */
export function deltaInStepWindow(delta: AgentThreadDetailDelta, cut: StepWindowCut): AgentThreadDetailDelta {
  const start = cut.start
  if (start === null) return delta
  const aboveRecord = (item: AgentThreadDetailDelta['activityDeltas'][number]): boolean => {
    if (!('record' in item) || item.record.kind === 'turn') return false
    const named = item.record.afterMessageId
    return cut.outside.has(item.record.id) || named !== undefined && cut.above.has(named)
  }
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
