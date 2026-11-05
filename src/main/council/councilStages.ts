import { COUNCIL_CHAIR, COUNCIL_FAIRNESS_WAIT_MS, type CouncilKind, type CouncilRowAction, type CouncilStage, type CouncilThreadState, type CouncilTurnStage } from '../../shared/council'
import type { CouncilCrux, CouncilFraming } from '../../shared/councilBlocks'
import { reviewAssignments } from '../../shared/councilFlow'
import type { CouncilRecord, CouncilRound, CouncilSeat, CouncilTurn } from './councilRecord'

/**
 * The Council's stages (ADR-0177 decision 4, `docs/plans/2026-11-02-council-workflow.md`), as plain changes to its
 * record: framing by the chair, answers alone, reviews under letters, at most one crux check, the verdict and the
 * fairness check. Each change queues the prompts the next stage needs; the service sends a queued prompt once its thread
 * is free and reads what comes back. Nothing here leaves a thread out on its own: a thread that fails, stops, is unknown
 * or passes the stage deadline holds its stage until the user retries it, gives its seat another model or goes on
 * without it. Pure, so the stage machine is tested without threads.
 */

export interface StageClock { readonly now: number; readonly newId: () => string }

/** The round stage a turn belongs to. */
export const TURN_ROUND_STAGE: Readonly<Record<Exclude<CouncilTurnStage, 'history'>, CouncilStage>> = {
  framing: 'framing', answer: 'answers', review: 'reviews', crux: 'crux', verdict: 'verdict', fairness: 'fairness', amend: 'fairness',
}

export const isPanelist = (seat: CouncilSeat): boolean => seat.role === 'panelist'
export const currentRound = (record: CouncilRecord): CouncilRound => record.rounds.at(-1)!
export function activePanelists(record: CouncilRecord, round: CouncilRound): CouncilSeat[] {
  return record.seats.filter(seat => isPanelist(seat) && !round.leftOut.includes(seat.seat))
}
/** The seat's prompt for a stage in a round: its newest one not retried, replaced or left out. Repairs are their own. */
export function currentTurn(record: CouncilRecord, round: CouncilRound, stage: CouncilTurnStage, seat: string): CouncilTurn | undefined {
  return record.turns.findLast(turn => turn.round === round.index && turn.stage === stage && turn.seat === seat && !turn.repairOf && !turn.superseded)
}
export function repairFor(record: CouncilRecord, turn: CouncilTurn): CouncilTurn | undefined {
  return record.turns.findLast(item => item.repairOf === turn.id && !item.superseded)
}
/** Nothing more will come of the prompt by itself: it was answered, failed, stopped, is unknown, or was never sent. */
export function isFinal(turn: CouncilTurn): boolean {
  return turn.delivery === 'failed' || turn.delivery === 'unconfirmed' || turn.outcome !== undefined && turn.outcome !== 'working'
}
/** The prompt gave its stage what it can: an answer whose block was read, repaired, found unavailable, or has none. */
export function isComplete(turn: CouncilTurn): boolean {
  return turn.outcome === 'answered' && (turn.result === 'valid' || turn.result === 'unavailable' || turn.result === 'none')
}
/** The panelists with an answer in the round, by letter: those still sitting and those left out after answering. */
export function answeredLetters(record: CouncilRecord, round: CouncilRound): string[] {
  return record.seats.filter(isPanelist).flatMap(seat => { const turn = currentTurn(record, round, 'answer', seat.seat); return turn && isComplete(turn) ? [seat.seat] : [] })
}

function queue(record: CouncilRecord, round: CouncilRound, seat: string, stage: CouncilTurnStage, clock: StageClock, extra: Partial<CouncilTurn> = {}): CouncilTurn {
  const thread = record.seats.find(item => item.seat === seat)!.thread
  // A conversation too long for one prompt goes to a thread in parts before its first stage prompt, each its own prompt.
  if (stage !== 'history' && record.history.parts > 1 && !record.turns.some(item => item.thread === thread && item.stage === 'history' && !item.superseded)) {
    for (let part = 1; part <= record.history.parts; part++) record.turns.push({ id: clock.newId(), round: round.index, seat, thread, stage: 'history', part, draftId: clock.newId(),
      messageId: clock.newId(), delivery: 'queued', result: 'pending', queuedAt: new Date(clock.now).toISOString() })
  }
  const turn: CouncilTurn = { id: clock.newId(), round: round.index, seat, thread, stage, draftId: clock.newId(), messageId: clock.newId(), delivery: 'queued', result: 'pending',
    queuedAt: new Date(clock.now).toISOString(), ...extra }
  record.turns.push(turn)
  return turn
}

/**
 * Who runs a crux check (decision 4): a panelist on neither side, or else one from each side, each trying to establish
 * the other side's claim. The first runner then stands for the first side.
 */
export function cruxRunners(record: CouncilRecord, round: CouncilRound, crux: CouncilCrux): string[] {
  const sitting = activePanelists(record, round).map(seat => seat.seat)
  const sides = new Set(crux.sides.flat())
  const neutral = sitting.find(seat => !sides.has(seat))
  if (neutral) return [neutral]
  return crux.sides.flatMap(side => side.filter(letter => sitting.includes(letter)).slice(0, 1))
}

/** One step of a round's stage; true when it queued a prompt or moved the stage. */
function step(record: CouncilRecord, round: CouncilRound, clock: StageClock): boolean {
  const at = new Date(clock.now).toISOString()
  const done = (): true => { round.stage = 'done'; round.doneAt = at; return true }
  switch (round.stage) {
    case 'framing': {
      if (round.framingFallback) { round.stage = 'answers'; return true }
      const turn = currentTurn(record, round, 'framing', COUNCIL_CHAIR)
      if (!turn) { queue(record, round, COUNCIL_CHAIR, 'framing', clock); return true }
      // A framing that fails or cannot be read leaves the question alone (decision 4); answers start as soon as it is in.
      if (isComplete(turn) || isFinal(turn) && turn.outcome !== 'answered') {
        if (turn.result === 'valid' && turn.block !== undefined) round.framing = turn.block as CouncilFraming
        else round.framingFallback = true
        round.stage = 'answers'
        return true
      }
      return false
    }
    case 'answers': {
      const sitting = activePanelists(record, round)
      const missing = sitting.filter(seat => !currentTurn(record, round, 'answer', seat.seat))
      for (const seat of missing) queue(record, round, seat.seat, 'answer', clock)
      if (missing.length) return true
      if (!sitting.every(seat => isComplete(currentTurn(record, round, 'answer', seat.seat)!))) return false
      const letters = answeredLetters(record, round)
      if (letters.length === 0) return done()
      if (letters.length === 1) { round.stage = 'verdict'; return true }
      round.reviewPlan = Object.fromEntries(reviewAssignments(letters, letters.filter(letter => !round.leftOut.includes(letter))))
      round.stage = 'reviews'
      return true
    }
    case 'reviews': {
      const readers = Object.keys(round.reviewPlan ?? {}).filter(letter => !round.leftOut.includes(letter))
      const missing = readers.filter(reader => !currentTurn(record, round, 'review', reader))
      for (const reader of missing) queue(record, round, reader, 'review', clock)
      if (missing.length) return true
      if (!readers.every(reader => isComplete(currentTurn(record, round, 'review', reader)!))) return false
      round.stage = 'verdict'
      return true
    }
    case 'verdict': {
      const turn = currentTurn(record, round, 'verdict', COUNCIL_CHAIR)
      if (!turn) { queue(record, round, COUNCIL_CHAIR, 'verdict', clock); return true }
      if (!isComplete(turn)) return false
      if (turn.result === 'valid' && turn.block !== undefined && !round.cruxDone) {
        // The chair asked for a crux check rather than writing the verdict: it runs once, then the chair writes it.
        const crux = turn.block as CouncilCrux
        round.crux = crux
        round.cruxRunners = cruxRunners(record, round, crux)
        turn.superseded = true
        round.stage = 'crux'
        return true
      }
      if (turn.result === 'unavailable') {
        // It asked for a crux check Sotto could not read, even after a repair: it writes the verdict without one.
        round.cruxDone = true
        turn.superseded = true
        return true
      }
      // The fairness check's two minutes start when its first prompt is sent, not here.
      round.stage = 'fairness'
      return true
    }
    case 'crux': {
      const runners = (round.cruxRunners ?? []).filter(runner => !round.leftOut.includes(runner))
      const missing = runners.filter(runner => !currentTurn(record, round, 'crux', runner))
      const two = (round.cruxRunners ?? []).length === 2
      for (const runner of missing) queue(record, round, runner, 'crux', clock, two ? { establish: round.cruxRunners!.indexOf(runner) === 0 ? 1 : 0 } : {})
      if (missing.length) return true
      if (!runners.every(runner => isComplete(currentTurn(record, round, 'crux', runner)!))) return false
      round.cruxDone = true
      round.stage = 'verdict'
      return true
    }
    case 'fairness': {
      const sitting = activePanelists(record, round).filter(seat => answeredLetters(record, round).includes(seat.seat))
      const missing = sitting.filter(seat => !currentTurn(record, round, 'fairness', seat.seat))
      for (const seat of missing) queue(record, round, seat.seat, 'fairness', clock)
      // Objections that quote both sides go to the chair, every one waiting in one short turn.
      const waiting = round.objections.filter(objection => objection.answer === 'pending' && !objection.turn)
      const amend = currentTurn(record, round, 'amend', COUNCIL_CHAIR)
      if (waiting.length && (!amend || isFinal(amend))) {
        const turn = queue(record, round, COUNCIL_CHAIR, 'amend', clock, { objections: waiting.map(objection => objection.seat) })
        for (const objection of waiting) objection.turn = turn.id
        return true
      }
      if (missing.length) return true
      const amends = record.turns.filter(item => item.round === round.index && item.stage === 'amend' && !item.repairOf && !item.superseded)
      if (sitting.every(seat => isComplete(currentTurn(record, round, 'fairness', seat.seat)!)) && amends.every(isComplete) && !waiting.length) return done()
      return false
    }
    case 'done':
      return false
  }
}

/**
 * Moves a round on as far as its prompts allow (decision 4), and asks once more for a result block a reply lacked. A
 * repair that ends without one leaves its prompt's result unavailable, which never counts as disagreement or as zero.
 * Returns whether anything changed. A stopped or settled Council stays as it is.
 */
export function advanceRound(record: CouncilRecord, clock: StageClock): boolean {
  if (record.stoppedAt || record.settledAt) return false
  const round = currentRound(record)
  let changed = false
  for (const turn of record.turns) {
    if (turn.round !== round.index || turn.superseded || turn.repairOf || turn.outcome !== 'answered' || turn.result !== 'invalid') continue
    const repair = repairFor(record, turn)
    if (!repair) { queue(record, round, turn.seat, turn.stage, clock, { repairOf: turn.id, ...turn.objections ? { objections: turn.objections } : {} }); changed = true }
    else if (isFinal(repair) && repair.result !== 'valid' && !(repair.outcome === 'answered' && repair.result === 'pending')) { turn.result = 'unavailable'; changed = true }
  }
  for (let moves = 0; moves < 12 && step(record, round, clock); moves++) changed = true
  return changed
}

/** A thread's state in its row (decision 4). */
export function turnState(turn: CouncilTurn, waitingOnUser: boolean): CouncilThreadState {
  if (turn.delivery === 'failed') return 'failed'
  if (turn.delivery === 'unconfirmed') return 'unknown'
  if (turn.outcome === 'answered') return 'done'
  if (turn.outcome === 'failed' || turn.outcome === 'stopped' || turn.outcome === 'unknown') return turn.outcome
  return waitingOnUser ? 'waiting' : 'working'
}

/** When a prompt's stage deadline counts from: its send, or while it waits for its thread to be free, its queueing. */
function deadlineFrom(turn: CouncilTurn): string | undefined { return turn.sentAt ?? turn.queuedAt }
/**
 * Whether a prompt has passed the stage deadline without an end: sent and not answered, or queued and never sent because
 * its thread stayed busy with other work or waited on the user. A prompt waiting behind its own thread's parts of the
 * conversation waits on the Council itself, and is not late for it.
 */
export function isLate(turn: CouncilTurn, now: number, deadlineMs: number, record?: CouncilRecord): boolean {
  const since = deadlineFrom(turn)
  if (isFinal(turn) || since === undefined || now <= Date.parse(since) + deadlineMs) return false
  return !(record && turn.delivery === 'queued' && waitsOnParts(record, turn))
}
function waitsOnParts(record: CouncilRecord, turn: CouncilTurn): boolean {
  return turn.stage !== 'history' && record.turns.some(item => item.thread === turn.thread && item.stage === 'history' && !item.superseded && !isComplete(item))
}

/**
 * What a row offers (decision 4): once its thread passed the deadline, failed, stopped or is unknown, Retry, Use another
 * model and Go on without it. A failed chair offers the first two, save its framing, which the Council can go on without,
 * and its answer to objections. Retry waits while the thread waits on the user, since nothing more is sent to it until
 * the user has answered. Only the current stage's rows act, and nothing acts on a stopped or settled Council.
 */
export function rowActions(record: CouncilRecord, turn: CouncilTurn, now: number, waitingOnUser: boolean): CouncilRowAction[] {
  const round = currentRound(record)
  // A part of the conversation holds its thread's first prompt in whatever stage that is; any other row acts in its own stage.
  if (record.stoppedAt || record.settledAt || turn.superseded || turn.repairOf || turn.round !== round.index || round.stage === 'done'
    || turn.stage !== 'history' && TURN_ROUND_STAGE[turn.stage] !== round.stage) return []
  const stuck = turn.delivery === 'failed' || turn.delivery === 'unconfirmed' || turn.outcome === 'failed' || turn.outcome === 'stopped' || turn.outcome === 'unknown'
    || isLate(turn, now, record.deadlineMinutes * 60_000, record)
  if (!stuck) return []
  const actions: CouncilRowAction[] = waitingOnUser ? [] : ['retry']
  actions.push('replace')
  if (turn.seat !== COUNCIL_CHAIR || turn.stage === 'framing' || turn.stage === 'amend') actions.push('skip')
  return actions
}

/**
 * Retry: the seat is sent its stage's prompt again, as a new prompt. The caller stops the old one if it still runs. The
 * chair's answer to objections is queued again by its stage, with every objection then waiting.
 */
export function retryTurn(record: CouncilRecord, turn: CouncilTurn, clock: StageClock): void {
  turn.superseded = true
  for (const repair of record.turns) if (repair.repairOf === turn.id) repair.superseded = true
  const round = record.rounds.find(item => item.index === turn.round)!
  if (turn.stage === 'amend') { for (const objection of round.objections) if (objection.turn === turn.id) delete objection.turn; return }
  queue(record, round, turn.seat, turn.stage, clock, { ...turn.establish === undefined ? {} : { establish: turn.establish }, ...turn.part === undefined ? {} : { part: turn.part } })
}

/**
 * Go on without it: a panelist sits out the rest of the round, and the verdict says the Council went on with fewer. For
 * the chair, the framing goes on with the question alone, and objections it was answering stay unanswered.
 */
export function leaveOut(record: CouncilRecord, turn: CouncilTurn): void {
  turn.superseded = true
  const round = record.rounds.find(item => item.index === turn.round)!
  if (turn.seat === COUNCIL_CHAIR) {
    if (turn.stage === 'framing') round.framingFallback = true
    if (turn.stage === 'amend') for (const objection of round.objections) if (objection.turn === turn.id) objection.answer = 'unanswered'
    return
  }
  if (!round.leftOut.includes(turn.seat)) round.leftOut.push(turn.seat)
  // Nothing more goes to it in this round: what was waiting to be sent is set aside.
  for (const item of record.turns) if (item.seat === turn.seat && item.round === round.index && item.delivery === 'queued') item.superseded = true
}

/** Use another model: the seat moves to a new thread, which starts with the origin conversation, and is sent the stage again. */
export function replaceSeat(record: CouncilRecord, turn: CouncilTurn, seat: Pick<CouncilSeat, 'modelId' | 'modelName' | 'provider' | 'effort'>, thread: string, clock: StageClock): void {
  const held = record.seats.find(item => item.seat === turn.seat)!
  held.formerThreads = [...held.formerThreads, held.thread].slice(-20)
  Object.assign(held, { modelId: seat.modelId, modelName: seat.modelName, effort: seat.effort, thread, started: false, context: false })
  if (seat.provider) held.provider = seat.provider; else delete held.provider
  // A part of the conversation is not sent again on its own: the stage's prompt to the new thread brings every part first.
  if (turn.stage === 'history') { turn.superseded = true; return }
  retryTurn(record, turn, clock)
}

/**
 * The verdict may go to its thread (decision 5): every panelist still sitting has answered the fairness check, or two
 * minutes have passed since its first prompt was sent; and no objection waits on the chair, nor an answer to one is
 * still being written, so the verdict cannot change under a draft already placed.
 */
export function fairnessDone(record: CouncilRecord, round: CouncilRound, now: number): boolean {
  if (!round.fairnessAt) return false
  if (round.objections.some(objection => objection.answer === 'pending')) return false
  if (record.turns.some(turn => turn.round === round.index && turn.stage === 'amend' && !turn.superseded && !isComplete(turn))) return false
  if (now >= Date.parse(round.fairnessAt) + COUNCIL_FAIRNESS_WAIT_MS) return true
  const letters = answeredLetters(record, round)
  return activePanelists(record, round).filter(seat => letters.includes(seat.seat)).every(seat => { const turn = currentTurn(record, round, 'fairness', seat.seat); return turn !== undefined && isComplete(turn) })
}

/** When something about the Council next changes by the clock alone: a deadline passing, or the fairness check's two minutes. */
export function nextClockChange(record: CouncilRecord, now: number): number | undefined {
  if (record.stoppedAt || record.settledAt) return undefined
  const due: number[] = []
  const deadline = record.deadlineMinutes * 60_000
  for (const turn of record.turns) { const since = deadlineFrom(turn); if (!turn.superseded && since && !isFinal(turn)) due.push(Date.parse(since) + deadline + 1) }
  for (const round of record.rounds) if (round.fairnessAt && !fairnessDone(record, round, now)) due.push(Date.parse(round.fairnessAt) + COUNCIL_FAIRNESS_WAIT_MS)
  const next = Math.min(...due.filter(time => time > now))
  return Number.isFinite(next) ? next : undefined
}

/** The round's kind: the user's, set in the record, over the chair's framing, which a decision stands in for when it failed. */
export function kindsOf(round: CouncilRound): CouncilKind[] { return round.kinds ?? round.framing?.kinds ?? ['decision'] }
/** The criteria answers are held to: the user's, set in the record, over the chair's. */
export function criteriaOf(round: CouncilRound): readonly { readonly id: string; readonly source: 'question' | 'assumed' | 'user'; readonly text: string }[] {
  return round.criteria ?? round.framing?.criteria ?? []
}
/** Whether the round's panelists research outside the snapshot: the user's word in the record over the chair's framing. */
export function researchOf(round: CouncilRound): boolean { return round.research ?? round.framing?.research.needed ?? false }

/** Whether the user can change the round's kind or research now: once framing is in, before the verdict. */
export function reframable(record: CouncilRecord): boolean {
  const round = currentRound(record)
  return !record.stoppedAt && !record.settledAt && (round.stage === 'answers' || round.stage === 'reviews')
}

/**
 * The user changes the round's kind or whether it needs outside research in the record (decision 4): every answer and
 * review so far is set aside and the panelists answer again. Returns the threads still working on one, for the caller to
 * stop. Nothing changes when it would change nothing.
 */
export function reframe(record: CouncilRecord, change: { readonly kinds?: readonly CouncilKind[]; readonly research?: boolean; readonly criteria?: readonly string[] }, now: number): string[] | undefined {
  const round = currentRound(record)
  const kinds = change.kinds ? [...change.kinds] : undefined
  const sameKinds = !kinds || kinds.join() === kindsOf(round).join()
  const sameResearch = change.research === undefined || change.research === researchOf(round)
  const sameCriteria = !change.criteria || change.criteria.join('\n') === criteriaOf(round).map(criterion => criterion.text).join('\n')
  if (!reframable(record) || sameKinds && sameResearch && sameCriteria) return undefined
  if (kinds) round.kinds = kinds
  if (change.criteria && !sameCriteria) round.criteria = change.criteria.map((text, index) => ({ id: `C${index + 1}`, source: 'user' as const, text }))
  if (change.research !== undefined) round.research = change.research
  round.reframedAt = new Date(now).toISOString()
  const running: string[] = []
  for (const turn of record.turns) {
    if (turn.round !== round.index || turn.superseded || turn.stage !== 'answer' && turn.stage !== 'review') continue
    if (!isFinal(turn) && turn.delivery !== 'queued') running.push(turn.thread)
    turn.superseded = true
  }
  delete round.reviewPlan
  round.stage = 'answers'
  return [...new Set(running)]
}

/** Puts a follow-up question to the same threads (decision 4), once the round before it is done. */
export function addRound(record: CouncilRecord, question: string, now: number): CouncilRound {
  const round: CouncilRound = { index: record.rounds.length, askedAt: new Date(now).toISOString(), stage: 'framing', leftOut: [], objections: [], question,
    ...(record.rounds[0]?.evidence ? { evidence: record.rounds[0].evidence } : {}) }
  record.rounds.push(round)
  return round
}
