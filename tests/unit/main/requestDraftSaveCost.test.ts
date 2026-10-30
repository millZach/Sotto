// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestDraftOwnerState, requestDraftWatcherOwnerIds } from '../../../src/main/agents/requestDraftOwners'
import { RequestDraftService, requestQuestionsDigest, type RequestDraftOwnerState } from '../../../src/main/agents/requestDrafts'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentThread } from '../../../src/shared/agents'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { RequestDraft, RequestDraftOwner, RequestDraftTarget } from '../../../src/shared/requestDrafts'

// Every owner key the answer store or the router works out: the measure of how much of the ledger a save walks.
const counted = vi.hoisted(() => ({ ownerKeys: 0 }))
vi.mock('../../../src/shared/requestDrafts', async original => {
  const shared = await original<typeof import('../../../src/shared/requestDrafts')>()
  return { ...shared, requestDraftOwnerKey: (owner: RequestDraftOwner) => { counted.ownerKeys++; return shared.requestDraftOwnerKey(owner) } }
})

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const questions = [{ id: 'question', question: 'Where?', multiSelect: false, allowFreeText: true, options: [] }]
const digest = requestQuestionsDigest(questions)
const remoteDefault = emptyDesktopState(REMOTE).configuration.provider

function thread(id: string, providerId: AgentThread['providerId'] | null = 'codex'): AgentThread {
  return { id, ...(providerId ? { providerId } : {}), projectId: 'project', title: 'Task', modelId: '', status: 'idle', messages: [],
    requests: [{ id: 'request', kind: 'question', text: 'Question', options: [], questions }] }
}

/**
 * The owner's scale on October 20, 2026: a few hundred answered questions in the retirement ledger, some of them on a
 * connected remote host, and a remote thread whose answer is being typed (#1230). `held` adds a held answer on a remote
 * thread that names no provider, waiting for its receipt.
 */
async function ownerScale(root: string, retirements: number, remoteRetirements: number, options: { held?: boolean } = {}) {
  const remoteState = emptyDesktopState(REMOTE)
  remoteState.host.connected = true; remoteState.connection = 'connected'
  remoteState.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  remoteState.host.threads = [thread('typing'), thread('providerless', null), ...Array.from({ length: 250 }, (_, index) => thread('remote-' + index))]
  // A remote host's shell is a copy of its last push; its view is read in place.
  const shell = vi.fn(() => structuredClone(remoteState))
  // `view` is not on the connection's type: the router reads it where a host service has one, as `SocketHostService` does.
  const service = { shell, view: () => remoteState, threadKind: (id: string) => remoteState.host.threads.find(item => item.id === id)?.kind,
    subscribe: () => () => {}, command: async () => remoteState, requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed: [] }) }
  const connection: DesktopHostConnection = { hostId: REMOTE, name: 'Remote', kind: 'remote', service, detail: async () => null, preview: () => null,
    refreshRequestAnswer: async () => {} }
  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true })
  router.add(connection)
  const localState = emptyDesktopState(LOCAL)
  localState.host.connected = true
  localState.host.threads = Array.from({ length: 256 }, (_, index) => thread('local-' + index))
  const local = { hostId: () => LOCAL, requestDraftView: () => ({ host: localState.host, provider: 'codex' as const }),
    requestAnswerRecovery: () => ({ uncertainRequestIds: [], completed: [] }) }
  const owner = (index: number) => index < remoteRetirements
    ? hostEntityKey(REMOTE, 'remote-' + index) : hostEntityKey(LOCAL, 'local-' + index)
  const held: RequestDraft = { target: { kind: 'thread', ownerId: hostEntityKey(REMOTE, 'providerless'), providerId: remoteDefault, requestId: 'request', questions },
    revision: 1, selections: {}, held: true, decisionId: 'held-decision' }
  await writeFile(join(root, 'request-drafts.json'), JSON.stringify({ version: 2, drafts: options.held ? [held] : [],
    retirements: Array.from({ length: retirements }, (_, index) => ({ owner: { kind: 'thread', ownerId: owner(index), providerId: 'codex' },
      requestId: 'request', questionsDigest: digest, decisionId: 'decision-' + index, revision: 1 })),
    watcherOwners: [] }))
  const lookups = vi.fn((item: RequestDraftOwner) => requestDraftOwnerState(item, local, router))
  const writes: { watcherOwners?: RequestDraftOwner[] | undefined }[] = []
  // What each save hands the file: the compact text the store writes as it is.
  const texts: (string | undefined)[] = []
  const drafts = new RequestDraftService(root, lookups, async () => {}, { write: async (saved, text) => { writes.push(saved); texts.push(text) } }, undefined,
    () => requestDraftWatcherOwnerIds(local, () => [], router))
  await drafts.start()
  // Every way the router builds every host's state: a fresh shell, or a publication.
  const builds = vi.spyOn(router as unknown as { build: (...args: unknown[]) => unknown }, 'build')
  const typing: RequestDraftTarget = { kind: 'thread', ownerId: hostEntityKey(REMOTE, 'typing'), providerId: 'codex', requestId: 'request', questions }
  const save = (revision: number) => drafts.save({ target: typing, revision, held: false,
    selections: { question: { optionIds: [], other: true, text: 'Typed answer'.slice(0, revision) } } })
  return { router, drafts, shell, builds, lookups, typing, save, writes, texts, remoteState, localState }
}

/** Builds, copies, lookups and owner keys per save, after the first save has classified every owner the ledger names. */
async function savingCost(root: string, retirements: number, remoteRetirements: number) {
  const { builds, shell, lookups, router, save } = await ownerScale(root, retirements, remoteRetirements)
  const clear = () => { builds.mockClear(); shell.mockClear(); lookups.mockClear(); counted.ownerKeys = 0 }
  const cost = (saves: number) => ({ builds: builds.mock.calls.length / saves, copies: shell.mock.calls.length / saves,
    lookups: lookups.mock.calls.length / saves, ownerKeys: counted.ownerKeys / saves })
  try {
    clear()
    await save(1)
    const first = cost(1)
    clear()
    for (let revision = 2; revision <= 11; revision++) await save(revision)
    return { first, perSave: cost(10) }
  } finally { router.dispose() }
}

/** The size of every collection the answer store keeps, its own and one level into the records it holds. */
function heldCollections(drafts: RequestDraftService): number[] {
  const sizes: number[] = []
  const visit = (value: unknown, depth: number): void => {
    if (value instanceof Set || value instanceof Map) sizes.push(value.size)
    else if (depth > 0 && value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      for (const item of Object.values(value)) visit(item, depth - 1)
    }
  }
  for (const [name, value] of Object.entries(drafts)) if (name !== 'listeners' && name !== 'saved') visit(value, 1)
  return sizes
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
    // The thread being typed in, looked up for the save itself and once to classify it, from the first save on. The
    // first save also indexes the ledger it found on disk, once.
    expect(large.first.lookups).toEqual(small.first.lookups)
    expect(large.perSave.lookups).toBeLessThanOrEqual(2)
    expect(large.perSave.ownerKeys).toBeLessThanOrEqual(4)
  })

  // Every save rewrote the ledger of answered questions, indented, though a save keeps it as it was (October 29, 2026).
  it('serializes no more on a later save with a longer ledger, and hands the file compact text of what it saved', async () => {
    const serialized = async (retirements: number, remoteRetirements: number) => {
      const scale = await ownerScale(await root(), retirements, remoteRetirements)
      try {
        await scale.save(1)
        const stringify = JSON.stringify
        let characters = 0
        const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
          const text = stringify(...args); characters += text?.length ?? 0; return text
        })
        try { await scale.save(2) } finally { spy.mockRestore() }
        const text = scale.texts.at(-1)
        return { characters, text, saved: scale.writes.at(-1) }
      } finally { scale.router.dispose() }
    }
    const small = await serialized(64, 10), large = await serialized(256, 40)
    expect(large.characters).toBe(small.characters)
    expect(large.text).toBeDefined()
    expect(large.text).not.toContain('\n')
    expect(JSON.parse(large.text!)).toEqual(JSON.parse(JSON.stringify(large.saved)))
  })

  it('builds no whole state for a recovery pass that finds nothing changed, though the held answer\'s thread names no provider', async () => {
    const { router, drafts, builds, shell, lookups } = await ownerScale(await root(), 256, 40, { held: true })
    try {
      await router.reconcileRequestDrafts(drafts)
      builds.mockClear(); shell.mockClear(); lookups.mockClear()
      await router.reconcileRequestDrafts(drafts)
      expect(lookups).toHaveBeenCalled()
      expect(builds).not.toHaveBeenCalled()
      expect(shell).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })

  it('keeps an answered thread as Watcher once it becomes one, on this computer or a remote host', async () => {
    const scale = await ownerScale(await root(), 64, 10)
    try {
      await scale.save(1)
      expect(scale.writes.at(-1)?.watcherOwners).toEqual([])
      scale.remoteState.host.threads.find(item => item.id === 'remote-3')!.kind = 'watcher'
      scale.localState.host.threads.find(item => item.id === 'local-40')!.kind = 'watcher-history'
      await scale.save(2)
      expect(scale.writes.at(-1)?.watcherOwners).toEqual([
        { kind: 'thread', ownerId: hostEntityKey(REMOTE, 'remote-3'), providerId: 'codex' },
        { kind: 'thread', ownerId: hostEntityKey(LOCAL, 'local-40'), providerId: 'codex' },
      ])
    } finally { scale.router.dispose() }
  })

  it('holds no owner its drafts and retirements do not name, after discards, trimming and a host leaving', async () => {
    const directory = await root()
    const ownerOf = (id: string) => ({ kind: 'thread' as const, ownerId: hostEntityKey(REMOTE, id), providerId: 'codex' as const })
    const retired = (id: string, index: number) => ({ owner: ownerOf(id), requestId: 'request', questionsDigest: digest, decisionId: 'decision-' + index, revision: 1 })
    // A full ledger of ordinary answers, so retiring one more trims the oldest.
    const ledger = Array.from({ length: 512 }, (_, index) => retired('answered-' + index, index))
    const proof = { requestId: 'request', decisionId: 'accepted', questionsDigest: digest }
    const accepted = new Set<string>()
    const lookup = (item: RequestDraftOwner): RequestDraftOwnerState => ({ connected: true, ready: true,
      requests: accepted.has(item.ownerId) ? [] : [thread('x').requests[0]!], completed: accepted.has(item.ownerId) ? [proof] : [] })
    await writeFile(join(directory, 'request-drafts.json'), JSON.stringify({ version: 2, drafts: [], watcherOwners: [], retirements: ledger }))
    const drafts = new RequestDraftService(directory, lookup, async () => {}, { write: async () => {} }, undefined, () => [])
    await drafts.start()
    const target = (id: string): RequestDraftTarget => ({ ...ownerOf(id), requestId: 'request', questions })
    for (let index = 0; index < 15; index++) {
      const saved = await drafts.save({ target: target('typed-' + index), revision: 1, held: false, selections: {} })
      expect(await drafts.discard({ target: saved.target, revision: saved.revision })).toBe(true)
    }
    expect(Math.max(0, ...heldCollections(drafts))).toBeLessThanOrEqual(ledger.length)
    // One more accepted answer trims the oldest from the ledger.
    await drafts.save({ target: target('last'), revision: 1, held: true, selections: {} })
    await drafts.bindDecision(target('last'), 'accepted', {})
    accepted.add(ownerOf('last').ownerId)
    await drafts.reconcile()
    expect(await drafts.status(target('last'))).toMatchObject({ status: 'accepted' })
    expect(Math.max(0, ...heldCollections(drafts))).toBeLessThanOrEqual(ledger.length)
  })
})
