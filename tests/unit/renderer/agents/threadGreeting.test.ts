import { describe, expect, it } from 'vitest'
import { GREETINGS, greetingFor, pickGreeting, timedGreetings } from '../../../../src/renderer/src/agents/threadGreeting.logic'

describe('a new thread’s greeting', () => {
  it('adds a line for the time of day only at that time', () => {
    expect(timedGreetings(8)).toEqual(['Morning. What’s first?'])
    expect(timedGreetings(14)).toEqual([])
    expect(timedGreetings(19)).toEqual(['Evening. What’s left?'])
    expect(timedGreetings(23)).toEqual(['Up late. What are we making?'])
    expect(timedGreetings(3)).toEqual(['Up late. What are we making?'])
  })

  it('picks from the whole pool, the timed line included, and never the line it was asked to avoid', () => {
    const seen = new Set<string>()
    for (let step = 0; step < 100; step++) seen.add(pickGreeting(8, () => step / 100))
    expect([...seen].sort()).toEqual([...GREETINGS, 'Morning. What’s first?'].sort())
    for (let step = 0; step < 100; step++) expect(pickGreeting(14, () => step / 100, GREETINGS[0])).not.toBe(GREETINGS[0])
    expect(pickGreeting(14, () => 0.999999)).toBe(GREETINGS.at(-1))
  })

  it('keeps a thread’s line for as long as the window is open, and gives the next new thread another', () => {
    const noon = new Date(2026, 9, 14, 12)
    const first = greetingFor('greeting-first', noon, () => 0)
    expect(greetingFor('greeting-first', noon, () => 0.5)).toBe(first)
    expect(greetingFor('greeting-second', noon, () => 0)).not.toBe(first)
  })
})
