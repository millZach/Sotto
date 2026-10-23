import { describe, expect, it } from 'vitest'

import type { AgentMessage, AgentRequest } from '../../../src/shared/agents'
import {
  nearestTick, plainOpening, scrubberAfter, scrubberLane, scrubberMarks, scrubberShown, swell, tickPlaces,
  SCRUBBER_LANE_PX, SWELL_SIGMA_PX,
} from '../../../src/renderer/src/agents/messageScrubberMarks'

const at = '2026-10-22T10:00:00.000Z'
const user = (id: string, text: string, patch: Partial<AgentMessage> = {}): AgentMessage => ({ id, role: 'user', text, createdAt: at, ...patch })
const reply = (id: string, text: string): AgentMessage => ({ id, role: 'assistant', text, createdAt: at })

describe('the ticks', () => {
  it('marks each message the user sent, with the last reply that has words before the next one', () => {
    const marks = scrubberMarks([
      user('u1', 'Why does the pill flicker?'), reply('r1a', 'Looking.'), reply('r1b', ''), reply('r1c', 'Both hosts write in one frame.'),
      user('u2', 'Debounce it.'), reply('r2', 'Done.'),
      user('u3', 'And the iPhone?'),
    ])
    expect(marks.map(mark => [mark.messageId, mark.index, mark.reply?.id, mark.newest])).toEqual([['u1', 0, 'r1c', false], ['u2', 4, 'r2', false], ['u3', 6, undefined, true]])
  })

  it('leaves out Sotto’s wake-ups and another thread’s briefs, and what answered them', () => {
    const marks = scrubberMarks([
      user('u1', 'Open the PR.'), reply('r1', 'Opened #1102.'),
      user('wake', 'CI is green.', { wakeUp: true }), reply('rw', 'Ready to merge.'),
      user('brief', 'Review this diff.'), reply('rb', 'Two findings.'),
      user('u2', 'Merge it.'),
    ], new Set(['brief']))
    expect(marks.map(mark => [mark.messageId, mark.reply?.id])).toEqual([['u1', 'r1'], ['u2', undefined]])
  })

  it('leaves the newest message sent without the open question when a wake-up came after it', () => {
    const marks = scrubberMarks([user('u1', 'Open the PR.'), reply('r1', 'Opened #1102.'), user('wake', 'CI is green.', { wakeUp: true })])
    expect(marks.map(mark => mark.newest)).toEqual([false])
    const request: AgentRequest = { id: 'q', kind: 'question', text: 'Merge now?', options: [{ id: 'yes', label: 'Yes' }] }
    expect(scrubberAfter(marks[0]!, [request])).toEqual({ kind: 'reply', text: 'Opened #1102.' })
  })
})

describe('when the scrubber shows', () => {
  it('needs three messages sent and a conversation two screens tall, or more above the first one drawn', () => {
    expect(scrubberShown(3, 1200, 600, false)).toBe(true)
    expect(scrubberShown(3, 1199, 600, false)).toBe(false)
    expect(scrubberShown(2, 5000, 600, false)).toBe(false)
    expect(scrubberShown(3, 300, 600, true)).toBe(true)
    expect(scrubberShown(3, 5000, 0, false)).toBe(false)
  })

  it('takes the margin up to its widest lane, and none from a margin too narrow to reach', () => {
    expect(scrubberLane(300)).toBe(SCRUBBER_LANE_PX)
    expect(scrubberLane(24)).toBe(24)
    expect(scrubberLane(13)).toBe(0)
  })
})

describe('where the ticks sit', () => {
  it('spaces them evenly in one column centred on the transcript', () => {
    const { pitch, places } = tickPlaces(5, 600)
    expect(pitch).toBe(9)
    expect(places).toEqual([282, 291, 300, 309, 318])
  })

  it('packs a long conversation closer, so the column always fits the transcript', () => {
    const { pitch, places } = tickPlaces(101, 600)
    expect(pitch).toBeCloseTo(4.8)
    expect(places[0]).toBeCloseTo(60)
    expect(places.at(-1)).toBeCloseTo(540)
    const packed = tickPlaces(400, 400).places
    expect(packed[0]).toBeCloseTo(40)
    expect(packed.at(-1)).toBeCloseTo(360)
    expect(tickPlaces(1, 600).places).toEqual([300])
    expect(tickPlaces(0, 600).places).toEqual([])
  })

  it('reaches the nearest tick within reach and nothing further', () => {
    const places = [100, 109, 118]
    expect(nearestTick(places, 111, 14)).toBe(1)
    expect(nearestTick(places, 80, 14)).toBe(-1)
    expect(nearestTick(places, 131, 14)).toBe(2)
  })

  it('swells on a normal curve: whole under the pointer, less the further a tick is, and nothing at rest', () => {
    const places = [100, 100 + SWELL_SIGMA_PX, 100 + 2 * SWELL_SIGMA_PX, 400]
    const heights = swell(places, 100)
    expect(heights[0]).toBe(1)
    expect(heights[1]).toBeCloseTo(Math.exp(-0.5))
    expect(heights[2]).toBeCloseTo(Math.exp(-2))
    expect(heights[3]).toBeLessThan(0.001)
    expect(swell(places, null)).toEqual([0, 0, 0, 0])
  })
})

describe('what a card shows', () => {
  const marks = scrubberMarks([
    user('u1', '**Can you** also make a [video](https://example.test) of `two hosts`?'), reply('r1', 'Recorded it at 1280x800.\n\n```sh\nnpm run video\n```\nSaved to `artifacts/`.'),
    user('u2', 'Then what?'), reply('r2', 'I can record it two ways.\n\nWhich one do you want?'),
    user('u3', 'Draft the notes.'),
  ])

  it('reads the message and the reply as the words they show', () => {
    expect(plainOpening(marks[0]!.message.text)).toBe('Can you also make a video of two hosts?')
    expect(scrubberAfter(marks[0]!, [])).toEqual({ kind: 'reply', text: 'Recorded it at 1280x800. npm run video Saved to artifacts/.' })
    expect(plainOpening('x'.repeat(300), 20)).toBe(`${'x'.repeat(19)}…`)
    // A message of code alone still shows its code.
    expect(plainOpening('```ts\nconst one = 1\n```')).toBe('const one = 1')
  })

  it('shows the question a reply ended on', () => {
    expect(scrubberAfter(marks[1]!, [])).toEqual({ kind: 'asked', question: 'Which one do you want?', choices: [], more: 0 })
  })

  it('shows the newest message’s open question with its first choices, and nothing yet for a turn without a reply', () => {
    const request: AgentRequest = { id: 'q', kind: 'question', text: 'Notes', options: [], questions: [{ id: 'len', question: 'How should the notes read?', multiSelect: false, allowFreeText: true,
      options: ['Five lines (Recommended)', 'One line per PR', 'By area', 'As a table'].map((label, index) => ({ id: `o${index}`, label })) }] }
    expect(scrubberAfter(marks[2]!, [request])).toEqual({ kind: 'asked', question: 'How should the notes read?', choices: ['Five lines', 'One line per PR', 'By area'], more: 1 })
    expect(scrubberAfter(marks[2]!, [])).toEqual({ kind: 'none' })
    // An earlier message never borrows the open question.
    expect(scrubberAfter(marks[0]!, [request]).kind).toBe('reply')
  })
})
