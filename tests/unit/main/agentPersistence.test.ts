// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials, type CredentialEncryption } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { commandCenterRecordFixture } from '../../fixtures/commandCenter'
import { emptyCommandCenterRecord } from '../../../src/shared/commandCenter'

const roots: string[] = []
const controls: AgentControl[] = []

const encryption: CredentialEncryption = {
  isEncryptionAvailable: () => false,
  encryptString: value => Buffer.from(value),
  decryptString: value => value.toString(),
}

async function fixture(historyEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-persistence-'))
  roots.push(root)
  const credentials = new AgentCredentials(root, encryption)
  await credentials.load()
  const host = new E2EAgentHost()
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, historyEnabled: () => historyEnabled,
  })
  controls.push(control)
  await control.start()
  if (!control.get().host.connected) await control.command({ type: 'connect' })
  return { root, host, control, credentials }
}

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('coordinator persistence', () => {
  it('migrates an older agents store without adopting a thread named Command center or old management', async () => {
    const f = await fixture()
    f.control.dispose(); await f.control.closed()
    const path = join(f.root, 'agents.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    delete saved.commandCenter
    saved.assignments = [{ threadId: 'workshop', instruction: 'Retired words', mode: 'managed' }]
    await writeFile(path, JSON.stringify(saved), 'utf8')
    const reopened = new AgentControl({ directory: f.root, host: f.host, credentials: f.credentials, reasoner: e2eAgentReasoner })
    controls.push(reopened); await reopened.start(); reopened.dispose(); await reopened.closed()
    const migrated = JSON.parse(await readFile(path, 'utf8'))
    expect(migrated.commandCenter).toEqual(emptyCommandCenterRecord())
    expect(migrated).not.toHaveProperty('assignments')
    expect(migrated.configuration).toEqual(saved.configuration)
    expect((await readdir(f.root)).some(name => name.includes('.corrupt-'))).toBe(false)
  })

  it('retains text-free command-center uncertainty, budgets and ownership across history-off restarts', async () => {
    const f = await fixture(false)
    f.control.dispose(); await f.control.closed()
    const path = join(f.root, 'agents.json')
    const saved = JSON.parse(await readFile(path, 'utf8'))
    const record = commandCenterRecordFixture()
    saved.commandCenter = record
    await writeFile(path, JSON.stringify(saved), 'utf8')
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (let restart = 0; restart < 2; restart++) {
      const host = new E2EAgentHost()
      const reopened = new AgentControl({ directory: f.root, host, credentials: f.credentials, reasoner: e2eAgentReasoner, historyEnabled: () => false })
      controls.push(reopened); await reopened.start()
      host.event({ type: 'manual', threadId: 'workshop', text: 'DISTINCT_PRIVATE_COMMAND_CENTER_REQUEST' })
      host.event({ type: 'stream', threadId: 'workshop', messageId: 'private-reply', text: 'DISTINCT_PRIVATE_FILE_CONTENT', status: 'idle' })
      reopened.dispose(); await reopened.closed()
      expect(JSON.parse(await readFile(path, 'utf8')).commandCenter).toEqual(record)
      // No recovery writer may mistake a retained uncertain operation for new work.
      expect((await host.snapshot()).threads.flatMap(thread => thread.messages).filter(message => message.commandId)).toEqual([])
    }
    for (const name of await readdir(f.root)) {
      if (!name.endsWith('.json') && !name.includes('.tmp-') && !name.includes('.corrupt-')) continue
      const text = await readFile(join(f.root, name), 'utf8')
      expect(text).not.toContain('DISTINCT_PRIVATE_COMMAND_CENTER_REQUEST')
      expect(text).not.toContain('DISTINCT_PRIVATE_FILE_CONTENT')
    }
    expect(warnings.mock.calls.flat().join(' ')).not.toContain('DISTINCT_PRIVATE')
  })
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
    await f.control.command({ type: 'configure', patch: { projectsDirectory: 'D:/Projects' } })
    expect(writes.count()).toBe(beforeConfigure + 1)
    await vi.waitFor(async () => {
      expect((JSON.parse(await readFile(file, 'utf8')) as { configuration: { projectsDirectory: string } }).configuration.projectsDirectory).toBe('D:/Projects')
    })
    await f.control.command({ type: 'configure', patch: { projectsDirectory: 'D:/Projects' } })
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
    const failed = await f.control.command({ type: 'configure', patch: { projectsDirectory: 'D:/Other Projects' } })
    expect(failed.error).toBe('Could not save agent state. Your drafts are kept in this session. Restore access to local storage and retry.')
    const beforeRetry = writes.count()
    const retried = await f.control.command({ type: 'configure', patch: { projectsDirectory: 'D:/Other Projects' } })
    expect(retried.error).toBeNull()
    expect(writes.count()).toBe(beforeRetry + 1)
    const file = join(f.root, 'agents.json')
    await vi.waitFor(async () => {
      expect((JSON.parse(await readFile(file, 'utf8')) as { configuration: { projectsDirectory: string } }).configuration.projectsDirectory).toBe('D:/Other Projects')
    })
  })
  it('keeps the newest save when it returns to the last completed state', async () => {
    const f = await fixture()
    const writes = agentsWriteSpy()
    await settle(writes)
    const initial = f.control.get().configuration.checkClientUpdates
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
    const older = f.control.command({ type: 'configure', patch: { checkClientUpdates: !initial } })
    await writing
    let newerFinished = false
    const newerCommand = f.control.command({ type: 'configure', patch: { checkClientUpdates: initial } })
      .then(result => { newerFinished = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    const finishedBeforeWrite = newerFinished
    release()
    const [, newer] = await Promise.all([older, newerCommand])
    await settle(writes)
    expect(finishedBeforeWrite).toBe(false)
    expect(newer.error).toBeNull()
    expect(f.control.get().configuration.checkClientUpdates).toBe(initial)
    expect((JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { configuration: { checkClientUpdates: boolean } }).configuration.checkClientUpdates).toBe(initial)
  })
})
