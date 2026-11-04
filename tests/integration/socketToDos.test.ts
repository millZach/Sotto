// @vitest-environment node
// ADR-0188: a host sends its own to-do list to a desktop or a phone that asks, and a press on it comes back to that host.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { ToDoStore } from '../../src/main/agents/toDos'
import type { ToDo } from '../../src/shared/toDos'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })

async function keepingHost(keeps = true) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-socket-to-dos-'))
  folders.push(directory)
  const told = vi.fn(async () => undefined)
  const store = new ToDoStore({ directory, historyEnabled: () => false, told })
  const base = fixture.host.service
  const service: HostService = {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener),
    threadProvider: threadId => base.shell().host.threads.find(thread => thread.id === threadId)?.providerId,
    ...keeps ? { supportsToDos: true, toDos: () => store.view(), subscribeToDos: (listener: () => void) => store.subscribe(listener), toDoRequest: (request: Parameters<ToDoStore['request']>[0]) => store.request(request) } : {},
  }
  return { store, told, service }
}
const pushes = (messages: readonly Record<string, unknown>[]) => messages.filter(message => message.event === 'to-dos').map(message => message.items as ToDo[])
const paired = async (port: number, name: string) => {
  const client = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, name)
  return rawPeer(port, fixture.host.pairing.signSession(client.clientId))
}

describe('a host’s to-do list (ADR-0188)', () => {
  it('pushes the list after a client’s hello and on each change, and takes a press back', async () => {
    const { store, told, service } = await keepingHost()
    await store.add({ title: 'Hand test links', waits: true }, 'thread', 't-hidden')
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const phone = await paired(server.descriptor.port, 'Duo')
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['to-dos'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('to-dos')
      await expect.poll(() => pushes(phone.messages).length).toBe(1)
      const item = pushes(phone.messages)[0]![0]!
      expect(item).toMatchObject({ title: 'Hand test links', waits: true, seen: false })
      // Seen on one client is seen on all of them, because it is one fact on the host.
      await phone.call('seen', { op: 'to-do-request', request: { kind: 'seen' } })
      await expect.poll(() => pushes(phone.messages).at(-1)?.[0]?.seen).toBe(true)
      await phone.call('add', { op: 'to-do-request', request: { kind: 'add', title: 'Call the supplier' } })
      await expect.poll(() => pushes(phone.messages).at(-1)?.length).toBe(2)
      await phone.call('check', { op: 'to-do-request', request: { kind: 'check', id: item.id, didNotWork: 'Opened in Sotto both times' } })
      await expect.poll(() => pushes(phone.messages).at(-1)?.map(entry => entry.title)).toEqual(['Call the supplier'])
      expect(told).toHaveBeenCalledExactlyOnceWith('t-hidden', 'Hand test links', 'Opened in Sotto both times')
    } finally { phone.frames.close(); await server.close() }
  })

  it('names no thread to a client that is not sent it, and keeps the item', async () => {
    const { store, service } = await keepingHost()
    await store.add({ title: 'Listen' }, 'thread', 'not-on-this-host')
    const server = await startSocketServer({ service: { ...service, threadProvider: () => 'opencode' }, pairing: fixture.host.pairing })
    const phone = await paired(server.descriptor.port, 'Old phone')
    try {
      await phone.call('hello', { op: 'hello', accepts: ['to-dos'] })
      await expect.poll(() => pushes(phone.messages).length).toBe(1)
      expect(pushes(phone.messages)[0]![0]).toMatchObject({ title: 'Listen' })
      expect(pushes(phone.messages)[0]![0]).not.toHaveProperty('threadId')
    } finally { phone.frames.close(); await server.close() }
  })

  it('pushes nothing to a client that did not ask, and refuses its press', async () => {
    const { store, service } = await keepingHost()
    await store.add({ title: 'Listen' }, 'thread', 't1')
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const phone = await paired(server.descriptor.port, 'Old phone')
    try {
      await phone.call('hello', { op: 'hello' })
      await phone.call('press', { op: 'to-do-request', request: { kind: 'seen' } }).catch(() => undefined)
      await store.add({ title: 'Another' }, 'thread', 't1')
      await store.drain()
      expect(pushes(phone.messages)).toEqual([])
      expect(store.view().every(item => !item.seen)).toBe(true)
    } finally { phone.frames.close(); await server.close() }
  })

  it('is not offered where the host’s Owl answer leaves it off', async () => {
    const { service } = await keepingHost(false)
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const phone = await paired(server.descriptor.port, 'Duo')
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['to-dos'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('to-dos')
      expect(pushes(phone.messages)).toEqual([])
    } finally { phone.frames.close(); await server.close() }
  })
})
