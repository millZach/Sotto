// @vitest-environment node
/**
 * The workspace's activity publication copies only the threads that changed since the last one (#1326). Every thread
 * record it hands out is frozen and owned, a thread that has not changed is the very record the last publication
 * carried, and what each publication says is exactly what a fresh copy of the workspace's state says.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import { CertifyingProviderHost } from '../../fixtures/certifyingProviderHost'
import { testCredentials } from '../../fixtures/testCredentials'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/**
 * What the workspace holds, reached the way only a test does, to change a record in place as its own code can. Its own
 * code marks every thread it changes (`touch`, #925), so the next publication reads that thread again; so does this.
 */
interface Internals { state: { snapshot: AgentHostSnapshot }; invalidEventThreads: Set<string>; touch(id: string): void }

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-publication-sharing-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))
  const provider = new CertifyingProviderHost()
  const host = new WorkspaceHost(provider, root)
  cleanup.push(async () => { host.dispose() })
  await host.initialize()
  const published: AgentHostSnapshot[] = []
  const off = host.subscribeActivitySnapshots(snapshot => published.push(snapshot))
  cleanup.push(async () => { off() })
  await host.connect()
  const internals = host as unknown as Internals
  /** Publishes the provider's state and answers with the publication it caused. */
  const publish = async (): Promise<AgentHostSnapshot> => {
    const before = published.length
    provider.emit()
    await expect.poll(() => published.length).toBeGreaterThan(before)
    return published.at(-1)!
  }
  return { root, provider, host, internals, publish }
}

const thread = (snapshot: AgentHostSnapshot, id: string): AgentThread => snapshot.threads.find(item => item.id === id)!

/** What each publication says is what a fresh, writable copy of the same state says, key for key and in the same order. */
function expectSameAsFreshCopy(published: AgentHostSnapshot, host: WorkspaceHost): void {
  const fresh = host.workspaceSnapshot()
  expect(published).toStrictEqual(fresh)
  expect(JSON.stringify(published)).toBe(JSON.stringify(fresh))
}

it('shares a thread that did not change and copies the one that did, saying what a fresh copy says', async () => {
  const { provider, host, publish } = await workspace()
  const first = await publish()
  expectSameAsFreshCopy(first, host)
  for (const record of first.threads) expect(Object.isFrozen(record)).toBe(true)
  provider.state.threads.find(item => item.id === 'session-workshop')!.title = 'Workshop renamed'
  const second = await publish()
  expectSameAsFreshCopy(second, host)
  expect(thread(second, 'session-workshop').title).toBe('Workshop renamed')
  expect(thread(second, 'session-workshop')).not.toBe(thread(first, 'session-workshop'))
  expect(thread(first, 'session-workshop').title).toBe('Workshop')
  expect(thread(second, 'session-docs')).toBe(thread(first, 'session-docs'))
  expect(second.projects).toBe(first.projects)
  // The snapshot around the threads is each publication's own.
  expect(second).not.toBe(first)
  expect(second.threads).not.toBe(first.threads)
  expect(() => { (thread(second, 'session-docs') as { title: string }).title = 'Written' }).toThrow(TypeError)
  const third = await publish()
  expect(thread(third, 'session-workshop')).toBe(thread(second, 'session-workshop'))
})

it('sees a change the workspace made inside a record in place, as recording the sent branch does', async () => {
  const { host, internals, publish } = await workspace()
  const own = internals.state.snapshot.threads.find(item => item.id === 'session-docs')!
  own.worktree = { mode: 'independent', status: 'ready', path: 'C:/worktree', branch: 'sotto/one' } as NonNullable<AgentThread['worktree']>
  internals.touch('session-docs')
  const first = await publish()
  expectSameAsFreshCopy(first, host)
  expect(thread(first, 'session-docs').worktree?.sentBranch).toBeUndefined()
  // The accept carries the record's worktree over, so this is the object the workspace still holds.
  const held = internals.state.snapshot.threads.find(item => item.id === 'session-docs')!.worktree!
  held.sentBranch = held.branch
  internals.touch('session-docs')
  const second = await publish()
  expectSameAsFreshCopy(second, host)
  expect(thread(second, 'session-docs').worktree?.sentBranch).toBe('sotto/one')
  expect(thread(first, 'session-docs').worktree?.sentBranch).toBeUndefined()
  expect(thread(second, 'session-workshop')).toBe(thread(first, 'session-workshop'))
})

it('carries a history notice on the publication only, and drops it when the history is saved again', async () => {
  const { host, internals, publish } = await workspace()
  const first = await publish()
  internals.invalidEventThreads.add('session-docs')
  internals.touch('session-docs')
  const noticed = await publish()
  expectSameAsFreshCopy(noticed, host)
  expect(thread(noticed, 'session-docs').historySaveNotice).toMatch(/could not be saved/u)
  expect(internals.state.snapshot.threads.find(item => item.id === 'session-docs')!.historySaveNotice).toBeUndefined()
  expect(thread(noticed, 'session-workshop')).toBe(thread(first, 'session-workshop'))
  internals.invalidEventThreads.delete('session-docs')
  internals.touch('session-docs')
  const cleared = await publish()
  expectSameAsFreshCopy(cleared, host)
  expect(thread(cleared, 'session-docs').historySaveNotice).toBeUndefined()
})

it('gives the coordinator the shared records, and the shell it publishes says the same as before', async () => {
  const { root, provider, host, publish } = await workspace()
  const control = new AgentControl({ directory: root, host, credentials: await testCredentials(root, { mode: 'unavailable' }), reasoner: e2eAgentReasoner })
  cleanup.push(async () => { control.dispose() })
  await control.start()
  await control.command({ type: 'connect' })
  const first = await publish()
  await expect.poll(() => control.watcherSnapshot().threads.find(item => item.id === 'session-docs')).toBe(thread(first, 'session-docs'))
  provider.state.threads.find(item => item.id === 'session-workshop')!.title = 'Workshop renamed'
  await publish()
  await expect.poll(() => control.shell().host.threads.find(item => item.id === 'session-workshop')?.title).toBe('Workshop renamed')
  const shell = control.shell()
  const fresh = host.workspaceSnapshot()
  // Every field the shell carries from the workspace says what a fresh copy of the workspace says. The coordinator
  // empties the messages and adds its own fields, which a fresh copy does not have.
  expect(shell.host.threads.map(shown => shown.id).sort()).toEqual(fresh.threads.map(item => item.id).sort())
  for (const item of fresh.threads) {
    const shown = shell.host.threads.find(candidate => candidate.id === item.id)! as unknown as Record<string, unknown>
    const shared = Object.keys(item).filter(key => key !== 'messages' && key in shown)
    expect(shared.length).toBeGreaterThan(5)
    for (const key of shared) expect(shown[key], `${item.id}.${key}`).toEqual((item as unknown as Record<string, unknown>)[key])
  }
  // `shell()` stays its caller's to change.
  shell.host.threads[0]!.title = 'Changed by the caller'
  expect(control.shell().host.threads[0]!.title).not.toBe('Changed by the caller')
})
