// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestDraftOwnerState } from '../../../src/main/agents/requestDraftOwners'
import { RequestDraftService, requestQuestionsDigest } from '../../../src/main/agents/requestDrafts'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentThread } from '../../../src/shared/agents'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { RequestDraftTarget } from '../../../src/shared/requestDrafts'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const questions = [{ id: 'question', question: 'Where?', multiSelect: false, allowFreeText: true, options: [] }]
const digest = requestQuestionsDigest(questions)

function thread(id: string): AgentThread {
  return { id, providerId: 'codex', projectId: 'project', title: 'Task', modelId: '', status: 'idle', messages: [],
    requests: [{ id: 'request', kind: 'question', text: 'Question', options: [], questions }] }
}

/**
 * The owner's scale on October 20, 2026: a few hundred answered questions in the retirement ledger, some of them on a
 * connected remote host, and a remote thread whose answer is being typed (#1230).
 */
async function ownerScale(root: string, retirements: number, remoteRetirements: number) {
  const remoteState = emptyDesktopState(REMOTE)
  remoteState.host.connected = true; remoteState.connection = 'connected'
  remoteState.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  remoteState.host.threads = [thread('typing'), ...Array.from({ length: 250 }, (_, index) => thread('remote-' + index))]
  // A remote host's shell is a copy of its last push; its view is read in place.
  const shell = vi.fn(() => structuredClone(remoteState))
  // `view` is not on the connection's type: the router reads it where a host service has one, as `SocketHostService` does.
  const service = { shell, view: () => remoteState, threadKind: (id: string) => remoteState.host.threads.find(item => item.id === id)?.kind,
    subscribe: () => () => {}, command: async () => remoteState, requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed: [] }) }
  const connection: DesktopHostConnection = { hostId: REMOTE, name: 'Remote', kind: 'remote', service, detail: async () => null, preview: () => null }
  const router = new DesktopHostRouter(emptyDesktopState)
  router.add(connection)
  const localState = emptyDesktopState(LOCAL)
  localState.host.connected = true
  localState.host.threads = Array.from({ length: 256 }, (_, index) => thread('local-' + index))
  const local = { hostId: () => LOCAL, requestDraftView: () => ({ host: localState.host, provider: 'codex' as const }),
    requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed: [] }) }
  const owner = (index: number) => index < remoteRetirements
    ? hostEntityKey(REMOTE, 'remote-' + index) : hostEntityKey(LOCAL, 'local-' + index)
  await writeFile(join(root, 'request-drafts.json'), JSON.stringify({ version: 2, drafts: [],
    retirements: Array.from({ length: retirements }, (_, index) => ({ owner: { kind: 'thread', ownerId: owner(index), providerId: 'codex' },
      requestId: 'request', questionsDigest: digest, decisionId: 'decision-' + index, revision: 1 })),
    watcherOwners: [] }))
  const lookups = vi.fn((item: Parameters<typeof requestDraftOwnerState>[0]) => requestDraftOwnerState(item, local, router))
  const drafts = new RequestDraftService(root, lookups, async () => {}, { write: async () => {} })
  await drafts.start()
  // Every way the router builds every host's state: a fresh shell, or a publication.
  const builds = vi.spyOn(router as unknown as { build: (...args: unknown[]) => unknown }, 'build')
  const typing: RequestDraftTarget = { kind: 'thread', ownerId: hostEntityKey(REMOTE, 'typing'), providerId: 'codex', requestId: 'request', questions }
  return { router, drafts, shell, builds, lookups, typing }
}

/** Builds and copies per save, after the first save has classified every owner the ledger names. */
async function savingCost(root: string, retirements: number, remoteRetirements: number) {
  const scale = await ownerScale(root, retirements, remoteRetirements)
  const { drafts, builds, shell, lookups, typing, router } = scale
  try {
    const save = (revision: number) => drafts.save({ target: typing, revision, held: false,
      selections: { question: { optionIds: [], other: true, text: 'Typed answer'.slice(0, revision) } } })
    builds.mockClear(); shell.mockClear(); lookups.mockClear()
    await save(1)
    const first = { builds: builds.mock.calls.length, copies: shell.mock.calls.length, lookups: lookups.mock.calls.length }
    builds.mockClear(); shell.mockClear(); lookups.mockClear()
    for (let revision = 2; revision <= 11; revision++) await save(revision)
    return { first, perSave: { builds: builds.mock.calls.length / 10, copies: shell.mock.calls.length / 10, lookups: lookups.mock.calls.length / 10 } }
  } finally { router.dispose() }
}

describe('saving an answer at the owner\'s scale', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  const root = async () => { const made = await mkdtemp(join(tmpdir(), 'sotto-draft-save-cost-')); roots.push(made); return made }

  // On October 20, 2026 each save of a remote answer rebuilt every host's threads once for every answered question on
  // that host: 256 retirements, 40 of them remote, made 41 whole-state builds per keystroke's save and half of main's time.
  it('builds no whole state and copies no host shell, however many questions were answered before', async () => {
    const owner = await savingCost(await root(), 256, 40)
    expect(owner.first).toMatchObject({ builds: 0, copies: 0 })
    expect(owner.perSave).toMatchObject({ builds: 0, copies: 0 })
  })

  it('does work on a save that does not grow with the retirement ledger', async () => {
    const small = await savingCost(await root(), 64, 10)
    const large = await savingCost(await root(), 256, 40)
    expect(large.perSave).toEqual(small.perSave)
    // The thread being typed in, looked up for the save itself and once to classify it.
    expect(large.perSave.lookups).toBeLessThanOrEqual(2)
  })

  it('looks up a retirement again until its thread is listed, and keeps it as Watcher when it is', async () => {
    const directory = await root()
    const owner = (id: string) => ({ kind: 'thread' as const, ownerId: hostEntityKey(REMOTE, id), providerId: 'codex' as const })
    await writeFile(join(directory, 'request-drafts.json'), JSON.stringify({ version: 2, drafts: [], watcherOwners: [],
      retirements: ['offline', 'ordinary'].map((id, index) => ({ owner: owner(id), requestId: 'request', questionsDigest: digest,
        decisionId: 'decision-' + index, revision: 1 })) }))
    const listed: Record<string, { watcher?: boolean }> = { typing: {}, ordinary: {} }
    const lookups = vi.fn((item: { ownerId: string }) => {
      const found = listed[item.ownerId.split(':').at(-1)!]
      return found ? { ...found, listed: true, connected: true, ready: true, requests: [thread('x').requests[0]!] } : undefined
    })
    const writes: { watcherOwners?: unknown[] | undefined }[] = []
    const drafts = new RequestDraftService(directory, lookups, async () => {}, { write: async saved => { writes.push(saved) } })
    await drafts.start()
    const typing: RequestDraftTarget = { ...owner('typing'), requestId: 'request', questions }
    const save = (revision: number) => drafts.save({ target: typing, revision, held: false, selections: {} })
    await save(1)
    lookups.mockClear()
    await save(2)
    const asked = lookups.mock.calls.map(([item]) => item.ownerId.split(':').at(-1))
    expect(asked).toContain('offline')
    expect(asked).not.toContain('ordinary')
    // The host comes back, and the thread it had not listed is a Watcher thread.
    listed.offline = { watcher: true }
    await save(3)
    expect(writes.at(-1)?.watcherOwners).toEqual([owner('offline')])
  })
})
