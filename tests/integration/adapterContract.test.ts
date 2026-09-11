// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { codexFixture, type RecordedRpc } from '../fixtures/codexFixture'
import { describeAdapterContract, type AdapterFixture } from './adapterContract'

describeAdapterContract('Codex App Server', () => codexFixture(undefined, false, 200))
describeAdapterContract('Fake provider', async (): Promise<AdapterFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-contract-'))
  const host = new FakeProviderHost()
  // This fixture has no process transport or durable server; those checks run in Codex's fixture.
  const records: RecordedRpc[] = []
  const execute = host.execute.bind(host)
  host.execute = async command => {
    if (command.type === 'answer') records.push({ result: command.approved === undefined ? { answers: command.answer } : { decision: command.approved ? 'accept' : 'decline' } })
    return execute(command)
  }
  const get = (id: string) => host.state.threads.find(t => t.id === id)!
  return { root, host, connection: { endpoint: '', credential: '' }, projectId: 'contract-project', modelId: 'fake:model',
    skips: { uncertain: 'FakeProviderHost has no transport acknowledgement seam.', restart: 'FakeProviderHost has no persisted process state.' },
    driver: {
      typeInProvider: async (id, text) => { get(id).messages.push({ id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString() }); host.emit() },
      completeTurn: async (id, text) => { const thread = get(id); thread.status = 'idle'; thread.messages.push({ id: randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString() }); host.emit() },
      raiseQuestion: async (id, text) => { get(id).requests.push({ id: randomUUID(), kind: 'question', text, options: [] }); host.emit() },
      raisePermission: async (id, text) => { get(id).requests.push({ id: randomUUID(), kind: 'permission', text, options: [] }); host.emit() },
      delayNextAck: async () => { throw new Error('Unsupported fixture seam') }, requests: async () => records,
      restart: async () => { throw new Error('Unsupported fixture seam') },
    }, cleanup: async () => {
      host.disconnect()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-contract-')) throw new Error('Unexpected temporary test directory')
      await rm(root, { recursive: true, force: true })
    },
  }
})
