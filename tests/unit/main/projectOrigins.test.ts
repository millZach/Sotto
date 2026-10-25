// @vitest-environment node
// #1032: the GitHub repository each project's origin remote names, as a machine reports it for placing work.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { readGitHubOrigin, readProjectOrigins } from '../../../src/main/agents/projectOrigins'
import type { RunGitCommand } from '../../../src/main/agents/gitStatus'

const origins: Record<string, string> = {
  '/work/sotto': 'git@github.com:millZach/Sotto.git\n',
  '/work/sotto-https': 'https://github.com/millZach/Sotto\n',
  '/work/gitlab': 'https://gitlab.com/someone/thing.git\n',
}
const asked: string[] = []
const run: RunGitCommand = async (cwd, command, args) => {
  asked.push(cwd)
  expect(command).toBe('git'); expect(args).toEqual(['config', '--get', 'remote.origin.url'])
  const url = origins[cwd]
  if (url === undefined) throw new Error('exit 1')
  return url
}

describe('project origins', () => {
  it('names each project’s GitHub repository by host, owner and name, the same over SSH and HTTPS, and null otherwise', async () => {
    asked.length = 0
    const read = await readProjectOrigins([{ id: 'a', path: '/work/sotto' }, { id: 'b', path: '/work/sotto-https' }, { id: 'c', path: '/work/gitlab' },
      { id: 'd', path: '/work/no-origin' }, { id: 'e', path: '/work/sotto' }, { id: 'f', path: '' }], run)
    expect(read).toEqual({ projects: [
      { projectId: 'a', repository: { host: 'github.com', owner: 'millZach', name: 'Sotto' } },
      { projectId: 'b', repository: { host: 'github.com', owner: 'millZach', name: 'Sotto' } },
      { projectId: 'c', repository: null }, { projectId: 'd', repository: null },
      { projectId: 'e', repository: { host: 'github.com', owner: 'millZach', name: 'Sotto' } }, { projectId: 'f', repository: null }] })
    // A folder two projects share is read once, and a project without a folder is never read where Sotto runs.
    expect(asked.sort()).toEqual(['/work/gitlab', '/work/no-origin', '/work/sotto', '/work/sotto-https'])
  })
  it('reads a real repository’s origin without asking the network', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'sotto-origin-'))
    try {
      const git = promisify(execFile)
      await git('git', ['init', '-q', folder])
      expect(await readGitHubOrigin(folder)).toBeNull()
      await git('git', ['-C', folder, 'remote', 'add', 'origin', 'https://github.com/millZach/Sotto.git'])
      expect(await readGitHubOrigin(folder)).toEqual({ host: 'github.com', owner: 'millZach', name: 'Sotto' })
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
})
