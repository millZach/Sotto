// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inactiveLocalHost, requireLocalHistoryCleanup } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'

it('leaves saved workspace data intact and constructs no provider or thread store when local hosting is off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-local-off-'))
  try {
    const saved = '{"existing":"workspace"}'
    await writeFile(join(directory, 'workspace.json'), saved)
    const runtime = await inactiveLocalHost(directory)
    expect(runtime.agentControl.shell().host.threads).toEqual([])
    expect(runtime.threadRegistry).toBeNull()
    await expect(runtime.hostService.command({ type: 'connect' }, desktopWindowClient())).rejects.toThrow('local host is off')
    expect(() => runtime.agentHost.workingCopyOptions('project')).toThrow('local host is off')
    expect(() => { runtime.worktreeCleanup.start(); runtime.worktreeCleanup.settingsChanged() }).not.toThrow()
    await expect(runtime.worktreeCleanup.close()).resolves.toBeUndefined()
    await runtime.close()
    expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(saved)
    expect((await readdir(directory)).sort()).toEqual(['host.json', 'workspace.json'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})


it('refuses turning history off until the local cleanup can run, without blocking unrelated changes', () => {
  expect(() => requireLocalHistoryCleanup(false, true, false)).toThrow('Your saved history has not changed')
  expect(() => requireLocalHistoryCleanup(false, true, undefined)).not.toThrow()
  expect(() => requireLocalHistoryCleanup(false, false, false)).not.toThrow()
  expect(() => requireLocalHistoryCleanup(true, true, false)).not.toThrow()
})
