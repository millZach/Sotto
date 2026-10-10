import { deferred } from '../fixtures/deferred'
import React from 'react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { ThreadComposer } from '../../src/renderer/src/agents/ThreadComposer'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../src/renderer/src/agents/threadFacts'
import { type AgentCommand, type AgentState } from '../../src/shared/agents'
import { RetainedDraftStore } from '../../src/main/agents/retainedDraftStore'
import { PIXEL_PNG } from '../fixtures/stagedImages'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import { requestDraftQuestions } from '../../src/shared/requestDrafts'

afterEach(cleanup)

function manualComposer(state: AgentState, command: (request: AgentCommand) => Promise<AgentState | null>, store: ThreadDraftStore, threadId: string) {
  store.receive(state)
  const row = describeThreads(state, Date.now()).find(row => row.thread.id === threadId)!
  return <ThreadComposer row={row} state={state} command={command} store={store} onSend={() => undefined} />
}

async function remoteDraftFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-retained-composer-')), directory = join(root, 'desktop')
  const native = new E2EAgentHost()
  const host = await startHeadlessHost({ dataDirectory: join(root, 'host'), port: 0,
    providers: { codex: native, claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Retained composer')
  const clients: SocketHostService[] = [], stores: RetainedDraftStore[] = []
  const open = async (selected?: string) => {
    const store = new RetainedDraftStore({ directory }); stores.push(store)
    const client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false,
      retainedDrafts: store, ...(selected ? { getSelectedThreadId: () => selected } : {}) })
    clients.push(client); await client.connect(); return { client, store }
  }
  const initial = await open()
  await initial.client.command({ type: 'connect', provider: 'codex' })
  const created = await initial.client.command({ type: 'create-project', provider: 'codex', title: 'Recovery project', path: root, useExisting: true })
  const projectId = created.host.projects.find(project => project.path === root)!.id
  const nativeIds = new Map<string, string>()
  const create = async (title: string) => {
    const before = new Set((await native.snapshot()).threads.map(thread => thread.id))
    const state = await initial.client.command({ type: 'create-thread', projectId, title, titleSource: 'user', modelId: created.host.models[0]!.id })
    const thread = state.host.threads.find(thread => thread.title === title)!
    await initial.client.command({ type: 'select-thread', threadId: thread.id })
    expect((await initial.client.command({ type: 'send', draft: { threadId: thread.id, text: 'Initialize synthetic fixture', attachments: [] } })).error).toBeNull()
    nativeIds.set(thread.id, (await native.snapshot()).threads.find(thread => !before.has(thread.id))!.id)
    native.event({ type: 'ready', threadId: nativeIds.get(thread.id)!, text: 'Synthetic fixture ready' })
    return thread
  }
  const a = await create('Retained A'), b = await create('Retained B')
  await initial.client.command({ type: 'select-thread', threadId: a.id })
  const policy = async (allowed: boolean) => {
    const descriptor = JSON.parse(await readFile(join(root, 'host', 'host-listener.json'), 'utf8')) as { adminToken: string }
    const response = await fetch(url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: paired.clientId }) })
    expect(response.status).toBe(200)
  }
  const question = async (threadId: string, id: string, text = id) => {
    native.event({ type: 'question', threadId: nativeIds.get(threadId)!,
      text, request: { id, kind: 'question', text, options: [{ id: 'blue', label: 'Blue' }] } })
  }
  return { root, directory, host, hostId: paired.hostId, native, nativeIds, open, a, b, policy, question, ...initial,
    close: async () => { await Promise.all(clients.map(client => client.close())); await Promise.all(stores.map(store => store.close())); await host.close(); await rm(root, { recursive: true, force: true }) } }
}

it('does not recover a delivered prompt after both its Compose and Send replies are lost', async () => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  const { promise: gate, resolve: release } = deferred<void>()

  const { promise: delivered, resolve: sent } = deferred<void>()
  const original = f.host.service.command.bind(f.host.service)
  const held = vi.spyOn(f.host.service, 'command').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (args[0].type === 'send') { expect(result.error).toBeNull(); sent(); await gate }
    if (args[0].type === 'compose') await gate
    return result
  })
  try {
    const save = f.client.command({ type: 'compose', threadId: f.a.id, text: 'Deploy synthetic prompt' })
    const send = f.client.command({ type: 'send', draft: { threadId: f.a.id, text: 'Deploy synthetic prompt', attachments: [] } })
    const settled = Promise.allSettled([save, send])
    await delivered
    await f.client.close(); await settled; await f.store.close(); release(); held.mockRestore()
    const replacement = await f.open(f.a.id)
    expect(replacement.store.get(f.hostId, f.a.id)).toBeUndefined()
    expect(replacement.client.shell().draft).not.toBe('Deploy synthetic prompt')
    expect(writes.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(1)
  } finally { release(); held.mockRestore(); writes.mockRestore(); await f.close() }
})

it('keeps an offline laptop edit local when another client has saved a newer host revision', async () => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  try {
    await f.client.command({ type: 'compose', threadId: f.a.id, text: 'Earlier shared draft' })
    const previous = f.store.get(f.hostId, f.a.id)!
    f.store.put({ ...previous, draft: { ...previous.draft, draftId: randomUUID(), text: 'Offline laptop text' }, saved: false, recovery: true })
    await f.client.close(); await f.store.close()
    await f.host.service.command({ type: 'save-thread-draft', threadId: f.a.id, draftId: randomUUID(), text: 'Newer host text', attachments: [], requestId: null }, desktopWindowClient())
    const original = f.host.service.command.bind(f.host.service)
    const { promise: recovery, resolve: completed } = deferred<void>()
    const observed = vi.spyOn(f.host.service, 'command').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[0].type === 'save-thread-draft') completed()
      return result
    })
    try {
      const replacement = await f.open(f.a.id)
      await recovery
      expect(f.host.service.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId: f.a.id, text: 'Newer host text' }))
      expect(replacement.client.shell().draft).toBe('Offline laptop text')
      expect(replacement.store.get(f.hostId, f.a.id)?.saved).toBe(false)
      expect(writes.mock.calls.filter(([command]) => command.type === 'send' || command.type === 'answer')).toEqual([])
    } finally { observed.mockRestore() }
  } finally { writes.mockRestore(); await f.close() }
})

it('adopts the authoritative ordinary Compose binding when the native question push was delayed', async () => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  const receiver = f.client as unknown as { receive(text: string): void }, receive = receiver.receive.bind(receiver)
  const held = vi.spyOn(receiver, 'receive').mockImplementation(text => {
    const message = JSON.parse(text)
    if (message.event !== 'shell') receive(text)
  })
  try {
    await f.policy(true); await f.question(f.a.id, 'fresh-q')
    await expect.poll(() => f.host.service.shell().host.threads.find(thread => thread.id === f.a.id)?.requests[0]?.id).toBe('fresh-q')
    expect(f.client.shell().host.threads.find(thread => thread.id === f.a.id)?.requests).toEqual([])
    expect((await f.client.command({ type: 'compose', threadId: f.a.id, text: 'Exact answer' })).error).toBeNull()
    expect(f.store.get(f.hostId, f.a.id)).toMatchObject({ saved: true, draft: { requestId: 'fresh-q' } })
    expect((await f.client.command({ type: 'send' })).error).toBeNull()
    expect(writes.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
  } finally { held.mockRestore(); writes.mockRestore(); await f.close() }
})

it('retires a saved laptop copy from fresh host state after its exact obsolete proof ages out', async () => {
  const f = await remoteDraftFixture()
  try {
    await f.client.command({ type: 'compose', threadId: f.a.id, text: 'Old saved laptop text' })
    const previous = f.store.get(f.hostId, f.a.id)!
    await f.client.close(); await f.store.close()
    for (let index = 0; index < 130; index++) await f.host.service.command({ type: 'save-thread-draft', threadId: f.a.id,
      draftId: randomUUID(), text: `Authoritative host revision ${index}`, attachments: [], requestId: null }, desktopWindowClient())
    expect(f.host.service.shell().obsoleteDrafts?.some(item => item.draftId === previous.hostDraftId)).toBe(false)
    const replacement = await f.open(f.a.id)
    expect(replacement.store.get(f.hostId, f.a.id)).toBeUndefined()
    expect(replacement.client.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId: f.a.id, text: 'Authoritative host revision 129' }))
  } finally { await f.close() }
})

it('recovers the full latest edit and explicit image removal through a fresh desktop store without replaying Send', async () => {
  const f = await remoteDraftFixture()
  const { promise: gate, resolve: release } = deferred<void>()
  const original = f.host.service.command.bind(f.host.service), writes = vi.spyOn(f.native, 'execute')
  const commands: AgentCommand[] = []
  const held = vi.spyOn(f.host.service, 'command').mockImplementation(async (...args) => {
    const state = await original(...args); commands.push(structuredClone(args[0]))
    if (args[0].type === 'compose') await gate
    return state
  })
  try {
    const image = await f.client.stageAttachment({ name: 'Synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    const first = f.client.command({ type: 'compose', threadId: f.a.id, text: 'First', attachments: [image] })
    const latest = f.client.command({ type: 'compose', threadId: f.a.id, text: 'Latest without image', attachments: [] })
    const settled = Promise.allSettled([first, latest])
    await expect.poll(() => commands.some(command => command.type === 'compose')).toBe(true)
    await f.client.close(); await settled; await f.store.close()
    release(); held.mockRestore()
    const replacement = await f.open(f.a.id)
    await expect.poll(() => replacement.store.get(f.hostId, f.a.id)?.saved).toBe(true)
    expect(replacement.client.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId: f.a.id, text: 'Latest without image', requestId: null, attachments: [] }))
    expect(JSON.parse(await readFile(join(f.root, 'host', 'agents.json'), 'utf8')).threadDrafts).toContainEqual(expect.objectContaining({ threadId: f.a.id, text: 'Latest without image', attachments: [] }))
    expect(writes.mock.calls.filter(([command]) => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); held.mockRestore(); writes.mockRestore(); await f.close() }
})

it('skips a recovered stale answer while independently saving another owner and refuses Q1 text against Q2', async () => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  try {
    await f.policy(true); await f.question(f.a.id, 'q1')
    await expect.poll(() => f.client.shell().host.threads.find(thread => thread.id === f.a.id)?.requests.length).toBe(1)
    await f.client.command({ type: 'compose', threadId: f.a.id, text: 'Answer to Q1' })
    const saved = f.store.get(f.hostId, f.a.id)!
    f.store.put({ ...saved, draft: { ...saved.draft, draftId: randomUUID(), text: 'Newest answer to Q1' }, saved: false, recovery: true })
    f.store.put({ hostId: f.hostId, draft: { threadId: f.b.id, draftId: randomUUID(), text: 'Independent B', attachments: [], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: true })
    await f.client.close(); await f.store.close()
    f.native.event({ type: 'history', threadId: f.nativeIds.get(f.a.id)!, text: '', messages: [] })
    await f.question(f.a.id, 'q2')
    const replacement = await f.open(f.a.id)
    await expect.poll(() => replacement.store.get(f.hostId, f.b.id)?.saved).toBe(true)
    expect(replacement.client.shell()).toMatchObject({ draft: 'Newest answer to Q1', draftRequestId: 'q1' })
    const refused = await replacement.client.command({ type: 'send' })
    expect(refused.error).not.toBeNull()
    expect(replacement.store.get(f.hostId, f.a.id)?.draft).toMatchObject({ text: 'Newest answer to Q1', requestId: 'q1' })
    expect(f.host.service.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId: f.b.id, text: 'Independent B', requestId: null }))
    expect(writes.mock.calls.filter(([command]) => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { writes.mockRestore(); await f.close() }
})

it('keeps a missing recovered image visible and refuses to send the stripped host draft', async () => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  try {
    const image = { id: 'missing-image', digest: 'a'.repeat(64), name: 'Missing.png', mimeType: 'image/png' as const, sizeBytes: 1 }
    f.store.put({ hostId: f.hostId, draft: { threadId: f.a.id, draftId: randomUUID(), text: 'Prompt with missing image', attachments: [image], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: true })
    await f.client.close(); await f.store.close()
    const replacement = await f.open(f.a.id)
    await expect.poll(() => f.host.service.shell().threadDrafts?.find(draft => draft.threadId === f.a.id)?.text).toBe('Prompt with missing image')
    expect(replacement.store.get(f.hostId, f.a.id)).toMatchObject({ saved: false, draft: { attachments: [image] } })
    expect(replacement.client.shell().draftAttachments).toEqual([image])
    const refused = await replacement.client.command({ type: 'send', draft: { threadId: f.a.id, text: 'Prompt with missing image', attachments: [image] } })
    expect(refused.error).not.toBeNull(); expect(replacement.client.shell().draftAttachments).toEqual([image])
    expect(writes.mock.calls.filter(([command]) => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { writes.mockRestore(); await f.close() }
})

it('expires a confirmed empty saved revision before a new native question and sends the newly bound answer', async () => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  try {
    await f.policy(true)
    expect((await f.client.command({ type: 'compose', threadId: f.a.id, text: 'Discarded prompt' })).error).toBeNull()
    expect((await f.client.command({ type: 'compose', threadId: f.a.id, text: '', attachments: [] })).error).toBeNull()
    expect(f.store.get(f.hostId, f.a.id)).toBeUndefined()
    await f.question(f.a.id, 'new-question')
    await expect.poll(() => f.client.shell().host.threads.find(thread => thread.id === f.a.id)?.requests.length).toBe(1)
    expect((await f.client.command({ type: 'compose', threadId: f.a.id, text: 'New answer' })).error).toBeNull()
    expect(f.store.get(f.hostId, f.a.id)?.draft.requestId).toBe('new-question')
    expect((await f.client.command({ type: 'send' })).error).toBeNull()
    expect(writes.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
    expect(writes.mock.calls.filter(([command]) => command.type === 'send')).toEqual([])
    expect(f.store.get(f.hostId, f.a.id)).toBeUndefined()
  } finally { writes.mockRestore(); await f.close() }
})

it('binds a fresh edit to the visible question while an already saved empty Compose acknowledgement is held', async () => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  const { promise: gate, resolve: release } = deferred<void>()

  const { promise: started, resolve: entered } = deferred<void>()
  const original = f.host.service.command.bind(f.host.service)
  const held = vi.spyOn(f.host.service, 'command').mockImplementation(async (...args) => {
    const state = await original(...args)
    if (args[0].type === 'compose' && args[0].text === '') { entered(); await gate }
    return state
  })
  const pending: Promise<unknown>[] = []
  try {
    await f.policy(true)
    const empty = f.client.command({ type: 'compose', threadId: f.a.id, text: '', attachments: [] }); pending.push(empty)
    await started
    await f.question(f.a.id, 'visible-after-empty')
    await expect.poll(() => f.client.shell().host.threads.find(thread => thread.id === f.a.id)?.requests[0]?.id).toBe('visible-after-empty')
    const fresh = f.client.command({ type: 'compose', threadId: f.a.id, text: 'Fresh answer' }); pending.push(fresh)
    expect(f.store.get(f.hostId, f.a.id)?.draft.requestId).toBe('visible-after-empty')
    const send = f.client.command({ type: 'send' }); pending.push(send)
    release()
    expect((await fresh).error).toBeNull()
    expect((await send).error).toBeNull()
    await empty
    expect(writes.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
    expect(writes.mock.calls.filter(([command]) => command.type === 'send')).toEqual([])
    expect(f.store.get(f.hostId, f.a.id)).toBeUndefined()
  } finally { release(); await Promise.allSettled(pending); held.mockRestore(); writes.mockRestore(); await f.close() }
})

it.each(['revocation', 'same-id form change'] as const)('checks current recovery-save intent after interposed %s without changing the bound host draft', async boundary => {
  const f = await remoteDraftFixture(), writes = vi.spyOn(f.native, 'execute')
  const { promise: gate, resolve: release } = deferred<void>()

  const { promise: started, resolve: entered } = deferred<void>()
  const original = f.host.service.command.bind(f.host.service)
  const held = vi.spyOn(f.host.service, 'command').mockImplementation(async (...args) => {
    if (args[0].type === 'save-thread-draft') { entered(); await gate }
    return original(...args)
  })
  try {
    await f.policy(true); await f.question(f.a.id, 'recovered-question')
    await expect.poll(() => f.client.shell().host.threads.find(thread => thread.id === f.a.id)?.requests.length).toBe(1)
    const question = f.client.shell().host.threads.find(thread => thread.id === f.a.id)!.requests[0]!
    const retained = { hostId: f.hostId, draft: { threadId: f.a.id, draftId: randomUUID(), text: 'Unsent recovered answer', attachments: [], requestId: question.id, updatedAt: new Date().toISOString() },
      questionsDigest: requestQuestionsDigest(requestDraftQuestions(question)), saved: false, recovery: true }
    f.store.put(retained); await f.client.close(); await f.store.close()
    const replacement = await f.open(f.a.id)
    await started
    if (boundary === 'revocation') await f.policy(false)
    else {
      const nativeThread = (await f.native.snapshot()).threads.find(thread => thread.id === f.nativeIds.get(f.a.id))!
      f.native.event({ type: 'history', threadId: nativeThread.id, text: '', messages: nativeThread.messages })
      await f.question(f.a.id, 'recovered-question', 'Changed original form')
      await expect.poll(() => f.host.service.shell().host.threads.find(thread => thread.id === f.a.id)?.requests[0]?.text).toBe('Changed original form')
    }
    release()
    await expect.poll(() => replacement.client.shell().error).toContain(boundary === 'revocation' ? 'permission' : 'question changed')
    const refusal = replacement.client.shell().error
    await f.host.service.command({ type: 'configure', patch: { reasoningEffort: 'high' } }, desktopWindowClient())
    await replacement.client.readShell()
    expect(replacement.client.shell().error).toBe(refusal)
    expect(replacement.store.get(f.hostId, f.a.id)).toMatchObject({ saved: false, draft: retained.draft })
    expect(f.host.service.shell().threadDrafts?.find(draft => draft.threadId === f.a.id)).toBeUndefined()
    expect(writes.mock.calls.filter(([command]) => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); held.mockRestore(); writes.mockRestore(); await f.close() }
})

it.each(['clear', 'replace', 'answer'] as const)('retires only the exact saved remote revision when another client performs %s', async action => {
  const f = await remoteDraftFixture()
  let other: SocketHostService | undefined
  try {
    await f.policy(true)
    if (action === 'answer') {
      await f.question(f.a.id, 'panel-question')
      await expect.poll(() => f.client.shell().host.threads.find(thread => thread.id === f.a.id)?.requests.length).toBe(1)
    }
    expect((await f.client.command({ type: 'compose', threadId: f.a.id, text: 'Exact saved revision' })).error).toBeNull()
    const saved = f.store.get(f.hostId, f.a.id)!
    expect(saved.saved).toBe(true)
    const url = 'http://127.0.0.1:' + f.host.descriptor!.port
    const paired = await SocketHostService.pair(url, f.host.pairing.issuePairingCode().code, 'Independent clear/answer client')
    other = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
    await other.connect(); await other.command({ type: 'select-thread', threadId: f.a.id })
    if (action === 'answer') {
      const descriptor = JSON.parse(await readFile(join(f.root, 'host', 'host-listener.json'), 'utf8')) as { adminToken: string }
      expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: paired.clientId }) })).status).toBe(200)
      expect((await other.command({ type: 'answer', threadId: f.a.id, requestId: 'panel-question', answer: saved.draft.text })).error).toBeNull()
    } else if (action === 'clear') expect((await other.command({ type: 'cancel-draft' })).error).toBeNull()
    else expect((await other.command({ type: 'compose', threadId: f.a.id, text: 'Independent replacement' })).error).toBeNull()
    await expect.poll(() => f.store.get(f.hostId, f.a.id)).toBeUndefined()
    expect(f.client.shell().draft).not.toBe('Exact saved revision')
    // The host publishes obsolete drafts once its write lands, but the new revision at once, so the
    // client can retire the saved draft by revision before the proof reaches it.
    await expect.poll(() => action === 'answer' ? f.client.shell().deliveredDrafts : f.client.shell().obsoleteDrafts)
      .toContainEqual({ threadId: f.a.id, draftId: saved.hostDraftId })
  } finally { await other?.close(); await f.close() }
})

it('keeps a newer off-wire local revision when another client accepts the earlier saved answer', async () => {
  const f = await remoteDraftFixture()
  try {
    await f.policy(true); await f.question(f.a.id, 'answer-question')
    await expect.poll(() => f.client.shell().host.threads.find(thread => thread.id === f.a.id)?.requests.length).toBe(1)
    await f.client.command({ type: 'compose', threadId: f.a.id, text: 'Earlier saved answer' })
    const saved = f.store.get(f.hostId, f.a.id)!
    const latest = { ...saved, draft: { ...saved.draft, draftId: randomUUID(), text: 'Newer unsent text' }, saved: false, recovery: false }
    f.store.put(latest)
    expect((await f.host.service.command({ type: 'answer', threadId: f.a.id, requestId: 'answer-question', answer: saved.draft.text }, desktopWindowClient())).error).toBeNull()
    await expect.poll(() => f.client.shell().deliveredDrafts?.some(item => item.draftId === saved.hostDraftId)).toBe(true)
    expect(f.store.get(f.hostId, f.a.id)?.draft).toEqual(latest.draft)
    expect(f.client.shell().draft).toBe('Newer unsent text')
  } finally { await f.close() }
})

it('retains the latest manual edit when a held autosave loses its connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-socket-composer-'))
  const host = await startHeadlessHost({ dataDirectory: root, port: 0,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  let client: SocketHostService | undefined
  const { promise: held, resolve: release } = deferred<void>()
  try {
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Composer client')
    client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, catchUpEvents: false })
    await client.connect()
    await client.command({ type: 'connect', provider: 'codex' })
    const created = await client.command({ type: 'create-project', provider: 'codex', title: 'Remote project', path: root, useExisting: true })
    const projectId = created.host.projects.find(project => project.path === root)!.id
    const opened = await client.command({ type: 'create-thread', projectId, title: 'Remote thread', modelId: created.host.models[0]!.id })
    const thread = opened.host.threads.find(item => item.title === 'Remote thread')!
    await client.command({ type: 'select-thread', threadId: thread.id })
    const original = host.service.command.bind(host.service)
    const received: AgentCommand[] = []
    const spy = vi.spyOn(host.service, 'command').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[0].type === 'save-thread-draft') { received.push(args[0]); await held }
      return result
    })
    const writes: Promise<unknown>[] = []
    const command = (input: AgentCommand) => {
      const task = client!.command(input).catch(() => null)
      writes.push(task)
      return task
    }
    const store = new ThreadDraftStore(command)
    const view = render(manualComposer(client.shell(), command, store, thread.id))
    const unsubscribe = client.subscribe(state => { view.rerender(manualComposer(state, command, store, thread.id)) })
    try {
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Fix' } })
        await expect.poll(() => received.length).toBe(1)
        fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Fix the parser and add tests' } })
      })
      expect(received).toEqual([expect.objectContaining({ type: 'save-thread-draft', threadId: thread.id, text: 'Fix' })])
      await act(async () => { await client!.close(); await Promise.all(writes) })
      release(); spy.mockRestore()
      await act(async () => { await client!.connect() })
      expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Fix the parser and add tests')
      expect(host.service.shell()).not.toHaveProperty('assignments')
      expect(host.service.threadDetail(thread.id)!.messages.filter(message => message.role === 'user')).toHaveLength(0)
    } finally { unsubscribe(); store.flushAll(); view.unmount(); spy.mockRestore() }
  } finally { release(); await client?.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps successive socket edits active in the manual composer and sends the picked draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-socket-composer-'))
  const native = new E2EAgentHost()
  const writes = vi.spyOn(native, 'execute')
  const host = await startHeadlessHost({ dataDirectory: root, port: 0,
    providers: { codex: native, claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  let client: SocketHostService | undefined
  try {
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Composer client')
    client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId })
    await client.connect()
    await client.command({ type: 'connect', provider: 'codex' })
    const local = client.shell().host.threads[0]!
    const created = await client.command({ type: 'create-project', provider: 'codex', title: 'Remote project', path: root, useExisting: true })
    const projectId = created.host.projects.find(project => project.path === root)!.id
    const opened = await client.command({ type: 'create-thread', projectId, title: 'Remote thread', modelId: created.host.models[0]!.id })
    const remote = opened.host.threads.find(thread => thread.title === 'Remote thread')!
    expect(host.service.shell()).toMatchObject({ composing: false, draftThreadId: null })
    await client.command({ type: 'select-thread', threadId: remote!.id })
    await client.command({ type: 'observe-threads', threadIds: [remote.id] })
    const calls: { type: string; error: string | null }[] = []
    const command = async (input: AgentCommand) => { const result = await client!.command(input); calls.push({ type: input.type, error: result.error }); return result }
    const store = new ThreadDraftStore(command)
    const view = render(manualComposer(client.shell(), command, store, remote.id))
    const unsubscribe = client.subscribe(state => { view.rerender(manualComposer(state, command, store, remote.id)) })
    try {
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'First edit' } })
        await expect.poll(() => calls.filter(call => call.type === 'save-thread-draft').length).toBe(1)
        expect(client!.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId: remote.id, text: 'First edit' }))
      })
      expect(screen.getByRole('textbox', { name: 'Prompt' })).not.toHaveAttribute('readonly')
      expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument()
      await host.service.command({ type: 'select-thread', threadId: local!.id }, desktopWindowClient())
      await act(async () => { await host.service.command({ type: 'compose', text: 'Host draft' }, desktopWindowClient()) })
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Second edit' } })
        await expect.poll(() => calls.filter(call => call.type === 'save-thread-draft').length).toBe(2)
        expect(client!.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId: remote.id, text: 'Second edit' }))
      })
      expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Second edit')
      await act(async () => {
        expect(screen.getByRole('button', { name: 'Send prompt' })).not.toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
        await expect.poll(() => calls.some(call => call.type === 'manual-send')).toBe(true)
        expect(calls).toEqual(expect.arrayContaining([{ type: 'manual-send', error: null }]))
        await expect.poll(() => host.service.shell().deliveries).toContainEqual(expect.objectContaining({ threadId: remote.id, status: 'accepted' }))
        expect(writes.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(1)
        expect(writes.mock.calls.find(([command]) => command.type === 'send')?.[0]).toMatchObject({ type: 'send', text: 'Second edit' })
      })
      expect(host.service.shell()).toMatchObject({ draft: 'Host draft', draftThreadId: local!.id })
      expect(host.service.shell()).not.toHaveProperty('assignments')
    } finally { unsubscribe(); view.unmount() }
  } finally { await client?.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
