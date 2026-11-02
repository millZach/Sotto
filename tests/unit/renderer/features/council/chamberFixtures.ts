import type { CouncilRoundView, CouncilRow, CouncilSeatView, CouncilView } from '../../../../../src/shared/council'

/** A Council's record as main reads it to the window, with three panelists on three providers and a chair on a fourth. */
export const SEATS: readonly CouncilSeatView[] = [
  { seat: 'A', role: 'panelist', modelId: 'claude:opus', modelName: 'Opus 5.5', provider: 'claude', effort: 'high', thread: 'thread-a', remote: false },
  { seat: 'B', role: 'panelist', modelId: 'codex:gpt-6.1-sol', modelName: 'GPT-6.1 Sol', provider: 'codex', effort: 'high', thread: 'thread-b', remote: false },
  { seat: 'C', role: 'panelist', modelId: 'grok:grok-4.7', modelName: 'Grok 4.7', provider: 'grok', effort: 'high', thread: 'thread-c', remote: false },
  { seat: 'chair', role: 'chair', modelId: 'muse:wonder-full', modelName: 'Wonder Full', provider: 'muse', effort: 'high', thread: 'thread-chair', remote: false },
]

let turns = 0
export function row(seat: string, stage: CouncilRow['stage'], state: CouncilRow['state'], patch: Partial<CouncilRow> = {}): CouncilRow {
  const thread = SEATS.find(item => item.seat === seat)?.thread ?? 'thread-x'
  return { turn: `00000000-0000-4000-8000-${String(++turns).padStart(12, '0')}`, seat, stage, state, late: false, repair: false,
    result: state === 'done' ? 'valid' : 'pending', thread, actions: [], ...patch }
}

export function councilFixture(round: Partial<CouncilRoundView>, patch: Partial<CouncilView> = {}): CouncilView {
  return {
    id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-11-02T10:00:00.000Z', origin: { thread: 'origin', title: 'Thread store migration' },
    status: 'working', snapshot: { commit: 'abc1234', branch: 'main', untracked: 0, dirty: false, removed: false }, history: { messages: 12, words: 3_000, parts: 1 },
    seats: [...SEATS], deadlineMinutes: 10,
    rounds: [{ index: 0, question: 'Move history into node:sqlite now?', askedAt: '2026-11-02T10:00:00.000Z', stage: 'answers', framing: null, rows: [], leftOut: [],
      reframable: false, crux: null, verdict: null, draft: null, ...round }],
    ...patch,
  }
}
