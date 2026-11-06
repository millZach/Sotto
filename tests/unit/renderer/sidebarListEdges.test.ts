import { describe, expect, it } from 'vitest'

import { endRoom } from '../../../src/renderer/src/agents/listEndRoom'
import { cutAtWord } from '../../../src/renderer/src/agents/wordCut'

/** A line that holds `room` characters, every character one unit wide. */
const holds = (room: number) => (text: string): boolean => text.length <= room

describe('a one-line sidebar title cut at a word', () => {
  it('is left whole while it fits', () => {
    expect(cutAtWord('Repository review', holds(20))).toBe('Repository review')
  })

  it('ends at the last whole word that fits with its ellipsis', () => {
    expect(cutAtWord('Write the split plan down', holds(22))).toBe('Write the split plan…')
    expect(cutAtWord('Translate Settings into Spanish', holds(26))).toBe('Translate Settings into…')
    // "plan…" would not fit beside "split", so the cut goes back a word rather than into one.
    expect(cutAtWord('Write the split plan down', holds(19))).toBe('Write the split…')
  })

  it('drops the punctuation a cut word leaves hanging', () => {
    expect(cutAtWord('Fix the socket, then the host flake', holds(20))).toBe('Fix the socket…')
  })

  it('leaves a first word too long for the line to the line\'s own ellipsis', () => {
    expect(cutAtWord('Supercalifragilistic expialidocious', holds(10))).toBe('Supercalifragilistic expialidocious')
  })
})

describe('the thread list\'s end room', () => {
  it('needs none when the list does not scroll or its end already rests on a row', () => {
    expect(endRoom(0, [0, 40, 80])).toBe(0)
    expect(endRoom(120, [0, 40, 80, 120.2, 160])).toBe(0)
  })

  it('reaches the first resting place past the end, so the furthest scroll is a row\'s edge', () => {
    expect(endRoom(101, [0, 54, 91, 128, 165, 219])).toBe(27)
  })

  it('needs none when every resting place lies before the end', () => {
    expect(endRoom(300, [0, 54, 91])).toBe(0)
  })
})
