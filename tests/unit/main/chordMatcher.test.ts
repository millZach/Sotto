// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { createChordMatcher, type ChordEvent, type MatcherChord } from '../../../src/main/hotkeys/chordMatcher'

function setup(chords: readonly MatcherChord[], idle = true) {
  const events: string[] = []
  const state = { idle }
  const matcher = createChordMatcher(
    chords,
    (event: ChordEvent) => events.push(`${event.id}:${event.type}`),
    { isIdle: () => state.idle },
  )
  const play = (...steps: string[]) => {
    for (const step of steps) {
      const [type, token] = step.split(' ') as ['down' | 'up', string]
      matcher.key(type, token)
    }
  }
  return { matcher, events, state, play }
}

const holdFn: MatcherChord = { id: 'hold-fn', chord: 'Fn', role: 'hold' }
const holdFnShift: MatcherChord = { id: 'hold-fn-shift', chord: 'Fn+Shift', role: 'hold' }
const holdSpace: MatcherChord = { id: 'hold-space', chord: 'Control+Shift+Space', role: 'hold' }
const pressFnD: MatcherChord = { id: 'press-fn-d', chord: 'Fn+D', role: 'press' }

describe('createChordMatcher', () => {
  it('starts and stops a modifier-only hold', () => {
    const { events, play } = setup([holdFn])
    play('down Fn', 'up Fn')
    expect(events).toEqual(['hold-fn:start', 'hold-fn:stop'])
  })

  it('needs the exact modifier set', () => {
    const { events, play } = setup([holdSpace])
    play('down Control', 'down Alt', 'down Shift', 'down Space', 'up Space', 'up Shift', 'up Alt', 'up Control')
    play('down Shift', 'down Space', 'up Space', 'up Shift')
    expect(events).toEqual([])
    play('down Control', 'down Shift', 'down Space', 'up Space')
    expect(events).toEqual(['hold-space:start', 'hold-space:stop'])
  })

  it('only activates a chord with a key when the key goes down under its modifiers', () => {
    const { events, play } = setup([holdSpace])
    play('down Control', 'down Space', 'down Shift')
    expect(events).toEqual([])
  })

  it('never activates on a release', () => {
    const { events, play } = setup([holdFn, holdFnShift])
    play('down Shift', 'down Fn')
    expect(events).toEqual(['hold-fn-shift:start'])
    play('up Shift')
    expect(events).toEqual(['hold-fn-shift:start', 'hold-fn-shift:stop'])
    play('up Fn')
    expect(events).toEqual(['hold-fn-shift:start', 'hold-fn-shift:stop'])
  })

  it('ignores a hold entirely when dictation is not idle', () => {
    const { events, play, state } = setup([holdFn], false)
    play('down Fn')
    state.idle = true
    play('up Fn')
    expect(events).toEqual([])
    play('down Fn')
    expect(events).toEqual(['hold-fn:start'])
  })

  it('keeps a skipped hold inert until all its tokens are up', () => {
    const { events, play, state } = setup([holdSpace], false)
    play('down Control', 'down Shift', 'down Space')
    state.idle = true
    play('up Space', 'down Space', 'up Space')
    expect(events).toEqual([])
    play('up Shift', 'up Control', 'down Control', 'down Shift', 'down Space')
    expect(events).toEqual(['hold-space:start'])
  })

  it.each([['Other'], ['A'], ['Shift']])('cancels a modifier-only hold when %s goes down', (token) => {
    const { events, play } = setup([holdFn])
    play('down Fn', `down ${token}`, `up ${token}`)
    expect(events).toEqual(['hold-fn:start', 'hold-fn:cancel'])
    play('up Fn')
    expect(events).toEqual(['hold-fn:start', 'hold-fn:cancel'])
    play('down Fn')
    expect(events).toEqual(['hold-fn:start', 'hold-fn:cancel', 'hold-fn:start'])
  })

  it('ignores extra keys during a hold with a key', () => {
    const { events, play } = setup([holdSpace])
    play('down Control', 'down Shift', 'down Space', 'down Other', 'down A', 'down Alt', 'up A', 'up Other', 'up Alt')
    expect(events).toEqual(['hold-space:start'])
    play('up Shift')
    expect(events).toEqual(['hold-space:start', 'hold-space:stop'])
  })

  it('re-arms a press chord only after one of its tokens goes up', () => {
    const { events, play } = setup([pressFnD])
    play('down Fn', 'down D', 'down Other', 'up Other')
    expect(events).toEqual(['press-fn-d:toggle'])
    play('up D', 'down D')
    expect(events).toEqual(['press-fn-d:toggle', 'press-fn-d:toggle'])
    play('up Fn', 'down Fn', 'up D', 'down D')
    expect(events).toEqual(['press-fn-d:toggle', 'press-fn-d:toggle', 'press-fn-d:toggle'])
  })

  it('cancels on reset only a hold it started', () => {
    const skipped = setup([holdFn], false)
    skipped.play('down Fn')
    skipped.matcher.reset()
    expect(skipped.events).toEqual([])

    const { matcher, events, play } = setup([holdFn, pressFnD])
    play('down Fn')
    matcher.reset()
    expect(events).toEqual(['hold-fn:start', 'hold-fn:cancel'])
    matcher.reset()
    play('up Fn')
    expect(events).toEqual(['hold-fn:start', 'hold-fn:cancel'])
    play('down Fn')
    expect(events).toEqual(['hold-fn:start', 'hold-fn:cancel', 'hold-fn:start'])
  })

  it('treats left and right modifiers as one token, as the helper collapses them', () => {
    const { events, play } = setup([holdSpace])
    play('down Control', 'down Control', 'down Shift', 'down Space')
    play('up Control')
    play('down Control', 'down Space')
    expect(events).toEqual(['hold-space:start', 'hold-space:stop'])
  })

  it('watches every token of every chord once', () => {
    const { matcher } = setup([holdFn, holdSpace, pressFnD])
    expect(matcher.watchedTokens()).toEqual(['Fn', 'Control', 'Shift', 'Space', 'D'])
  })
})

describe('ChordMatcher releaseHolds', () => {
  it('ends a started hold with no event, then re-arms once its tokens are up', () => {
    const { matcher, events, play } = setup([holdFn])
    play('down Fn')
    matcher.releaseHolds()
    play('up Fn')
    expect(events).toEqual(['hold-fn:start'])
    play('down Fn')
    expect(events).toEqual(['hold-fn:start', 'hold-fn:start'])
  })

  it('leaves nothing to cancel on reset after a release', () => {
    const { matcher, events, play } = setup([holdSpace])
    play('down Control', 'down Shift', 'down Space')
    matcher.releaseHolds()
    matcher.reset()
    expect(events).toEqual(['hold-space:start'])
  })
})
