import { describe, expect, it } from 'vitest'
import { foldTeamDeskReads, TEAM_DESK_READS_FOLD_MS, type TeamDeskRead } from '../../../src/shared/teams'

const read = (id: string, linkId: string, teammate: string, minute: number): TeamDeskRead => ({ id, linkId, teammate, at: new Date(Date.parse('2026-11-05T10:00:00Z') + minute * 60_000).toISOString() })

describe('reads of this computer\'s desk under Latest (ADR-0193)', () => {
  it('folds one teammate\'s reads two minutes apart into one line, newest first', () => {
    const lines = foldTeamDeskReads([read('a', 'l1', 'Drake', 0), read('b', 'l1', 'Drake', 2), read('c', 'l1', 'Drake', 4), read('d', 'l1', 'Drake', 30)])
    expect(lines).toEqual([
      { id: 'd', teammate: 'Drake', first: read('d', 'l1', 'Drake', 30).at, at: read('d', 'l1', 'Drake', 30).at, count: 1 },
      { id: 'a', teammate: 'Drake', first: read('a', 'l1', 'Drake', 0).at, at: read('c', 'l1', 'Drake', 4).at, count: 3 },
    ])
  })
  it('keeps two teammates apart, and splits at the fold\'s length', () => {
    const minutes = TEAM_DESK_READS_FOLD_MS / 60_000
    const lines = foldTeamDeskReads([read('a', 'l1', 'Drake', 0), read('b', 'l2', 'Rohit', 1), read('c', 'l1', 'Drake', minutes)])
    expect(lines.map(line => [line.teammate, line.count])).toEqual([['Drake', 1], ['Rohit', 1], ['Drake', 1]])
  })
})
