import { describe, expect, it } from 'vitest'
import {
  babysitClock, babysitEndedOf, babysitLine, babysittingOf, endedWords, offersBabysitting, pullRequestKeyOf, pullRequestNumbers,
} from '../../../src/renderer/src/agents/babysitting'
import type { AgentThread } from '../../../src/shared/agents'

/** What the window says about babysitting (ADR-0061, variant C), read from what the host published. */
const URL = 'https://github.com/o/r/pull/74'
const NOW = new Date(2026, 9, 8, 15, 0)
const at = (hours: number, minutes: number, date = 8): string => new Date(2026, 9, date, hours, minutes).toISOString()
type Babysat = Pick<AgentThread, 'babysitting' | 'babysitEnded'>
const babysat = (startedBy: 'agent' | 'user', startedAt = at(14, 2)): Babysat => ({ babysitting: [{ url: URL, number: 74, startedBy, startedAt }] })
const ended = (reason: NonNullable<AgentThread['babysitEnded']>[number]['reason'], endedAt = at(16, 5)): Babysat => ({ babysitEnded: [{ url: URL, number: 74, reason, endedAt }] })
const line = (thread: Babysat, state: 'open' | 'closed' | 'merged' = 'open', offered = true) =>
  babysitLine({ thread, pullRequest: { url: URL, number: 74, state }, agent: 'Claude Code', offered, now: NOW })

describe('the line docked above Merge', () => {
  it('says since when, who started it and what Sotto does, with Stop named for the pull request', () => {
    expect(line(babysat('agent'))).toEqual({ kind: 'babysitting', title: 'Babysitting since 2:02 pm',
      detail: 'Started by Claude Code. Sotto sends this thread a wake-up when #74 needs it.', stop: 'Stop babysitting #74' })
    expect(line(babysat('user'))).toMatchObject({ detail: 'Started by you. Sotto sends this thread a wake-up when #74 needs it.' })
    // Started on another day, the day is said too.
    expect(line(babysat('user', at(9, 30, 7)))).toMatchObject({ title: 'Babysitting since Oct 7, 9:30 am' })
  })

  it('says babysitting ended and why, and where to start it again on an open pull request', () => {
    expect(line(ended('unreadable', at(14, 48)))).toEqual({ kind: 'ended', title: 'Not babysitting',
      detail: 'Ended at 2:48 pm. Sotto could not read #74 from GitHub for about 16 minutes. Babysit pull request is in the ··· menu.' })
    // Where the host cannot babysit, the menu has no such item, so the line does not send the reader there.
    expect(line(ended('comment-limit', at(17, 19)), 'open', false)).toEqual({ kind: 'ended', title: 'Not babysitting',
      detail: 'Ended at 5:19 pm, after ten wake-ups in a row brought only comments.' })
    expect(line(ended('merged'), 'merged')).toEqual({ kind: 'ended', title: 'Babysitting ended', detail: 'Ended when #74 merged at 4:05 pm.' })
  })

  it('says each ending in its own words, with the day when it was not today', () => {
    const words = (reason: Parameters<typeof ended>[0], endedAt = at(14, 40)) => endedWords({ number: 74, reason, endedAt }, NOW)
    expect(words('merged')).toBe('Ended when #74 merged at 2:40 pm.')
    expect(words('closed', at(9, 5, 6))).toBe('Ended when #74 was closed on Oct 6 at 9:05 am.')
    expect(words('switched-off')).toBe('Ended at 2:40 pm, when Let agents babysit pull requests was turned off in Settings.')
  })

  it('says nothing about a pull request nobody babysat, and prefers babysitting now to an older ending', () => {
    expect(line({})).toBeNull()
    expect(line({ ...babysat('user'), ...ended('merged') })).toMatchObject({ kind: 'babysitting' })
    expect(babysitEndedOf({ ...babysat('user'), ...ended('merged') }, URL)).toBeUndefined()
  })

  it('matches a pull request by its address, whatever its case or what follows the number', () => {
    expect(pullRequestKeyOf('https://github.com/O/R/pull/74/files')).toBe('o/r#74')
    expect(babysittingOf(babysat('user'), 'https://github.com/O/r/pull/74')).toBeDefined()
    expect(babysittingOf(babysat('user'), 'https://github.com/o/r/pull/7')).toBeUndefined()
  })
})

describe('where Babysit pull request is offered', () => {
  const thread = (hostId: string, remoteHost?: boolean) => ({ hostId, ...(remoteHost === undefined ? {} : { remoteHost }) })
  it('offers it on a host that lists the feature, this computer included, and nowhere else', () => {
    const hosts = [{ hostId: 'local', pullRequestBabysit: true as const }, { hostId: 'old-remote' }]
    expect(offersBabysitting(hosts, thread('local'))).toBe(true)
    expect(offersBabysitting(hosts, thread('old-remote', true))).toBe(false)
    // A window shown no host list is this computer's own; a paired host it cannot see is not offered it.
    expect(offersBabysitting(undefined, thread('local'))).toBe(true)
    expect(offersBabysitting(undefined, thread('remote', true))).toBe(false)
  })
})

describe('the words around it', () => {
  it('names pull requests the way a reader says them, and a moment as a time or a day and time', () => {
    expect(pullRequestNumbers([74])).toBe('#74')
    expect(pullRequestNumbers([74, 76])).toBe('#74 and #76')
    expect(pullRequestNumbers([74, 76, 78])).toBe('#74, #76 and #78')
    expect(babysitClock(at(14, 2), NOW)).toBe('2:02 pm')
    expect(babysitClock('not a time', NOW)).toBe('')
  })
})
