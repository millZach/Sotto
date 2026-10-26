// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { inTheWay } from '../../../src/main/agents/gitActions'
import { repositoryOf, trackedChanges } from '../../../src/main/agents/mainCheckout'

describe('Keep main up to date reads Git and GitHub in their own words (ADR-0142)', () => {
  it('finds the repository of a remote URL or a pull request, whatever form it takes', () => {
    for (const url of ['https://github.com/millZach/Sotto.git', 'https://github.com/millZach/Sotto', 'git@github.com:millZach/Sotto.git', 'ssh://git@github.com/millZach/Sotto.git',
      'https://github.com/millzach/sotto/pull/1406', 'https://github.com/millZach/Sotto/pull/1406/files']) expect(repositoryOf(url)).toBe('github.com/millzach/sotto')
    expect(repositoryOf('D:/Talk to Text Application')).toBeNull()
    // A same-named repository on another host is another repository, so its merge checks nothing here.
    expect(repositoryOf('git@gitlab.com:millZach/Sotto.git')).toBe('gitlab.com/millzach/sotto')
    expect(repositoryOf('https://github.example.com/millZach/Sotto/pull/12')).not.toBe(repositoryOf('https://github.com/millZach/Sotto.git'))
  })

  it('names the files a refused fast-forward would have overwritten', () => {
    expect(inTheWay('error: The following untracked working tree files would be overwritten by merge:\n\tincoming.txt\n\tdocs/new.md\nPlease move or remove them before you merge.\nAborting'))
      .toEqual({ reason: 'untracked', files: ['incoming.txt', 'docs/new.md'] })
    expect(inTheWay('error: Your local changes to the following files would be overwritten by merge:\r\n\ttracked.txt\r\nPlease commit your changes or stash them before you merge.'))
      .toEqual({ reason: 'changes', files: ['tracked.txt'] })
    expect(inTheWay('fatal: Not possible to fast-forward, aborting.')).toBeNull()
  })

  it('lists tracked changes for Show changes, with a rename\'s new name and conflicts said as such', () => {
    expect(trackedChanges(' M src/a.ts\0D  old.md\0R  new.md\0was.md\0UU both.ts\0A  added.ts\0')).toEqual([
      { kind: 'modified', text: 'src/a.ts' }, { kind: 'deleted', text: 'old.md' }, { kind: 'renamed', text: 'new.md' }, { kind: 'conflict', text: 'both.ts' }, { kind: 'added', text: 'added.ts' }])
  })
})
