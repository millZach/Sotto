// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const controls: AgentControl[] = []

const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => false,
  encryptString: value => Buffer.from(value),
  decryptString: value => value.toString(),
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-persistence-'))
  roots.push(root)
  const credentials = new AgentCredentials(root, encryption)
  await credentials.load()
  const host = new E2EAgentHost()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: {
      status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
    } })
  controls.push(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return { root, host, control }
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('coordinator persistence', () => {
  function agentsWriteSpy() {
    const realWrite = AtomicJsonStore.prototype.write
    const spy = vi.spyOn(AtomicJsonStore.prototype, 'write')
    const isAgents = (instance: unknown) => String((instance as { filePath?: string }).filePath).endsWith('agents.json')
    return {
      spy, realWrite, isAgents,
      count: () => spy.mock.contexts.filter(isAgents).length,
    }
  }
  async function settle(writes: ReturnType<typeof agentsWriteSpy>) {
    // Each persist reaches the spy synchronously; the writes it counted still
    // complete on the store's serialized queue, so wait on their own promises.
    const agentsWrites = writes.spy.mock.results
      .filter((result, index) => result.type === 'return' && writes.isAgents(writes.spy.mock.contexts[index]))
      .map(result => result.value as Promise<unknown>)
    await Promise.allSettled(agentsWrites)
    // A persist chained behind a resolved write still has to be called.
    await new Promise(resolve => setImmediate(resolve))
  }

  it('does not rewrite agents.json for a provider frame that changed no saved fact', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    const file = join(f.root, 'agents.json')
    f.host.event({ type: 'manual', threadId: 'workshop', text: 'Describe the workspace.' })
    await settle(writes)
    const before = JSON.parse(await readFile(file, 'utf8')) as unknown
    const writesBeforeStream = writes.count()
    for (let frame = 0; frame < 50; frame += 1) {
      f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'reply', text: 'word '.repeat(frame + 1), status: 'running' })
    }
    await settle(writes)
    expect(writes.count()).toBe(writesBeforeStream)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(before)
  })

  it('writes once when a saved fact changes and not again for an identical one', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    await settle(writes)
    const file = join(f.root, 'agents.json')
    const beforeConfigure = writes.count()
    await f.control.command({ type: 'configure', patch: { orbColor: 'amber' } })
    expect(writes.count()).toBe(beforeConfigure + 1)
    await vi.waitFor(async () => {
      expect((JSON.parse(await readFile(file, 'utf8')) as { configuration: { orbColor: string } }).configuration.orbColor).toBe('amber')
    })
    await f.control.command({ type: 'configure', patch: { orbColor: 'amber' } })
    await settle(writes)
    expect(writes.count()).toBe(beforeConfigure + 1)
  })

  it('writes again after a failed write instead of remembering the failed content', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    await settle(writes)
    let failedOnce = false
    const real = writes.realWrite
    writes.spy.mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (!failedOnce && writes.isAgents(this)) {
        failedOnce = true
        return Promise.reject(new Error('disk'))
      }
      return real.call(this, value as never)
    })
    const failed = await f.control.command({ type: 'configure', patch: { orbColor: 'violet' } })
    expect(failed.error).toBe('Could not save agent state. Pause management until storage is available.')
    const beforeRetry = writes.count()
    const retried = await f.control.command({ type: 'configure', patch: { orbColor: 'violet' } })
    expect(retried.error).toBeNull()
    expect(writes.count()).toBe(beforeRetry + 1)
    const file = join(f.root, 'agents.json')
    await vi.waitFor(async () => {
      expect((JSON.parse(await readFile(file, 'utf8')) as { configuration: { orbColor: string } }).configuration.orbColor).toBe('violet')
    })
  })
  it('keeps the newest save when it returns to the last completed state', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    await settle(writes)
    const initial = f.control.get().configuration.speak
    let started!: () => void
    const writing = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let blocked = false
    // Hold the physical write inside the real queue, so later writes retain their ordering.
    const prototype = AtomicJsonStore.prototype as unknown as { writeImmediately(value: unknown): Promise<void> }
    const realImmediate = prototype.writeImmediately
    vi.spyOn(prototype, 'writeImmediately').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
      if (!blocked && writes.isAgents(this)) {
        blocked = true
        started()
        return held.then(() => realImmediate.call(this, value))
      }
      return realImmediate.call(this, value)
    })
    const older = f.control.command({ type: 'configure', patch: { speak: !initial } })
    await writing
    let newerFinished = false
    const newerCommand = f.control.command({ type: 'configure', patch: { speak: initial } })
      .then(result => { newerFinished = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    const finishedBeforeWrite = newerFinished
    release()
    const [, newer] = await Promise.all([older, newerCommand])
    await settle(writes)
    expect(finishedBeforeWrite).toBe(false)
    expect(newer.error).toBeNull()
    expect(f.control.get().configuration.speak).toBe(initial)
    expect((JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { configuration: { speak: boolean } }).configuration.speak).toBe(initial)
  })

})
