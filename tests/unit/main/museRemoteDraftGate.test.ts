// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RetainedDraftStore, type RetainedDraft } from '../../../src/main/agents/retainedDraftStore'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentState } from '../../../src/shared/agents'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-remote-gate-'))
  cleanup.push(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}
const hostId = randomUUID()
const edit = (threadId: string, providerId?: 'muse' | 'codex'): RetainedDraft => ({ hostId,
  ...(providerId ? { providerId } : {}), draft: { threadId, draftId: randomUUID(), text: 'Synthetic retained ' + threadId,
    attachments: [], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: false })
function state(providerId: 'muse' | 'codex', threadId: string): AgentState {
  const snapshot = emptyDesktopState(hostId)
  snapshot.host.connected = true; snapshot.configuration.provider = providerId
  snapshot.host.threads = [{ id: threadId, providerId, kind: 'project', projectId: 'project', modelId: '', title: threadId,
    status: 'idle', messages: [], requests: [] }]
  return snapshot
}
function socket(store: RetainedDraftStore, museEnabled = false) {
  const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'synthetic', expectedHostId: hostId,
    watcherEnabled: true, museEnabled, retainedDrafts: store, catchUpEvents: false })
  const call = vi.fn(async () => state('codex', 'ordinary'))
  Object.assign(client, { frames: {}, features: ['draft-revisions'], call })
  const internal = client as unknown as { publish(state: AgentState): void; recoverDrafts(): void }
  return { client, call, internal }
}

it.each([true, false])('keeps Owl Muse remote edits whole through stable history-off load and restart (legacy identity %s)', async legacy => {
  const root = await directory(), ordinary = edit('ordinary', 'codex'), muse = edit('muse', legacy ? undefined : 'muse')
  const owl = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: true })
  owl.put(muse); owl.put(ordinary); await owl.close()
  const stable = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: false, historyEnabled: () => false })
  await stable.load(); await stable.privacyChanged()
  expect(stable.list(hostId)).toEqual([])
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([muse])
  const cold = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: false, historyEnabled: () => false })
  await cold.load(); cold.identifyThreads(hostId, [{ id: 'muse', providerId: 'muse', kind: 'project' }]); await cold.close()
  expect(cold.list(hostId)).toEqual([])
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([muse])
  const reopened = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: true })
  await reopened.load()
  expect(reopened.list(hostId)).toEqual([{ ...muse, recovery: true }])
})

it('waits for a real thread identity before recovering old disk drafts and keeps an absent thread unresolved', async () => {
  const root = await directory(), unknown = edit('unknown')
  await writeFile(join(root, 'remote-drafts.json'), JSON.stringify([unknown]))
  const store = new RetainedDraftStore({ directory: root, museEnabled: false, watcherEnabled: true })
  await store.load()
  expect(store.list(hostId)).toEqual([])
  const f = socket(store)
  f.internal.publish(state('codex', 'other'))
  f.internal.recoverDrafts()
  expect(f.call).not.toHaveBeenCalled()
  f.internal.publish(state('muse', 'unknown'))
  f.internal.recoverDrafts()
  await store.close()
  expect(f.call).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([unknown])
  await expect(f.client.command({ type: 'compose', threadId: 'unknown', text: 'Refused edit' })).rejects.toThrow('Muse is available in Sotto Owl')
})

it('erases an old unclassified ordinary disk draft once its host identifies it while history is off', async () => {
  const root = await directory(), unknown = edit('ordinary')
  await writeFile(join(root, 'remote-drafts.json'), JSON.stringify([unknown]))
  const store = new RetainedDraftStore({ directory: root, museEnabled: false, watcherEnabled: true, historyEnabled: () => false })
  await store.load()
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([unknown])
  store.identifyThreads(hostId, [{ id: 'ordinary', providerId: 'codex', kind: 'project' }]); await store.close()
  expect(JSON.parse(await readFile(join(root, 'remote-drafts.json'), 'utf8'))).toEqual([])
  expect(store.list(hostId)).toEqual([])
})

it('resolves ordinary legacy copies for normal recovery while Muse remains dormant', async () => {
  const root = await directory(), unknown = edit('ordinary')
  await writeFile(join(root, 'remote-drafts.json'), JSON.stringify([unknown]))
  const store = new RetainedDraftStore({ directory: root, museEnabled: false, watcherEnabled: true })
  await store.load()
  const f = socket(store)
  f.internal.publish(state('codex', 'ordinary')); f.internal.recoverDrafts()
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledWith(expect.objectContaining({ op: 'command', command: expect.objectContaining({ type: 'save-thread-draft', threadId: 'ordinary', text: unknown.draft.text }) }), expect.any(String)))
  await store.close()
})

it('records provider ownership when Owl retains a new remote Muse compose', async () => {
  const store = new RetainedDraftStore({ museEnabled: true, watcherEnabled: true })
  const f = socket(store, true)
  Object.assign(f.client, { cached: state('muse', 'muse') })
  await f.client.command({ type: 'compose', threadId: 'muse', text: 'Synthetic latest edit' })
  expect(store.get(hostId, 'muse')?.providerId).toBe('muse')
})

it('preserves gated and unidentified remote recovery copies while erasing identified ordinary copies', async () => {
  const root = await directory(), path = join(root, 'remote-drafts.json')
  const muse = edit('muse', 'muse'), unknown = edit('unknown'), ordinary = edit('ordinary', 'codex')
  await writeFile(path, JSON.stringify([]))
  const mixed = path + '.corrupt-mixed', broken = path + '.tmp-broken'
  await writeFile(mixed, JSON.stringify([ordinary, muse, unknown]))
  const cutOff = '[{"hostId":"' + hostId + '","draft":'
  await writeFile(broken, cutOff)
  const store = new RetainedDraftStore({ directory: root, watcherEnabled: true, museEnabled: false, historyEnabled: () => false })
  await store.load(); await store.close()
  expect(JSON.parse(await readFile(mixed, 'utf8'))).toEqual([muse, unknown])
  expect(await readFile(broken, 'utf8')).toBe(cutOff)
})
