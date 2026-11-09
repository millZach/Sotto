// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PairedClients } from '../../../src/main/agents/pairing'
import { startTeamListener } from '../../../src/main/teams/teamListener'
import { TeamService, type TeamServiceOptions } from '../../../src/main/teams/teams'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { formatTeamCode, parseTeamCode, teamRedeemAnswerSchema } from '../../../src/shared/teams'

vi.mock('../../../src/main/teams/teamListener', () => ({ startTeamListener: vi.fn(async () => ({ port: 12345, close: vi.fn(async () => undefined) })) }))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function teams(overrides: Partial<TeamServiceOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-teams-persistence-'))
  const tokens = new Map<string, string>()
  const service = new TeamService({ directory,
    credentials: { available: () => true, get: slot => tokens.get(slot) ?? '', set: async (slot, value) => { tokens.set(slot, value) } },
    tailscale: { status: async () => ({ state: 'running', dnsName: 'mine.tail1.ts.net', hostName: 'mine', others: [] }),
      serveStatus: async () => ({}), serve: async () => ({ ok: true }), unserve: async () => true },
    threads: () => ({ threads: [], beyondCap: 0 }), projects: () => [{ key: 'project', title: 'Project', machine: null }],
    write: async () => null, anchor: () => null, keepHistory: () => true, openExternal: async () => undefined, hostname: () => 'Me', ...overrides })
  cleanups.push(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  await service.start()
  return { service, directory, tokens }
}

it.each([true, false])('finishes startup after a cleanup save fails, with history %s', async keepHistory => {
  const log = vi.fn()
  vi.spyOn(AtomicJsonStore.prototype, 'read').mockResolvedValueOnce({ version: 1, ownName: '', leftOut: [], links: [],
    messages: [{ id: 'interrupted', linkId: 'peer', teammate: 'Peer', direction: 'we-asked', ask: 'working-on', askWords: '',
      state: 'asking', at: new Date().toISOString(), afterMessageId: null }], servePort: null, loopbackPort: null, deskReads: [] })
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('disk full'))
  const { service, directory } = await teams({ keepHistory: () => keepHistory, log })
  expect(log).toHaveBeenCalledWith('team-links-save-failed')
  expect(service.get().unsaved).toBe(true)
  expect(service.get().messages).toMatchObject(keepHistory ? [{ state: 'failed' }] : [])
  expect(await service.command({ type: 'leave-out', project: 'project', leftOut: true })).toEqual({ status: 'ok' })
  expect(service.get().unsaved).toBe(false)
  expect(JSON.parse(await readFile(join(directory, 'team-links.json'), 'utf8')).leftOut).toEqual(['project'])
})

it('reports an unsaved sharing change, keeps its effect, and clears the warning when a retry saves', async () => {
  const { service, directory } = await teams()
  await service.command({ type: 'leave-out', project: 'project', leftOut: false })
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('disk full'))
  const answer = await service.command({ type: 'leave-out', project: 'project', leftOut: true })
  expect(answer).toMatchObject({ status: 'refused', message: expect.stringContaining('could not save') })
  expect(service.get()).toMatchObject({ unsaved: true, projects: [{ key: 'project', leftOut: true }] })
  expect(JSON.parse(await readFile(join(directory, 'team-links.json'), 'utf8')).leftOut).toEqual([])
  expect(await service.command({ type: 'leave-out', project: 'project', leftOut: true })).toEqual({ status: 'ok' })
  expect(service.get().unsaved).toBe(false)
  expect(JSON.parse(await readFile(join(directory, 'team-links.json'), 'utf8')).leftOut).toEqual(['project'])
})

it('handles a background save failure and publishes the warning', async () => {
  const { service } = await teams({ keepHistory: () => false })
  const observed = vi.fn()
  service.subscribe(observed)
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('disk full'))
  service.privacyChanged()
  await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(expect.objectContaining({ unsaved: true })))
})

it('keeps a link that the peer already accepted when its local record cannot save', async () => {
  const { service, tokens } = await teams({ fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'linked', name: 'Peer',
    token: 'peer-token-with-enough-characters', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }))) as typeof fetch })
  // Set up the local address first, so the injected failure belongs to saving the accepted link.
  await service.command({ type: 'make-code', name: 'Me' })
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    return value && typeof value === 'object' && 'links' in value ? Promise.reject(new Error('disk full')) : write.call(this, value)
  })
  const answer = await service.command({ type: 'link', code: formatTeamCode('https://peer.tail1.ts.net:8445/', '123456'), name: 'Me' })
  expect(answer).toMatchObject({ status: 'refused', message: expect.stringContaining('could not save') })
  expect(service.get()).toMatchObject({ unsaved: true, links: [{ name: 'Peer' }] })
  expect([...tokens.values()]).toContain('peer-token-with-enough-characters')
})

it('answers linked and authenticates the peer when the code maker cannot save the link', async () => {
  const { service, tokens } = await teams()
  expect(await service.command({ type: 'make-code', name: 'Me' })).toEqual({ status: 'ok' })
  const code = parseTeamCode(service.get().code!.text)!.code
  const { handle } = vi.mocked(startTeamListener).mock.calls.at(-1)![0]
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    return value && typeof value === 'object' && 'links' in value ? Promise.reject(new Error('disk full')) : write.call(this, value)
  })

  const answer = teamRedeemAnswerSchema.parse(await handle({ command: 'redeem-code', code, name: 'Peer',
    address: 'https://peer.tail1.ts.net:8445/', token: 'peer-token-with-enough-characters' }, undefined))
  expect(answer.status).toBe('linked')
  if (answer.status !== 'linked') throw new Error('Expected a linked answer')
  expect(service.get()).toMatchObject({ unsaved: true, listening: true, code: null, links: [{ name: 'Peer' }] })
  expect(tokens.get(`team-link:${service.get().links[0]!.id}`)).toBe('peer-token-with-enough-characters')
  expect(await handle({ command: 'check', back: false }, answer.token)).toEqual({ status: 'checked' })
  expect(service.get().unsaved).toBe(true)
})

it('still rejects redemption when saving the peer credential fails', async () => {
  const failure = new Error('credential store locked')
  const { service } = await teams({ credentials: { available: () => true, get: () => '', set: async () => { throw failure } } })
  await service.command({ type: 'make-code', name: 'Me' })
  const code = parseTeamCode(service.get().code!.text)!.code
  const { handle } = vi.mocked(startTeamListener).mock.calls.at(-1)![0]
  await expect(handle({ command: 'redeem-code', code, name: 'Peer', address: 'https://peer.tail1.ts.net:8445/',
    token: 'peer-token-with-enough-characters' }, undefined)).rejects.toBe(failure)
  expect(service.get().links).toEqual([])
})

it('stops an unused listener even when revoking a refused link fails', async () => {
  const unserve = vi.fn(async () => true)
  const { service } = await teams({
    tailscale: { status: async () => ({ state: 'running', dnsName: 'mine.tail1.ts.net', hostName: 'mine', others: [] }),
      serveStatus: async () => ({}), serve: async () => ({ ok: true }), unserve },
    fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'refused', reason: 'code-rejected' }))) as typeof fetch,
  })
  vi.spyOn(PairedClients.prototype, 'revoke').mockRejectedValueOnce(new Error('disk full'))
  expect(await service.command({ type: 'link', code: formatTeamCode('https://peer.tail1.ts.net:8445/', '123456'), name: 'Me' }))
    .toMatchObject({ status: 'refused' })
  expect(service.get()).toMatchObject({ listening: false, code: null, links: [] })
  expect(unserve).toHaveBeenCalledWith(8445)
  const listener = await vi.mocked(startTeamListener).mock.results.at(-1)!.value
  expect(listener.close).toHaveBeenCalledOnce()
})


it('handles a failed background check save after linking', async () => {
  const { service } = await teams({ fetch: vi.fn(async (_input, init) => new Response(JSON.stringify(
    JSON.parse(String(init?.body)).command === 'check' ? { status: 'checked', reachedYou: true }
      : { status: 'linked', name: 'Peer', token: 'peer-token-with-enough-characters', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  ))) as typeof fetch })
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    const checked = value && typeof value === 'object' && 'links' in value
      && (value as { links: { reach: unknown }[] }).links.some(link => link.reach !== null)
    return checked ? Promise.reject(new Error('disk full')) : write.call(this, value)
  })
  expect(await service.command({ type: 'link', code: formatTeamCode('https://peer.tail1.ts.net:8445/', '123456'), name: 'Me' })).toEqual({ status: 'ok' })
  await vi.waitFor(() => expect(service.get().unsaved).toBe(true))
})

it('does not restore credentials after removing a link whose record cannot save', async () => {
  const { service, tokens } = await teams({ fetch: vi.fn(async (_input, init) => new Response(JSON.stringify(
    JSON.parse(String(init?.body)).command === 'check' ? { status: 'checked', reachedYou: true }
      : { status: 'linked', name: 'Peer', token: 'peer-token-with-enough-characters', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  ))) as typeof fetch })
  await service.command({ type: 'link', code: formatTeamCode('https://peer.tail1.ts.net:8445/', '123456'), name: 'Me' })
  const link = service.get().links[0]!
  await service.command({ type: 'check-link', linkId: link.id })
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    return value && typeof value === 'object' && 'links' in value ? Promise.reject(new Error('disk full')) : write.call(this, value)
  })
  expect(await service.command({ type: 'remove-link', linkId: link.id })).toMatchObject({ status: 'refused' })
  expect(service.get()).toMatchObject({ links: [], unsaved: true })
  expect(tokens.get(`team-link:${link.id}`)).toBe('')
})
