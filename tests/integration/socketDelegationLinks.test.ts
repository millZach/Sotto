// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PairedClients } from '../../src/main/agents/pairing'
import type { HostService } from '../../src/main/agents/hostService'
import { startSocketServer } from '../../src/host/socketServer'
import { stateWithoutDelegation } from '../../src/shared/delegation'
import type { AgentState } from '../../src/shared/agents'
import { OPENCODE_EVERYWHERE, openCodeEverywhere } from '../fixtures/openCodeEverywhere'
import { rawPeer } from '../fixtures/rawHostPeer'

/**
 * A thread delegated while the Owl feature `thread-delegation` was on keeps `delegatedBy` in its record after a switch to
 * stable (ADR-0072). A host whose feature is off sends no client that link, so a stable phone does not hide the thread under
 * the thread that delegated to it; an Owl host sends it, and the record itself is never changed (#1279).
 */
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
const { codexThread, opencodeThread } = OPENCODE_EVERYWHERE

async function listen(delegation: boolean | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-delegation-links-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const pairing = new PairedClients(directory); await pairing.load()
  const state: AgentState = openCodeEverywhere()
  const listeners = new Set<(value: AgentState) => void>()
  const service = {
    shell: () => state, state: () => state, subscribe: (listener: (next: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    threadKind: () => 'project', events: () => [], threadDetail: (threadId: string) => ({ threadId, revision: 1, messages: [] }),
    command: async () => state,
  } as unknown as HostService
  const server = await startSocketServer({ service, pairing, admin: false, ...(delegation === undefined ? {} : { delegation }) })
  cleanup.push(() => server.close())
  const paired = await pairing.redeem(pairing.issuePairingCode().code, 'A phone')
  const peer = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId, Date.now()))
  cleanup.push(async () => peer.frames.close())
  // The peer knows OpenCode, so the fixture's link reaches it unless delegation keeps it back.
  const hello = await peer.call('hello', { op: 'hello', afterSeq: 0, accepts: ['provider-opencode'] })
  expect(hello).toMatchObject({ ok: true })
  const publish = () => { for (const listener of listeners) listener(state) }
  return { state, peer, hello, publish }
}

type Threads = { host: { threads: { id: string; delegatedBy?: string | undefined }[] } }
const linkOf = (shell: Threads) => shell.host.threads.find(thread => thread.id === codexThread)?.delegatedBy

for (const [name, delegation] of [['absent', undefined], ['off', false]] as const) {
  it(`sends no delegation link while thread-delegation is ${name}, and keeps the thread's record whole`, async () => {
    const { state, peer, hello, publish } = await listen(delegation)
    const sent = (hello.result as { shell: Threads }).shell
    expect(sent.host.threads.map(thread => thread.id)).toContain(codexThread)
    expect(linkOf(sent)).toBeUndefined()
    expect(linkOf((await peer.call('shell', { op: 'shell' })).result as Threads)).toBeUndefined()
    const before = peer.messages.length
    publish()
    await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'shell')).toBe(true)
    for (const message of peer.messages.slice(before).filter(message => message.event === 'shell')) expect(linkOf(message.state as Threads)).toBeUndefined()
    expect(linkOf(state)).toBe(opencodeThread)
  })
}

it('sends the delegation link while thread-delegation is on', async () => {
  const { peer, hello, publish } = await listen(true)
  expect(linkOf((hello.result as { shell: Threads }).shell)).toBe(opencodeThread)
  const before = peer.messages.length
  publish()
  await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'shell')).toBe(true)
  expect(linkOf(peer.messages.slice(before).find(message => message.event === 'shell')!.state as Threads)).toBe(opencodeThread)
})

it('hands back the same shell when no thread names a delegating thread', () => {
  const state = openCodeEverywhere()
  const without = stateWithoutDelegation(state)
  expect(without).not.toBe(state)
  expect(stateWithoutDelegation(without)).toBe(without)
})
