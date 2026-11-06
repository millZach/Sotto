import { describe, expect, it } from 'vitest'

import { endRoom, settleAt } from '../../../src/renderer/src/agents/listEndRoom'
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

describe('where a scroll of the thread list settles', () => {
  const rests = [0, 55, 93, 131, 186]

  it('leaves a scroll that ended on a place where it is', () => {
    expect(settleAt(93, 1, rests, 300)).toBeNull()
    expect(settleAt(55.4, -1, rests, 300)).toBeNull()
  })

  it('moves a small scroll on to the next place the way it went, never back to where it started', () => {
    // A touchpad nudge of a few pixels down from the top goes a row down rather than springing back to 0.
    expect(settleAt(3, 1, rests, 300)).toBe(55)
    expect(settleAt(9, 1, rests, 300)).toBe(55)
    // And a few pixels up from a row goes a row up.
    expect(settleAt(90, -1, rests, 300)).toBe(55)
  })

  it('carries a long scroll that ended between rows on to the next row its way', () => {
    expect(settleAt(140, 1, rests, 300)).toBe(186)
    expect(settleAt(140, -1, rests, 300)).toBe(131)
  })

  it('takes the nearest place with no way known or nothing further that way', () => {
    expect(settleAt(60, 0, rests, 300)).toBe(55)
    expect(settleAt(190, 1, rests, 190)).toBe(186)
  })

  it('never goes past the furthest the list scrolls, and does nothing with no places', () => {
    expect(settleAt(170, 1, [0, 55, 400], 180)).toBe(55)
    expect(settleAt(20, 1, [], 300)).toBeNull()
  })
})
