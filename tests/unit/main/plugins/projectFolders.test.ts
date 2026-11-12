// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginFolderId, pluginFolderOfThread, pluginProjects } from '../../../../src/main/plugins/projectFolders'
import { pluginAccountAdmits } from '../../../../src/shared/plugins'

/** Made-up folders: two providers work in the first, as Claude Code and Codex do in one checkout. */
const SOTTO = join('/work', 'sotto'), SITE = join('/work', 'site')
const projects = [
  { id: 'claude-project-sotto', title: 'Sotto', path: SOTTO },
  { id: 'codex-project-sotto', title: 'Sotto', path: `${SOTTO}/` },
  { id: 'codex-project-site', title: 'Lumen shop', path: SITE },
]
const threads = [
  { id: 'claude-thread', projectId: 'claude-project-sotto' },
  { id: 'codex-thread', projectId: 'codex-project-sotto' },
  { id: 'site-thread', projectId: 'codex-project-site' },
  { id: 'watcher-thread', projectId: 'claude-project-sotto', kind: 'watcher' },
  { id: 'history-thread', projectId: 'claude-project-sotto', kind: 'watcher-history' },
  { id: 'lost-thread', projectId: 'a-project-that-is-gone' },
]

describe('a project, for a plugin account, is its folder (ADR-0205, decision 9)', () => {
  it('offers a folder two providers work in once, and never hands over where it is', () => {
    const offered = pluginProjects(projects)
    expect(offered.map(project => project.title)).toEqual(['Sotto', 'Lumen shop'])
    expect(offered.map(project => project.id)).toEqual([pluginFolderId(SOTTO), pluginFolderId(SITE)])
    expect(JSON.stringify(offered)).not.toContain('work')
    expect(offered.every(project => /^folder:[0-9a-f]{32}$/u.test(project.id))).toBe(true)
  })

  it('lets an account kept to a folder be used by that folder’s threads on every provider, and by no other thread', () => {
    const host = { threads, projects }
    // The user presses the one Sotto chip: the account is kept to that folder.
    const account = { on: true, projects: [pluginProjects(projects)[0]!.id] }
    const admitted = (threadId: string): boolean => pluginAccountAdmits(account, pluginFolderOfThread(host, threadId))
    expect(admitted('claude-thread')).toBe(true)
    // Before the fix this was refused: Codex's project in the same folder has an ID of its own.
    expect(admitted('codex-thread')).toBe(true)
    expect(admitted('site-thread')).toBe(false)
    // Watcher's threads are in no project, whatever project they are held under, and neither is a thread Sotto cannot place.
    for (const outside of ['watcher-thread', 'history-thread', 'lost-thread', 'no-such-thread']) {
      expect(pluginFolderOfThread(host, outside), outside).toBeNull()
      expect(admitted(outside), outside).toBe(false)
    }
  })

  it('tells two ways of writing one folder to be the same, and calls a folder settled only while every project in it is', () => {
    expect(pluginFolderId(`${SOTTO}/`)).toBe(pluginFolderId(SOTTO))
    expect(pluginFolderId(join(SOTTO, '..', 'sotto'))).toBe(pluginFolderId(SOTTO))
    if (process.platform === 'win32') expect(pluginFolderId(SOTTO.toUpperCase())).toBe(pluginFolderId(SOTTO))
    expect(pluginFolderId(SITE)).not.toBe(pluginFolderId(SOTTO))
    const settled = '2026-11-12T08:00:00.000Z'
    expect(pluginProjects([{ ...projects[0]!, workspaceSettledAt: settled }, projects[1]!])[0]!.settled).toBe(false)
    expect(pluginProjects([{ ...projects[0]!, workspaceSettledAt: settled }, { ...projects[1]!, workspaceSettledAt: settled }])[0]!.settled).toBe(true)
    expect(pluginProjects([])).toEqual([])
  })
})
