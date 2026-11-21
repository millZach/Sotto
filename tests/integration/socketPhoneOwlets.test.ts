// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PairedClients } from '../../src/main/agents/pairing'
import type { HostService } from '../../src/main/agents/hostService'
import { startSocketServer } from '../../src/host/socketServer'
import type { AgentState } from '../../src/shared/agents'
import { OPENCODE_EVERYWHERE, openCodeEverywhere } from '../fixtures/openCodeEverywhere'
import { rawPeer } from '../fixtures/rawHostPeer'

/**
 * Owlets on a phone (ADR-0213, the first slice's second part): a phone whose hello accepts `owlets` has an Owlets tab and
 * is sent the owlets' threads, with their names and roles; a phone without one is sent none, as before.
 */
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
const { codexThread, opencodeThread } = OPENCODE_EVERYWHERE
const OWLET = { name: 'Tawny', role: 'Keeps my inbox' }

async function listen() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-phone-owlets-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const pairing = new PairedClients(directory); await pairing.load()
  const plain = openCodeEverywhere()
  const state: AgentState = { ...plain, host: { ...plain.host, threads: plain.host.threads.map(thread => thread.id === codexThread ? { ...thread, owlet: OWLET } : thread) } }
  const listeners = new Set<(value: AgentState) => void>()
  const service = {
    shell: () => state, state: () => state, subscribe: (listener: (next: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    threadKind: () => 'project', events: () => [], threadDetail: (threadId: string) => ({ threadId, revision: 1, messages: [] }),
    command: async () => state, supportsOwlets: true, owletThreadIds: () => new Set([codexThread]),
  } as unknown as HostService
  const server = await startSocketServer({ service, pairing, admin: false })
  cleanup.push(() => server.close())
  const phone = async (accepts: string[]) => {
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'A phone')
    const peer = await rawPeer(server.descriptor.port, pairing.signSession(paired.clientId, Date.now()))
    cleanup.push(async () => peer.frames.close())
    const hello = await peer.call('hello', { op: 'hello', afterSeq: 0, accepts: ['provider-opencode', 'activity-summaries', ...accepts] })
    expect(hello).toMatchObject({ ok: true })
    return { peer, hello: hello.result as { features: string[]; shell: Shell } }
  }
  const publish = () => { for (const listener of listeners) listener(state) }
  return { phone, publish }
}

type Shell = { host: { threads: { id: string; owlet?: { name: string; role: string } }[]; projects: { id: string }[] } }
const owletOf = (shell: Shell) => shell.host.threads.find(thread => thread.id === codexThread)?.owlet

it('sends the owlets, with their names and roles, to a phone that accepts them', async () => {
  const { phone, publish } = await listen()
  const { peer, hello } = await phone(['owlets'])
  expect(hello.features).toContain('owlets')
  expect(owletOf(hello.shell)).toEqual(OWLET)
  expect(owletOf((await peer.call('shell', { op: 'shell' })).result as Shell)).toEqual(OWLET)
  const before = peer.messages.length
  publish()
  await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'shell')).toBe(true)
  for (const message of peer.messages.slice(before).filter(message => message.event === 'shell')) expect(owletOf(message.state as Shell)).toEqual(OWLET)
})

it('sends a phone without an Owlets tab no owlet, and its other threads as before', async () => {
  const { phone, publish } = await listen()
  const { peer, hello } = await phone([])
  const ids = (shell: Shell) => shell.host.threads.map(thread => thread.id)
  expect(ids(hello.shell)).not.toContain(codexThread)
  expect(ids(hello.shell)).toContain(opencodeThread)
  expect(ids((await peer.call('shell', { op: 'shell' })).result as Shell)).not.toContain(codexThread)
  const before = peer.messages.length
  publish()
  await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'shell')).toBe(true)
  for (const message of peer.messages.slice(before).filter(message => message.event === 'shell')) expect(ids(message.state as Shell)).not.toContain(codexThread)
})
