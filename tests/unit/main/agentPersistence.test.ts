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
  async function settle(count: () => number) {
    // Each persist reaches the spy synchronously; the writes it counted still
    // complete on the store's serialized queue, so wait out a quiet window.
    let last = -1
    for (let idle = 0; idle < 3; idle += 1) {
      if (count() === last) continue
      last = count()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it('does not rewrite agents.json for a provider frame that changed no saved fact', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    const file = join(f.root, 'agents.json')
    f.host.event({ type: 'manual', threadId: 'workshop', text: 'Describe the workspace.' })
    await settle(writes.count)
    const before = JSON.parse(await readFile(file, 'utf8')) as unknown
    const writesBeforeStream = writes.count()
    for (let frame = 0; frame < 50; frame += 1) {
      f.host.event({ type: 'stream', threadId: 'workshop', messageId: 'reply', text: 'word '.repeat(frame + 1), status: 'running' })
    }
    await settle(writes.count)
    expect(writes.count()).toBe(writesBeforeStream)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(before)
  })

  it('writes once when a saved fact changes and not again for an identical one', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    await settle(writes.count)
    const file = join(f.root, 'agents.json')
    const beforeConfigure = writes.count()
    await f.control.command({ type: 'configure', patch: { orbColor: 'amber' } })
    expect(writes.count()).toBe(beforeConfigure + 1)
    await vi.waitFor(async () => {
      expect((JSON.parse(await readFile(file, 'utf8')) as { configuration: { orbColor: string } }).configuration.orbColor).toBe('amber')
    })
    await f.control.command({ type: 'configure', patch: { orbColor: 'amber' } })
    await settle(writes.count)
    expect(writes.count()).toBe(beforeConfigure + 1)
  })

  it('writes again after a failed write instead of remembering the failed content', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    await settle(writes.count)
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
})
