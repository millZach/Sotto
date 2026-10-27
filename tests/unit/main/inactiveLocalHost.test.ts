// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inactiveLocalHost, requireLocalHistoryCleanup } from '../../../src/main/hosts/inactiveLocalHost'
import { emptyWatcherRecord } from '../../../src/shared/watcher'
import { randomUUID } from 'node:crypto'
import { RequestDraftService } from '../../../src/main/agents/requestDrafts'
import { draft } from '../../fixtures/requestDrafts'
import { desktopWindowClient } from '../../../src/main/agents/hostService'

it('leaves saved workspace data intact and constructs no provider or thread store when local hosting is off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-local-off-'))
  try {
    const saved = '{"existing":"workspace"}'
    await writeFile(join(directory, 'workspace.json'), saved)
    const runtime = await inactiveLocalHost(directory)
    expect(runtime.agentControl.shell().host.threads).toEqual([])
    // Main reads this computer's host ID at start and for every held answer, so it must not refuse.
    expect(runtime.agentControl.hostId()).toBe(runtime.agentControl.shell().hostId)
    expect(runtime.agentControl.hostId()).toMatch(/^[0-9a-f-]{36}$/u)
    expect(runtime.threadRegistry).toBeNull()
    await expect(runtime.hostService.command({ type: 'connect' }, desktopWindowClient())).rejects.toThrow('local host is off')
    expect(() => runtime.agentHost.workingCopyOptions('project')).toThrow('local host is off')
    expect(() => { runtime.worktreeCleanup.start(); runtime.worktreeCleanup.settingsChanged() }).not.toThrow()
    // Main wires Git actions to the local host at start, so these two must not refuse, or Sotto quits on launch.
    expect(() => runtime.agentHost.setMutationGuard(() => true)).not.toThrow()
    // Main offers the host setup's tools and requests whichever host runs; with none here, they do nothing (ADR-0035).
    expect(() => runtime.agentHost.useThreadTools([{ name: 'sotto_host_setup', definitions: [], mcpServer: async () => undefined }])).not.toThrow()
    expect(() => runtime.agentControl.useSottoRequests({ requests: () => new Map(), answer: () => undefined, subscribe: () => () => undefined })).not.toThrow()
    // Main listens for deleted threads at start to drop their answer drafts (ADR-0140).
    expect(() => runtime.agentControl.onThreadsDeleted(() => undefined)()).not.toThrow()
    await expect(runtime.agentHost.gitActionFinished('thread')).resolves.toBeUndefined()
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

it('keeps Watcher answer recovery copies while the local host is off', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-local-off-'))
  try {
    const watcher = emptyWatcherRecord()
    watcher.current = { target: { hostId: randomUUID(), threadId: 'watcher' }, projectId: 'project', provider: 'codex', creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
    const agents = JSON.stringify({ watcher })
    const workspace = JSON.stringify({ snapshot: { threads: [{ id: 'watcher-history', kind: 'watcher-history' }, { id: 'ordinary', kind: 'project' }] } })
    await writeFile(join(directory, 'agents.json'), agents)
    await writeFile(join(directory, 'workspace.json'), workspace)
    const parked = draft({ target: { ...draft().target, ownerId: 'watcher' }, held: true, decisionId: 'watcher-held' })
    const copy = join(directory, 'request-drafts.json.tmp-123-12345678-1234-1234-1234-123456789abc')
    await writeFile(copy, JSON.stringify({ version: 2, drafts: [parked], retirements: [] }))
    const runtime = await inactiveLocalHost(directory)
    expect(runtime.agentHost.watcherThreadIds!()).toEqual(['watcher', 'watcher-history'])
    const answers = new RequestDraftService(directory, () => undefined, async () => {}, undefined,
      owner => runtime.agentHost.watcherThreadIds!().includes(owner.ownerId))
    await answers.start()
    expect(JSON.parse(await readFile(copy, 'utf8'))).toEqual({ version: 2, drafts: [parked], retirements: [] })
    expect(await readFile(join(directory, 'agents.json'), 'utf8')).toBe(agents)
    expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(workspace)
    expect(runtime.agentControl.shell().host.threads).toEqual([])
    await runtime.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.each([false, true])('keeps answer copies untouched when inactive ownership metadata is unreadable (malformed: %s)', async malformed => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-local-off-'))
  try {
    await writeFile(join(directory, 'workspace.json'), '{"snapshot":')
    const copy = join(directory, 'request-drafts.json.tmp-123-12345678-1234-1234-1234-123456789abc')
    const saved = malformed ? '{"drafts":[{"target":{"ownerId":"watcher"}},' : JSON.stringify({ version: 2, drafts: [draft({ held: true })], retirements: [] })
    await writeFile(copy, saved)
    const runtime = await inactiveLocalHost(directory)
    const answers = new RequestDraftService(directory, () => undefined, async () => {}, undefined,
      owner => runtime.agentHost.watcherThreadIds!().includes(owner.ownerId))
    await answers.start()
    expect(await readFile(copy, 'utf8')).toBe(saved)
    await runtime.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
