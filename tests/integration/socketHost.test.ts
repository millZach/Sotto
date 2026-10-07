// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import { CommandReceipts } from '../../src/host/commandReceipts'
import { PairedClients, SESSION_LIFETIME_MS } from '../../src/main/agents/pairing'
import { desktopWindowClient, type HostService } from '../../src/main/agents/hostService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { HostConnectionError, SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { execFileSync } from 'node:child_process'
import { SCREENSHOT_NOT_ITS_TYPE, type AgentCommand, type AgentModel, type AgentThreadDetail, type AgentThreadDetailDelta, type AgentThreadDetailUpdate } from '../../src/shared/agents'
import { hostPushSchema, hostVersionMismatch } from '../../src/shared/hostProtocol'
import { agentActivitySchema, type AgentActivity } from '../../src/shared/agentActivity'
import { version as packageVersion } from '../../package.json'
import { rawPeer } from '../fixtures/rawHostPeer'
import { PIXEL_PNG } from '../fixtures/stagedImages'
import { syntheticModelCatalog } from '../fixtures/modelCatalog'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { TurnRecorder } from '../../src/main/agents/turns'
import { HOST_BUSY, HOST_EVENT_PAGE_SIZE } from '../../src/shared/hostProtocol'
import { AGENT_STATE_PUBLISH_INTERVAL_MS } from '../../src/main/agents/control'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import { REMOTE_PERMISSION_DENIED } from '../../src/main/agents/authority'

let root: string
let host: Awaited<ReturnType<typeof startHeadlessHost>>
let clients: SocketHostService[]
let url: string
let native: E2EAgentHost
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-socket-'))
  native = new E2EAgentHost()
  host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: { codex: native, claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  url = 'http://127.0.0.1:' + host.descriptor!.port; clients = []
})
afterEach(async () => { await Promise.all(clients.map(client => client.close())); await host?.close(); if (root && dirname(root) === tmpdir() && root.includes('sotto-socket-')) await rm(root, { recursive: true, force: true }) })
async function pair(name = 'Socket test', onPushError?: (message: string) => void) {
  const result = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, name)
  const client = new SocketHostService({ url, token: result.token, expectedHostId: result.hostId, ...(onPushError ? { onPushError } : {}) }); clients.push(client)
  await client.connect(); return { client, result }
}
describe('authenticated host socket', () => {
  it('acknowledges a targeted draft save over the real socket without reading history or reporting a read failure', async () => {
    const onPushError = vi.fn(), { client } = await pair('Autosave client', onPushError)
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const detail = vi.spyOn(client, 'readThreadDetail').mockRejectedValue(new Error('A history read must not delay typing.'))
    const events = vi.spyOn(client, 'readEvents').mockRejectedValue(new Error('An event read must not delay typing.'))
    const command = vi.spyOn(host.service, 'command')
    const result = await client.command({ type: 'compose', threadId, text: 'An acknowledged saved edit' })
    expect(result.error).toBeNull()
    expect(result.threadDrafts?.find(draft => draft.threadId === threadId)).toMatchObject({ text: 'An acknowledged saved edit', requestId: null })
    expect(host.service.shell().threadDrafts?.find(draft => draft.threadId === threadId)).toMatchObject({ text: 'An acknowledged saved edit', requestId: null })
    expect(command.mock.calls.filter(([input]) => input.type === 'compose')).toHaveLength(1)
    expect(detail).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(onPushError).not.toHaveBeenCalled()
  })

  it('keeps forty real autosaves from starving Send, history, receipts or Check while an acknowledgement is held', async () => {
    const { client, result } = await pair('Burst saves')
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const created = await client.command({ type: 'create-project', provider: 'codex', title: 'Burst project', path: root, useExisting: true })
    const projectId = created.host.projects.find(project => project.path === root)!.id
    const opened = await client.command({ type: 'create-thread', projectId, title: 'Burst thread', modelId: created.host.models[0]!.id, managed: true })
    const threadId = opened.host.threads.find(thread => thread.title === 'Burst thread')!.id
    await client.command({ type: 'select-thread', threadId })
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    const actual = host.service.command.bind(host.service), calls: AgentCommand[] = []
    let release: () => void = () => undefined, entered: () => void = () => undefined, sent: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const sendAdmitted = new Promise<void>(resolve => { sent = resolve })
    const pending: Promise<unknown>[] = []
    const spy = vi.spyOn(host.service, 'command').mockImplementation(async (...args) => {
      calls.push(structuredClone(args[0]))
      const result = actual(...args)
      if (args[0].type === 'send') sent()
      const state = await result
      if (args[0].type === 'compose' && args[0].text === 'Edit 0') { entered(); await gate }
      return state
    })
    try {
      const saves = Array.from({ length: 40 }, (_, index) => client.command({ type: 'compose', threadId, text: `Edit ${index}` }))
      pending.push(...saves)
      await started
      const detail = client.readThreadDetail(threadId), receipt = client.receipt('absent-attempt')
      const check = client.checkRequestAnswer({ threadId, providerId: 'codex', requestId: 'absent-question', questionsDigest: 'a'.repeat(64) })
      const checked = expect(check).rejects.toMatchObject({ code: 'stale_request' })
      const send = client.command({ type: 'send', draft: { threadId, text: 'Edit 39', attachments: [] } })
      pending.push(detail, receipt, checked, send)
      await sendAdmitted
      expect(calls.filter(command => command.type === 'compose').map(command => command.text)).toEqual(['Edit 0', 'Edit 39'])
      expect(await receipt).toEqual({ status: 'unknown' })
      expect(await detail).not.toBeNull()
      await checked
      expect((await send).error).toBeNull()
      release(); await Promise.all(pending)
      expect(saves.length).toBe(40)
      expect(calls.filter(command => command.type === 'compose')).toHaveLength(2)
    } finally { release(); await Promise.allSettled(pending); spy.mockRestore() }
  })

  it('recovers the latest null-bound edit after saturated Compose and exact-binding Send are refused', async () => {
    const { client, result } = await pair('Full autosave slots')
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    const image = await client.stageAttachment({ name: 'Synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    const control = (host.service as unknown as { control: { persist(): Promise<void> } }).control
    const persist = control.persist.bind(control)
    let release: () => void = () => undefined, entered: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const held = vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    const actual = host.service.command.bind(host.service), admitted: AgentCommand[] = []
    const command = vi.spyOn(host.service, 'command').mockImplementation((...args) => {
      const operation = actual(...args); admitted.push(structuredClone(args[0])); return operation
    })
    const nativeWrites = vi.spyOn(native, 'execute'), pending: Promise<unknown>[] = []
    try {
      pending.push(client.command({ type: 'configure', patch: { speak: false, followupLimit: 4 } })); await started
      pending.push(client.command({ type: 'compose', threadId, text: 'First prompt', attachments: [image] }, undefined, 'first-save'))
      await expect.poll(() => admitted.filter(input => input.type === 'compose').length).toBe(1)
      native.event({ type: 'question', threadId: 'workshop', text: 'New question', request: {
        id: 'new-question', kind: 'question', text: 'New question', options: [{ id: 'native:blue', label: 'Blue' }] } })
      await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.some(request => request.id === 'new-question')).toBe(true)
      pending.push(client.command({ type: 'compose', threadId, text: 'Second prompt', attachments: [image] }, undefined, 'second-save'))
      const latest = client.command({ type: 'compose', threadId, text: 'Latest packet', attachments: [] })
      pending.push(latest)
      await expect.poll(() => admitted.filter(input => input.type === 'compose').length).toBe(2)
      const send = client.command({ type: 'send', draft: { threadId, text: 'Latest packet', attachments: [] } }); pending.push(send)
      expect((await latest).error).toBe('The host is still saving earlier edits. Your draft is kept on this computer until it can be saved on the host.')
      await expect.poll(() => admitted.some(input => input.type === 'send')).toBe(true)
      expect(nativeWrites.mock.calls.filter(([input]) => input.type === 'send' || input.type === 'answer')).toEqual([])
      release(); await Promise.all(pending)
      expect((await send).error).toBe('This draft or question changed before Send arrived. Nothing was sent. Your draft is kept. Review it and send again.')
      await expect.poll(async () => {
        const disk = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))
        return disk.threadDrafts.find((draft: { threadId: string }) => draft.threadId === threadId)
      }).toMatchObject({ threadId, requestId: null, text: 'Latest packet', attachments: [] })
      expect(nativeWrites.mock.calls.filter(([input]) => input.type === 'send' || input.type === 'answer')).toEqual([])
      expect(host.service.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId, requestId: null, text: 'Latest packet', attachments: [] }))
      expect(admitted.filter(input => input.type === 'compose')).toHaveLength(2)
      expect(nativeWrites.mock.calls.filter(([input]) => input.type === 'send' || input.type === 'answer')).toEqual([])
    } finally { release(); await Promise.allSettled(pending); command.mockRestore(); held.mockRestore(); nativeWrites.mockRestore() }
  })

  it('keeps a queued null-bound prompt save outside answer policy when its preceding save establishes that binding', async () => {
    const { client } = await pair('Queued plain intent')
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const image = await client.stageAttachment({ name: 'Synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    const control = (host.service as unknown as { control: { persist(): Promise<void> } }).control
    const persist = control.persist.bind(control)
    let release: () => void = () => undefined, entered: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const held = vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    const actual = host.service.command.bind(host.service), admitted: AgentCommand[] = []
    const command = vi.spyOn(host.service, 'command').mockImplementation((...args) => {
      const operation = actual(...args); admitted.push(structuredClone(args[0])); return operation
    })
    const pending: Promise<unknown>[] = []
    try {
      pending.push(client.command({ type: 'configure', patch: { speak: false, followupLimit: 4 } })); await started
      pending.push(client.command({ type: 'compose', threadId, text: 'First plain intent', attachments: [image] }))
      await expect.poll(() => admitted.some(input => input.type === 'compose')).toBe(true)
      native.event({ type: 'question', threadId: 'workshop', text: 'New question', request: {
        id: 'new-question', kind: 'question', text: 'New question', options: [{ id: 'native:blue', label: 'Blue' }] } })
      await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
      const latest = client.command({ type: 'compose', threadId, text: 'Newest plain intent' })
      pending.push(latest, client.command({ type: 'observe-threads', threadIds: [] }))
      const settled = Promise.allSettled(pending)
      release(); await settled
      expect((await latest).error).toBeNull()
      expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).threadDrafts).toContainEqual(expect.objectContaining({
        threadId, requestId: null, text: 'Newest plain intent', attachments: [image],
      }))
      expect(host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests.map(request => request.id)).toEqual(['new-question'])
    } finally { release(); await Promise.allSettled(pending); command.mockRestore(); held.mockRestore() }
  })

  it.each(['live', 'uncertain', 'retry-ready'] as const)('checks current answer authority at real targeted Compose execution for %s, including revocation after admission', async delivery => {
    const { client, result } = await pair('Compose authority')
    const second = (await pair('Other window')).client
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (allowed: boolean) => expect((await fetch(url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    native.event({ type: 'question', threadId: 'workshop', text: 'Question', request: {
      id: 'bound-question', kind: 'question', text: 'Question', options: [{ id: 'native:blue', label: 'Blue' }],
      ...(delivery === 'uncertain' ? { delivery: 'uncertain' } : delivery === 'retry-ready' ? { answerRetryReady: true } : {}) } })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    await host.service.command({ type: 'configure', patch: { speak: true } }, desktopWindowClient())
    const sharedFeedback = () => {
      const state = host.service.shell()
      return structuredClone({ error: state.error, notice: state.notice, speech: state.speech })
    }
    const otherFeedback = () => {
      const state = second.shell()
      return structuredClone({ error: state.error, notice: state.notice, speech: state.speech })
    }
    await second.readShell()
    const initialShared = sharedFeedback(), initialOther = otherFeedback()
    const writes = vi.spyOn(native, 'execute')
    for (const text of ['N', 'No', 'No policy']) expect((await client.command({ type: 'compose', threadId, text })).error).toBe(REMOTE_PERMISSION_DENIED)
    expect(sharedFeedback()).toEqual(initialShared)
    await second.readShell()
    expect(otherFeedback()).toEqual(initialOther)
    expect(host.service.shell().threadDrafts).toEqual([])
    await policy(true)
    expect((await client.command({ type: 'compose', threadId, text: 'Authorized answer' })).error).toBeNull()
    const before = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).threadDrafts
    await second.readShell()
    const beforeShared = sharedFeedback(), beforeOther = otherFeedback()
    let release: () => void = () => undefined, entered: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const actual = host.service.command.bind(host.service)
    const held = vi.spyOn(host.service, 'command').mockImplementationOnce(async (...args) => { entered(); await gate; return actual(...args) })
    const editing = client.command({ type: 'compose', threadId, text: 'Revoked answer' })
    try {
      await started; await policy(false); release()
      expect((await editing).error).toBe(REMOTE_PERMISSION_DENIED)
      expect(sharedFeedback()).toEqual(beforeShared)
      await second.readShell()
      expect(otherFeedback()).toEqual(beforeOther)
      expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).threadDrafts).toEqual(before)
      native.event({ type: 'history', threadId: 'workshop', text: '', messages: [] })
      await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(0)
      expect((await client.command({ type: 'compose', threadId, text: 'A saved stale answer still needs policy' })).error).toBe(REMOTE_PERMISSION_DENIED)
      expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).threadDrafts).toEqual(before)
      expect(writes.mock.calls.filter(([input]) => input.type === 'send' || input.type === 'answer')).toEqual([])
    } finally { release(); await Promise.allSettled([editing]); held.mockRestore(); writes.mockRestore() }
  })

  it('ignores a closed-question binding in an empty active composer over the real socket', async () => {
    const { client, result } = await pair('Empty stale composer')
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (allowed: boolean) => expect((await fetch(url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    await host.service.command({ type: 'assign', threadId, instruction: 'Work' }, desktopWindowClient())
    await host.service.command({ type: 'select-thread', threadId }, desktopWindowClient())
    await policy(true)
    native.event({ type: 'question', threadId: 'workshop', text: 'Question', request: {
      id: 'closed-question', kind: 'question', text: 'Question', options: [{ id: 'native:blue', label: 'Blue' }] } })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    await host.service.command({ type: 'cancel-draft' }, desktopWindowClient())
    expect((await host.service.command({ type: 'compose', text: '' }, desktopWindowClient())).error).toBeNull()
    expect(host.service.shell()).toMatchObject({ composing: true, draftThreadId: threadId, draftRequestId: 'closed-question', threadDrafts: [] })
    native.event({ type: 'history', threadId: 'workshop', text: '', messages: [] })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(0)
    await policy(false)
    expect((await client.command({ type: 'compose', threadId, text: 'A new plain prompt' })).error).toBeNull()
    expect(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')).threadDrafts).toContainEqual(expect.objectContaining({ threadId, requestId: null, text: 'A new plain prompt' }))
  })

  it.each(['missing-thread', 'wrong-provider', 'missing-request', 'changed-form', 'changed-during-read', 'closed-during-read', 'disconnected-provider', 'revoked-during-read', 'unexpected-native-error'] as const)('keeps safe answer Check guidance across the socket for %s', async scenario => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (action: 'allow-answers' | 'deny-answers') => {
      expect((await fetch(url + '/v1/admin/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    }
    await policy('allow-answers')
    const questions = [{ id: 'q', question: 'Which color?', options: [], multiSelect: false, allowFreeText: true }]
    native.event({ type: 'question', threadId: 'workshop', text: '', request: { id: 'check-question', kind: 'question', text: '', options: [], questions, delivery: 'uncertain' } })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.some(request => request.id === 'check-question')).toBe(true)
    const refresh = vi.fn(async () => {
      if (scenario === 'unexpected-native-error') throw new Error('Synthetic private provider output must not cross the socket')
      const snapshot = await native.snapshot()
      const thread = snapshot.threads.find(thread => thread.id === 'workshop')!
      if (scenario === 'changed-during-read') thread.requests[0]!.questions![0]!.question = 'A replacement question'
      if (scenario === 'closed-during-read') thread.settledAt = new Date().toISOString()
      if (scenario === 'revoked-during-read') await policy('deny-answers')
      return snapshot
    })
    Object.assign(native, { refreshThread: refresh })
    const execute = vi.spyOn(native, 'execute')
    if (scenario === 'disconnected-provider') {
      native.event({ type: 'disconnect', threadId: 'workshop', text: '' })
      await expect.poll(() => host.service.shell().host.providers?.find(provider => provider.id === 'codex')?.connection).toBe('disconnected')
    }
    const answer = { threadId: scenario === 'missing-thread' ? 'missing' : threadId, providerId: scenario === 'wrong-provider' ? 'claude' as const : 'codex' as const,
      requestId: scenario === 'missing-request' ? 'missing' : 'check-question', questionsDigest: scenario === 'changed-form' ? 'a'.repeat(64) : requestQuestionsDigest(questions) }
    const expected = scenario === 'unexpected-native-error'
      ? { code: 'unavailable', message: 'The host could not complete this request. Refresh the thread before trying again.' }
      : scenario === 'revoked-during-read'
        ? { code: 'forbidden', message: `${REMOTE_PERMISSION_DENIED} Your saved answer is kept.` }
        : scenario === 'disconnected-provider'
          ? { code: 'unavailable', message: 'Reconnect the original provider before checking this answer.' }
          : { code: 'stale_request', message: 'The original question changed or is no longer pending. Your saved answer is kept.' }
    await expect(client.checkRequestAnswer(answer)).rejects.toMatchObject(expected)
    expect(refresh).toHaveBeenCalledTimes(['changed-during-read', 'closed-during-read', 'revoked-during-read', 'unexpected-native-error'].includes(scenario) ? 1 : 0)
    expect(execute.mock.calls.filter(([command]) => command.type === 'answer')).toEqual([])
  })
  it('returns a worktree preview only in its command response, never in cached or paired-client shells', async () => {
    const { client } = await pair()
    const other = await pair('Other preview client')
    const preview = { path: '/synthetic/worktree', branch: 'sotto/test', dirty: false, ignored: ['.env'], items: [{ path: '.env', bytes: 10, fileCount: 1 }], repositories: [], untracked: [] }
    const command = vi.spyOn(host.service, 'command').mockResolvedValueOnce({ ...host.service.shell(), error: null, worktreeReclaimPreview: preview })
    const pushes: unknown[] = []
    const unsubscribe = client.subscribe(state => pushes.push(state.worktreeReclaimPreview))
    try {
      const result = await client.command({ type: 'preview-reclaim-thread-worktree', threadId: randomUUID() })
      expect(result.worktreeReclaimPreview).toEqual(preview)
      expect(client.shell().worktreeReclaimPreview).toBeUndefined()
      expect(other.client.shell().worktreeReclaimPreview).toBeUndefined()
      expect(host.service.shell().worktreeReclaimPreview).toBeUndefined()
      expect(pushes).not.toContainEqual(preview)
      command.mockResolvedValueOnce({ ...host.service.shell(), error: 'Checking this worktree is unavailable. Nothing was removed.' })
      expect((await client.command({ type: 'preview-reclaim-thread-worktree', threadId: randomUUID() })).error).toContain('Nothing was removed')
    } finally { unsubscribe(); command.mockRestore() }
  })
  it('exposes only loopback health before pairing and rejects unsigned operations', async () => {
    expect(await (await fetch(url + '/v1/health')).json()).toMatchObject({ v: 1, hostId: host.service.shell().hostId, port: host.descriptor!.port })
    expect((await fetch(url + '/v1/session', { method: 'POST' })).status).toBe(401)
    expect((await fetch(url + '/v1/admin/pairing-code', { method: 'POST' })).status).toBe(401)
    const client = new SocketHostService({ url, token: 'bad' }); clients.push(client)
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect((await fetch(url + '/v1/health', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(401)
  })
  it('pairs once, negotiates a shell and revokes a live session immediately', async () => {
    const { client, result } = await pair()
    expect(client.shell().hostId).toBe(result.hostId)
    const shell = await client.readShell()
    expect(shell).not.toHaveProperty('membership')
    expect(shell.configuration).not.toHaveProperty('membershipEndpoint')
    expect((await client.connect()).capabilities.mayAnswer).toBe(false)
    await client.revokePairing()
    expect(host.pairing.verifyToken(result.token)).toBeUndefined()
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('keeps the retired account fields on raw protocol v1 shell frames', async () => {
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Older desktop')
    const session = host.pairing.signSession(paired.clientId)
    const peer = await rawPeer(host.descriptor!.port, session)
    try {
      const reply = await peer.call('shell-v1', { op: 'shell' })
      expect(reply).toMatchObject({ v: 1, ok: true, result: {
        membership: { status: 'beta', label: '', expiresAt: null },
        configuration: { membershipEndpoint: '' },
      } })
    } finally { peer.frames.close() }
  })
  it('pushes each client answer authority when the host policy changes', async () => {
    const first = await pair('First'), second = await pair('Second')
    const peers = await Promise.all([first, second].map(({ result }) => rawPeer(host.descriptor!.port, host.pairing.signSession(result.clientId))))
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    try {
      for (const peer of peers) await peer.call('hello', { op: 'hello' })
      for (const allowed of [true, false]) {
        for (const peer of peers) peer.messages.length = 0
        const response = await fetch(url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
          method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: first.result.clientId }),
        })
        expect(response.status).toBe(200)
        await expect.poll(() => peers[0]!.messages.find(message => message.event === 'shell')).toMatchObject({ state: { clientCapabilities: { mayAnswer: allowed } } })
        await expect.poll(() => peers[1]!.messages.find(message => message.event === 'shell')).toMatchObject({ state: { clientCapabilities: { mayAnswer: false } } })
      }
    } finally { for (const peer of peers) peer.frames.close() }
  })
  it('deduplicates commands by authenticated client and refuses a changed payload', async () => {
    const { client } = await pair()
    const commandId = randomUUID()
    const command = { type: 'configure', patch: { enabled: false } } as const
    await client.command(command, undefined, commandId)
    expect(await client.receipt(commandId)).toEqual({ status: 'completed' })
    await client.command(command, undefined, commandId)
    await expect(client.command({ type: 'configure', patch: { enabled: true } }, undefined, commandId)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(host.service.shell().configuration.enabled).toBe(false)
    const other = await pair('Other')
    expect(await other.client.receipt(commandId)).toEqual({ status: 'unknown' })
  })
  it.each(['too_large', 'disconnected'] as const)('keeps an acknowledged rename successful when detail refresh fails with %s', async code => {
    const report = vi.fn()
    const { client } = await pair('Refresh failure', report)
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    vi.spyOn(client, 'readThreadDetail').mockRejectedValueOnce(new HostConnectionError('Fixture detail failure', code))
    const result = await client.command({ type: 'rename-thread', threadId, title: 'Renamed once' })
    expect(result.host.threads.find(thread => thread.id === threadId)?.title).toBe('Renamed once')
    expect(host.service.shell().host.threads.find(thread => thread.id === threadId)?.title).toBe('Renamed once')
    expect(report).toHaveBeenCalledOnce()
  })
  it('refuses grant-equivalent permission changes and host-local administration without authority', async () => {
    const { client } = await pair()
    await expect(client.command({ type: 'configure-thread', threadId: 'missing', runtimeMode: 'full-access' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'create-thread', projectId: 'project', title: 'Bypass', modelId: 'fixture-model', runtimeMode: 'full-access' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'credential', slot: 'reasoning', value: 'not-a-real-key' })).rejects.toMatchObject({ code: 'forbidden' })
    // Devin's Bypass permissions stops Sotto asking at all, and discarding uncommitted work answers a confirmation.
    await expect(client.command({ type: 'create-thread', projectId: 'project', title: 'Bypass', modelId: 'fixture-model', providerMode: 'bypass' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'configure-thread', threadId: 'missing', providerMode: 'bypass' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'reclaim-thread-worktree', threadId: 'missing', withUncommittedChanges: true })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'restore-thread-branch', threadId: 'missing', withUncommittedChanges: true })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'update-client', provider: 'codex' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(client.command({ type: 'open-thread-folder', threadId: 'missing' })).rejects.toMatchObject({ code: 'forbidden' })
    // Asking first grants nothing, so it reaches the host like any ordinary change.
    await expect(client.command({ type: 'configure-thread', threadId: 'missing', runtimeMode: 'approval-required' })).resolves.toBeDefined()
    // Without the discard, leaving a clean folder is ordinary work and reaches the host.
    await expect(client.command({ type: 'reclaim-thread-worktree', threadId: 'missing', withUncommittedChanges: false })).resolves.toBeDefined()
  })
  it('accepts an explicitly authorized answer and refuses the same device after policy revocation', async () => {
    const { client, result } = await pair('  Studio\n\u202e laptop\u0000  ')
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (action: string) => {
      const response = await fetch(url + '/v1/admin/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })
      expect(response.status).toBe(200)
    }
    await policy('allow-answers')
    expect((await client.connect()).capabilities.mayAnswer).toBe(true)
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-one', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const answerId = randomUUID()
    expect((await client.command({ type: 'answer', threadId, requestId: 'permission-one', answer: '', approved: true }, undefined, answerId)).error).toBeNull()
    expect(await client.receipt(answerId)).toEqual({ status: 'completed', answerDelivered: true })
    expect(host.service.events(0, threadId)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ kind: 'answer-given', attribution: expect.objectContaining({ clientId: result.clientId, user: 'Studio laptop', transport: 'socket' }) }) }))
    await policy('deny-answers')
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-two', text: 'Again?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.some(request => request.id === 'permission-two')).toBe(true)
    await expect(client.command({ type: 'answer', threadId, requestId: 'permission-two', answer: '', approved: true })).rejects.toMatchObject({ code: 'forbidden' })
    expect(host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests).toContainEqual(expect.objectContaining({ id: 'permission-two' }))
  })
  it.each([
    { name: 'refused', result: { accepted: false }, requestLeaves: false },
    { name: 'uncertain', result: { accepted: true, uncertain: true }, requestLeaves: false },
    { name: 'uncertain after desktop resolution', result: { accepted: true, uncertain: true }, requestLeaves: true },
    { name: 'unaccepted and uncertain after desktop resolution', result: { accepted: false, uncertain: true }, requestLeaves: true },
  ])('records a $name answer receipt from the real coordinator outcome', async ({ result: outcome, requestLeaves }) => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const execute = native.execute.bind(native)
    const spy = vi.spyOn(native, 'execute').mockImplementation(async command => {
      if (command.type !== 'answer') return execute(command)
      // A desktop denial can remove the request without confirming the phone's Allow.
      if (requestLeaves) await execute({ ...command, approved: false })
      return outcome
    })
    try {
      const commandId = randomUUID()
      // Preserve v1's shell response even on coordinator failure; the receipt owns its outcome.
      await client.command({ type: 'answer', threadId, requestId: 'permission-receipt', answer: '', approved: true }, undefined, commandId)
      expect(await client.receipt(commandId)).toMatchObject({ status: 'completed', answerDelivered: false, error: { code: 'unavailable' } })
      expect(host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests).toHaveLength(requestLeaves ? 0 : 1)
    } finally { spy.mockRestore() }
  })
  it.each([false, true])('keeps an uncertain question draft send private when accepted is %s', async accepted => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await host.service.command({ type: 'assign', threadId, instruction: 'Fix the tests' }, desktopWindowClient())
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    native.event({ type: 'question', threadId: 'workshop', requestId: 'question-draft-receipt', text: 'Which color?' })
    await expect.poll(() => client.shell().queue.some(item => item.requestId === 'question-draft-receipt')).toBe(true)
    await client.command({ type: 'select-thread', threadId })
    expect(await client.command({ type: 'compose', text: 'Blue' })).toMatchObject({ composing: true, draft: 'Blue', draftRequestId: 'question-draft-receipt' })
    const execute = native.execute.bind(native)
    const adapter = vi.spyOn(native, 'execute').mockImplementation(command => command.type === 'answer'
      ? Promise.resolve({ accepted, uncertain: true }) : execute(command))
    const dispatch = host.service.command.bind(host.service)
    let coordinatorError: string | null | undefined
    const coordinator = vi.spyOn(host.service, 'command').mockImplementation(async (command, identity) => {
      const state = await dispatch(command, identity)
      if (command.type === 'send') coordinatorError = state.error
      return state
    })
    const readEvents = client.readEvents.bind(client)
    let refreshed = false
    const refresh = vi.spyOn(client, 'readEvents').mockImplementation(async (...args) => {
      const page = await readEvents(...args)
      expect((await client.readShell()).error).toBeNull()
      refreshed = true
      return page
    })
    try {
      const commandId = randomUUID()
      const sent = await client.command({ type: 'send' }, undefined, commandId)
      expect(refreshed).toBe(true)
      expect(coordinatorError).toBeTruthy()
      expect(sent).toMatchObject({ error: coordinatorError, composing: true, draft: 'Blue', draftRequestId: 'question-draft-receipt' })
      expect(await client.receipt(commandId)).toMatchObject({ status: 'completed', answerDelivered: false, error: { code: 'unavailable' } })
      expect(host.service.shell().error).toBeNull()
      await expect(client.command({ type: 'send' }, undefined, commandId)).rejects.toMatchObject({ code: 'unavailable' })
      expect(adapter.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
    } finally { refresh.mockRestore(); coordinator.mockRestore(); adapter.mockRestore() }
  })
  it('confirms a socket answer whose delayed delivery finishes before the wrapped result arrives', async () => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const execute = native.execute.bind(native)
    const spy = vi.spyOn(native, 'execute').mockImplementation(async command => {
      const outcome = await execute(command)
      return command.type === 'answer' ? { accepted: false, uncertain: true, answerCompletion: Promise.resolve(true) } : outcome
    })
    try {
      const commandId = randomUUID()
      expect((await client.command({ type: 'answer', threadId, requestId: 'permission-receipt', answer: '', approved: true }, undefined, commandId)).error).toBeNull()
      expect(await client.receipt(commandId)).toEqual({ status: 'completed', answerDelivered: true })
      expect(host.service.shell().error).toBeNull()
      expect(host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests).toHaveLength(0)
    } finally { spy.mockRestore() }
  })
  it('settles socket delivery confirmed while the failed command is being finalized', async () => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    let complete!: (delivered: boolean) => void
    const completion = new Promise<boolean>(resolve => { complete = resolve })
    const execute = native.execute.bind(native)
    const spy = vi.spyOn(native, 'execute').mockImplementation(command => {
      if (command.type !== 'answer') return execute(command)
      return Promise.resolve({ accepted: false, uncertain: true, answerCompletion: completion })
    })
    const finish = TurnRecorder.prototype.finish
    let settledDuringFinish = false
    const finalize = vi.spyOn(TurnRecorder.prototype, 'finish').mockImplementation(async function (this: TurnRecorder, turn, outcome) {
      if (turn?.commandType === 'answer') {
        expect(outcome).toBe('failed')
        expect(host.service.shell().error).toBeNull()
        settledDuringFinish = true
        complete(true)
        await completion
      }
      return finish.call(this, turn, outcome)
    })
    try {
      const commandId = randomUUID()
      await client.command({ type: 'answer', threadId, requestId: 'permission-receipt', answer: '', approved: true }, undefined, commandId)
      expect(settledDuringFinish).toBe(true)
      expect(await client.receipt(commandId)).toEqual({ status: 'completed', answerDelivered: true })
      expect(host.service.shell().error).toBeNull()
    } finally { finalize.mockRestore(); spy.mockRestore() }
  })
  it('confirms a successful answer receipt despite another command failing while it runs', async () => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started = false
    const execute = native.execute.bind(native)
    const spy = vi.spyOn(native, 'execute').mockImplementation(async command => {
      if (command.type === 'answer') { started = true; await gate }
      return execute(command)
    })
    let answer: Promise<unknown> | undefined
    try {
      const commandId = randomUUID()
      answer = client.command({ type: 'answer', threadId, requestId: 'permission-receipt', answer: '', approved: true }, undefined, commandId)
      await expect.poll(() => started).toBe(true)
      const failed = await client.command({ type: 'configure-thread', threadId: 'missing', runtimeMode: 'approval-required' })
      expect(failed.error).toBeTruthy()
      release()
      await answer
      // Published shared errors are unchanged; the answer receipt uses its command-local outcome.
      expect(host.service.shell().error).toBe(failed.error)
      expect(await client.receipt(commandId)).toEqual({ status: 'completed', answerDelivered: true })
    } finally { release(); await answer; spy.mockRestore() }
  })
  it('composes and sends to the peer selection while preserving another thread draft', async () => {
    const { client } = await pair()
    await client.command({ type: 'connect', provider: 'codex' })
    const threads = client.shell().host.threads
    const localId = threads[0]!.id
    const created = await client.command({ type: 'create-project', provider: 'codex', title: 'Remote project', path: root, useExisting: true })
    const projectId = created.host.projects.find(project => project.path === root)!.id
    const opened = await client.command({ type: 'create-thread', projectId, title: 'Remote thread', modelId: created.host.models[0]!.id, managed: true })
    const remoteId = opened.host.threads.find(thread => thread.title === 'Remote thread')!.id
    await host.service.command({ type: 'pause-draft' }, desktopWindowClient())
    await host.service.command({ type: 'select-thread', threadId: localId }, desktopWindowClient())
    await host.service.command({ type: 'compose', text: 'Host draft' }, desktopWindowClient())
    await client.command({ type: 'select-thread', threadId: remoteId })
    const before = host.service.shell()
    expect((await client.command({ type: 'compose', text: 'Remote draft' })).error).toBeNull()
    expect(host.service.shell().threadDrafts).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: remoteId, text: 'Remote draft' })]))
    await client.observe([remoteId])
    // The reconnect is sent the observed thread whole once, whether the host published it or read it for this client.
    const wholes: AgentThreadDetailUpdate[] = []
    const stopCounting = client.subscribeThreadDetail(update => { if (update.threadId === remoteId && !('baseRevision' in update)) wholes.push(update) })
    await client.connect()
    expect(wholes).toHaveLength(1)
    stopCounting()
    expect((await client.readShell()).activeThreadId).toBe(remoteId)
    expect((await client.command({ type: 'send' })).error).toBeNull()
    expect(host.service.threadDetail(remoteId)!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', text: 'Remote draft' })]))
    expect(host.service.shell().activeThreadId).toBe(before.activeThreadId)
    expect(host.service.shell().draft).toBe(before.draft)
    expect(host.service.shell().threadDrafts).toEqual(expect.arrayContaining(before.threadDrafts ?? []))
  })
  it.each(['cancel-draft', 'pause-draft', 'cancel-request'] as const)('targets the peer selection for %s and preserves another thread draft', async type => {
    const { client } = await pair()
    await client.command({ type: 'connect', provider: 'codex' })
    const threads = client.shell().host.threads
    await host.service.command({ type: 'select-thread', threadId: threads[0]!.id }, desktopWindowClient())
    await host.service.command({ type: 'compose', text: 'Host draft' }, desktopWindowClient())
    await client.command({ type: 'select-thread', threadId: threads[1]!.id })
    await client.command({ type: 'compose', text: 'Remote draft' })
    const before = host.service.shell()
    expect((await client.command({ type })).error).toBeNull()
    expect(host.service.shell().activeThreadId).toBe(before.activeThreadId)
    expect(host.service.shell().draft).toBe(before.draft)
    expect(host.service.shell().threadDrafts?.find(draft => draft.threadId === threads[1]!.id)?.text).toBe(type === 'cancel-draft' ? undefined : 'Remote draft')
  })
  it('refuses a second listener before it can open or overwrite the running host stores', async () => {
    await expect(startHeadlessHost({ dataDirectory: root, port: 0 })).rejects.toThrow(`Another host (process ${process.pid}) is using this data folder`)
    expect((await fetch(url + '/v1/health')).status).toBe(200)
  })
  it('does not turn caller-supplied IPC identity into permission authority', async () => {
    const { client } = await pair()
    await expect(client.command({ type: 'answer', threadId: 'missing', requestId: 'missing', answer: '', approved: true }, { clientId: 'desktop-window', user: 'owner', transport: 'ipc' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('socket client isolation and reconnect', () => {
  it('carries a thread\'s Git status to a paired client through the shell it already receives', async () => {
    // The host reads the folder; the client only reads the record, over the socket, the way any other field arrives.
    await native.initializeWorkingFolders(join(root, 'workspaces'))
    const folder = join(root, 'workspaces', 'project') // where initializeWorkingFolders puts the fixture project
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, windowsHide: true, encoding: 'utf8' })
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgSign', 'false')
    await writeFile(join(folder, 'work.txt'), 'first\n'); git('add', '.'); git('commit', '-qm', 'First')
    const { client } = await pair()
    await client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads[0]!.id
    await client.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic prompt' })
    await client.command({ type: 'refresh-thread-worktree', threadId })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.worktree?.git?.branch).toBe('main')
    expect(client.shell().host.threads.find(thread => thread.id === threadId)?.worktree?.git).toMatchObject({ isRepository: true, hasRemote: false, dirty: false, ahead: 0, behind: 0, pullRequest: null })
    // The branch picker asks the host for a page of refs over the same socket.
    git('branch', '-q', 'topic')
    const page = await client.gitRefs({ threadId, query: 'top' })
    expect(page).toEqual({ refs: [{ name: 'topic', current: false, isDefault: false, worktreePath: null }], isRepository: true, hasRemote: false, nextCursor: null, total: 1 })
    expect((await client.gitRefs({ threadId })).refs.map(ref => ref.name)).toEqual(['main', 'topic'])
    await expect(client.gitRefs({ threadId: 'no-such-thread' })).rejects.toThrow()
    // The commit dialog asks for the changed files the same way.
    await writeFile(join(folder, 'work.txt'), 'first\nsecond\n'); await writeFile(join(folder, 'new.txt'), 'new\n')
    await expect(client.gitChangedFiles({ threadId })).resolves.toEqual({ isRepository: true, truncated: false, files: [
      { path: 'new.txt', status: 'untracked', insertions: 1, deletions: 0 }, { path: 'work.txt', status: 'modified', insertions: 1, deletions: 0 }] })
    await expect(client.gitChangedFiles({ threadId: 'no-such-thread' })).rejects.toThrow()
    // The Pull request surface asks the same way; a branch with no pull request and no links has none to show, and gh is not asked.
    await expect(client.gitPullRequest({ threadId })).resolves.toBeNull()
    await expect(client.gitPullRequest({ threadId: 'no-such-thread' })).rejects.toThrow()
  })
  it('reads a thread\'s Files, Changes and Agents over the socket the way the desktop\'s own tools read them (ADR-0025, October 5 amendment)', async () => {
    await native.initializeWorkingFolders(join(root, 'workspaces'))
    const folder = join(root, 'workspaces', 'project')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, windowsHide: true, encoding: 'utf8' })
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgSign', 'false')
    await mkdir(join(folder, 'notes'))
    await writeFile(join(folder, 'work.txt'), 'first\n'); await writeFile(join(folder, 'notes', 'plan.md'), '# Plan\n'); git('add', '.'); git('commit', '-qm', 'First')
    const { client } = await pair()
    await client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads[0]!.id
    await client.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic prompt' })
    // Files: the working folder's root, a folder in it and a file's preview, each against the workspace the root named.
    const listing = await client.threadFiles({ threadId, path: '' })
    if (!listing.ok) throw new Error(listing.error.message)
    expect(listing.value).toMatchObject({ path: '', truncated: false, workspace: { threadId, workingDirectory: folder } })
    expect(listing.value.entries.filter(entry => !entry.name.startsWith('.'))).toEqual([{ name: 'notes', path: 'notes', kind: 'directory' }, { name: 'work.txt', path: 'work.txt', kind: 'file' }])
    const { workspaceId } = listing.value.workspace
    await expect(client.threadFiles({ threadId, path: 'notes', workspaceId })).resolves.toMatchObject({ ok: true, value: { entries: [{ name: 'plan.md', path: 'notes/plan.md', kind: 'file' }] } })
    await expect(client.threadFilePreview({ threadId, path: 'notes/plan.md', workspaceId })).resolves.toMatchObject({ ok: true, value: { name: 'plan.md', content: { kind: 'markdown', text: '# Plan\n' } } })
    // A refusal is an answer, as it is to the window: a stale workspace, and a thread the host does not have.
    await expect(client.threadFiles({ threadId, path: '', workspaceId: 'f'.repeat(64) })).resolves.toMatchObject({ ok: false, error: { code: 'workspace-changed' } })
    await expect(client.threadFiles({ threadId: 'no-such-thread', path: '' })).resolves.toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    // The host keeps a paired client inside the thread's working copy: a path leaving it is not even a request the host
    // reads (the desktop's own IPC refuses it the same way before sending). Previews keep the desktop's size limit.
    for (const path of ['..', '../outside.txt', join(folder, 'work.txt')]) {
      await expect(client.threadFilePreview({ threadId, path, workspaceId })).rejects.toThrow()
    }
    await expect(client.threadFiles({ threadId, path: '..', workspaceId })).rejects.toThrow()
    await writeFile(join(folder, 'large.txt'), 'x'.repeat(512 * 1024 + 1))
    await expect(client.threadFilePreview({ threadId, path: 'large.txt', workspaceId })).resolves.toMatchObject({ ok: false, error: { code: 'too-large' } })
    await rm(join(folder, 'large.txt'))
    // Changes: the change list, then the working tree and the branch, read from the host's own Git.
    await writeFile(join(folder, 'work.txt'), 'first\nsecond\n')
    await expect(client.gitChanges({ threadId, workspaceId })).resolves.toMatchObject({ ok: true, value: { branch: 'main', files: [{ path: 'work.txt', status: 'modified' }], truncated: false } })
    const working = await client.gitReview({ threadId, workspaceId, scope: { kind: 'working' } })
    expect(working).toMatchObject({ ok: true, value: { scope: { kind: 'working' }, files: [{ path: 'work.txt', status: 'modified', additions: 1, deletions: 0, content: { kind: 'text' } }] } })
    await expect(client.gitReview({ threadId, workspaceId, scope: { kind: 'branch', base: null } })).resolves.toMatchObject({ ok: true, value: { scope: { kind: 'branch', base: null, head: 'main' }, files: [] } })
    // Agents: the roster and an agent's assignments, empty for a thread that has spawned none.
    await expect(client.subagentPage({ threadId })).resolves.toMatchObject({ threadId, rows: [], summary: { total: 0 } })
    await expect(client.subagentAssignments({ threadId, agentId: 'agent' })).resolves.toEqual({ threadId, agentId: 'agent', assignments: [] })
    await expect(client.subagentPage({ threadId: 'no-such-thread' })).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('carries the finished-unread mark to a paired client and clears it for every client when one opens the thread (ADR-0046)', async () => {
    const phone = await pair('Phone'), desktop = await pair('Desktop')
    await phone.client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
    await phone.client.command({ type: 'connect', provider: 'codex' })
    await expect.poll(() => phone.client.shell().host.threads.find(thread => thread.title === 'Workshop')).toBeDefined()
    const threadId = phone.client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    // By its ID from here on: its first message gives it a first-message title.
    const workshop = () => phone.client.shell().host.threads.find(thread => thread.id === threadId)
    const marked = (client: SocketHostService) => client.shell().host.threads.find(thread => thread.id === threadId)?.finishedUnread
    native.event({ type: 'manual', threadId: 'workshop', text: 'Synthetic prompt' })
    await expect.poll(() => workshop()?.status).toBe('running')
    native.event({ type: 'ready', threadId: 'workshop', text: 'Synthetic reply' })
    await expect.poll(() => marked(phone.client)).toBe(true)
    await expect.poll(() => marked(desktop.client)).toBe(true)
    // Opening the thread on one client reads it on all of them.
    await phone.client.observe([threadId])
    await expect.poll(() => marked(desktop.client)).toBeUndefined()
    expect(marked(phone.client)).toBeUndefined()
    // While a client has it open, finishing again earns nothing.
    native.event({ type: 'manual', threadId: 'workshop', text: 'Synthetic prompt' })
    await expect.poll(() => workshop()?.status).toBe('running')
    native.event({ type: 'ready', threadId: 'workshop', text: 'Synthetic reply' })
    await expect.poll(() => workshop()?.status).toBe('idle')
    expect(marked(desktop.client)).toBeUndefined()
  })
  it('lists a temp folder\'s subfolders over the socket for the Add project dialog\'s folder browser', async () => {
    const { client } = await pair()
    const folder = join(root, 'browse')
    await mkdir(join(folder, 'child'), { recursive: true })
    const result = await client.hostFolders({ path: folder })
    expect(result).toMatchObject({ status: 'listed', path: folder, folders: [{ name: 'child', git: false }], truncated: false })
  })
  it('resyncs after a dropped connection without sending the old command again', async () => {
    const { client } = await pair()
    const id = randomUUID()
    await client.command({ type: 'configure', patch: { enabled: false } }, undefined, id)
    await client.close()
    await host.service.command({ type: 'configure', patch: { enabled: true } }, desktopWindowClient())
    await client.connect()
    expect(client.shell().configuration.enabled).toBe(true)
    expect(await client.receipt(id)).toEqual({ status: 'completed' })
  })
  it('keeps each client selection and observation independent after another client disconnects', async () => {
    const first = await pair('First'), second = await pair('Second')
    await first.client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
    await first.client.command({ type: 'connect', provider: 'codex' })
    const threads = first.client.shell().host.threads
    expect(threads.length).toBeGreaterThanOrEqual(2)
    const firstId = threads[0]!.id, secondId = threads[1]!.id
    await first.client.command({ type: 'select-thread', threadId: firstId })
    await second.client.command({ type: 'select-thread', threadId: secondId })
    await first.client.observe([firstId]); await second.client.observe([secondId])
    const firstDetails: string[] = [], secondDetails: string[] = []
    first.client.subscribeThreadDetail(detail => firstDetails.push(detail.threadId))
    second.client.subscribeThreadDetail(detail => secondDetails.push(detail.threadId))
    // A thread's history reaches only the clients observing it, when it changes.
    await first.client.command({ type: 'manual-send', threadId: firstId, draftId: randomUUID(), text: 'Synthetic first prompt' })
    await expect.poll(() => firstDetails).toContain(firstId)
    await second.client.command({ type: 'manual-send', threadId: secondId, draftId: randomUUID(), text: 'Synthetic second prompt' })
    await expect.poll(() => secondDetails).toContain(secondId)
    expect(firstDetails).not.toContain(secondId); expect(secondDetails).not.toContain(firstId)
    expect((await first.client.readShell()).activeThreadId).toBe(firstId)
    expect((await second.client.readShell()).activeThreadId).toBe(secondId)
    await first.client.close()
    secondDetails.length = 0
    await second.client.command({ type: 'manual-send', threadId: secondId, draftId: randomUUID(), text: 'Synthetic prompt, still observed' })
    await expect.poll(() => secondDetails).toContain(secondId)
  })
  it('rechecks session expiry on every operation, even on an already opened socket', async () => {
    let now = Date.now()
    const pairing = new PairedClients(join(root, 'expiry'), { now: () => now }); await pairing.load()
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Expiring')
    const server = await startSocketServer({ service: host.service, pairing })
    const session = pairing.signSession(paired.clientId)
    const key = randomBytes(16).toString('base64')
    let resolveMessage: (value: unknown) => void = () => undefined
    const reply = new Promise<unknown>(resolve => { resolveMessage = resolve })
    const frames = await new Promise<SocketFrames>((resolve, reject) => {
      const request = httpRequest('http://127.0.0.1:' + server.descriptor.port + '/v1/socket', { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, Authorization: 'Bearer ' + session } })
      request.on('error', reject)
      request.on('upgrade', (response, stream, head) => {
        expect(response.headers['sec-websocket-accept']).toBe(createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'))
        // A shell push can arrive before the reply while the session is still valid; only the reply is the assertion.
        const socket = new SocketFrames(stream, true, text => { const value = JSON.parse(text) as object; if (!('event' in value)) resolveMessage(value) })
        socket.onClose(() => resolveMessage({ closed: true })); socket.feed(head); resolve(socket)
      }); request.end()
    })
    try {
      now += SESSION_LIFETIME_MS + 1
      frames.send({ v: 1, id: 'expired', session, op: 'shell' })
      const refused = await reply
      if (refused && typeof refused === 'object' && 'closed' in refused) expect(refused).toEqual({ closed: true })
      else expect(refused).toMatchObject({ v: 1, id: 'expired', ok: false, error: { code: 'unauthenticated' } })
    } finally { frames.close(); await server.close() }
  })
})

it('negotiates message aliases without breaking legacy event pages or cursors', async () => {
  const rows: import('../../src/shared/threadEvents').StoredThreadEvent[] = [{ seq: 1, threadId: 'synthetic',
    event: { kind: 'message-aliased', at: new Date().toISOString(), messageId: 'native', canonicalId: 'own' } }]
  let publish = (): void => undefined
  const service: HostService = {
    shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'History')
  const session = host.pairing.signSession(paired.clientId)
  const legacy = await rawPeer(server.descriptor.port, session), modern = await rawPeer(server.descriptor.port, session)
  try {
    expect(await legacy.call('hello', { op: 'hello', afterSeq: 0 })).toMatchObject({ ok: true, result: { events: [], latestSeq: 1, hasMore: false } })
    expect(await modern.call('hello', { op: 'hello', afterSeq: 0, accepts: ['message-aliases'] })).toMatchObject({ ok: true, result: { events: rows, latestSeq: 1 } })
    expect(await legacy.call('events', { op: 'events', afterSeq: 0 })).toMatchObject({ ok: true, result: { events: [], latestSeq: 1 } })
    expect(await modern.call('events', { op: 'events', afterSeq: 0 })).toMatchObject({ ok: true, result: { events: rows, latestSeq: 1 } })
    rows.push({ ...rows[0]!, seq: 2 })
    publish()
    await expect.poll(() => legacy.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [], latestSeq: 2 } })
    await expect.poll(() => modern.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [rows[1]], latestSeq: 2 } })
  } finally { legacy.frames.close(); modern.frames.close(); await server.close() }
})

it('drains a pushed catch-up page even when the host never publishes another shell', async () => {
  let rows: import('../../src/shared/threadEvents').StoredThreadEvent[] = []
  let publish = (): void => undefined
  const service: HostService = {
    shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Catch-up')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
  try {
    await client.connect()
    rows = Array.from({ length: 300 }, (_, index) => ({ seq: index + 1, threadId: 'synthetic', event: { kind: 'messages-reset', at: new Date().toISOString() } }))
    publish()
    await expect.poll(() => client.events(0).length).toBe(300)
  } finally { await client.close(); await server.close() }
})

it('keeps a client’s place in the event stream when a shell and its events are too large for one push', async () => {
  let rows: import('../../src/shared/threadEvents').StoredThreadEvent[] = []
  let large = false, publish = (): void => undefined
  // About 11 MB of messages in the shell and 6.4 MB of events: each fits a frame, together they do not.
  const messages = Array.from({ length: 110 }, (_, index) => ({ id: 'm' + index, role: 'assistant' as const, text: 'x'.repeat(100_000), createdAt: new Date().toISOString() }))
  const service: HostService = {
    shell: () => { const state = host.service.shell(); return large ? { ...state, host: { ...state.host, threads: state.host.threads.map((thread, index) => index === 0 ? { ...thread, messages } : thread) } } : state },
    state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  await host.service.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, desktopWindowClient())
  await host.service.command({ type: 'connect', provider: 'codex' }, desktopWindowClient())
  expect(host.service.shell().host.threads.length).toBeGreaterThan(0)
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Large shell')
  const pushErrors: string[] = []
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: message => pushErrors.push(message) }); clients.push(client)
  try {
    await client.connect()
    rows = Array.from({ length: 256 }, (_, index) => ({ seq: index + 1, threadId: 'synthetic', event: { kind: 'message-text-appended', at: new Date().toISOString(), messageId: 'm', appendText: 'y'.repeat(25_000) } }))
    large = true
    publish()
    // The shell goes without its events and says there are more, and the client reads them itself.
    await expect.poll(() => client.events(0).length, { timeout: 10_000 }).toBe(256)
    expect(pushErrors).toEqual([])
  } finally { await client.close(); await server.close() }
})

it('paces shells to what a client drains: one that stops reading is owed the newest shell instead of being closed, and loses no event (#698)', async () => {
  const rows: import('../../src/shared/threadEvents').StoredThreadEvent[] = []
  const rounds = 16
  let round = 0, publish = (): void => undefined
  // About 4 MB of model catalog in every shell, standing in for a large one. Sixteen of them queued for a
  // client that has stopped reading would pass the socket's hard cap of twice the frame limit.
  const catalog = Array.from({ length: 4000 }, (_, index) => ({ id: 'catalog-' + index, provider: 'Fixture', name: 'Catalog model ' + index + ' ' + 'x'.repeat(1000), ready: true }))
  const service: HostService = {
    shell: () => { const state = host.service.shell(); return { ...state, host: { ...state.host, models: [...state.host.models, ...catalog, { id: 'round-' + round, provider: 'Fixture', name: 'Round', ready: true }] } } },
    state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Slow link')
  const session = host.pairing.signSession(paired.clientId)
  const slow = await rawPeer(server.descriptor.port, session), steady = await rawPeer(server.descriptor.port, session)
  const roundOf = (message: Record<string, unknown>): string | undefined => message.event === 'shell'
    ? (message.state as { host: { models: { id: string }[] } }).host.models.find(model => model.id.startsWith('round-'))?.id : undefined
  try {
    await slow.call('hello', { op: 'hello', afterSeq: 0 }); await steady.call('hello', { op: 'hello', afterSeq: 0 })
    slow.stream.pause()
    for (round = 1; round <= rounds; round++) {
      rows.push({ seq: round, threadId: 'synthetic', event: { kind: 'messages-reset', at: new Date().toISOString() } })
      publish()
      // A client that keeps reading is sent this round's shell, so the host has run this publish for every peer.
      await expect.poll(() => steady.messages.some(message => roundOf(message) === 'round-' + round)).toBe(true)
      steady.messages.length = 0
    }
    round = rounds
    slow.stream.resume()
    // The client that stopped reading is still connected, and once it reads again it is sent the newest shell.
    await expect.poll(() => slow.messages.some(message => roundOf(message) === 'round-' + rounds)).toBe(true)
    expect(await slow.call('still-open', { op: 'receipt', commandId: 'none' })).toMatchObject({ ok: true, result: { status: 'unknown' } })
    const shells = slow.messages.filter(message => message.event === 'shell')
    // What was already on its way when it stopped, then the newest it was owed: not a shell a round, and
    // none older after a newer one. How many were on their way depends on the system's socket buffers.
    expect(shells.length).toBeLessThan(rounds / 2)
    const received = shells.map(message => Number(roundOf(message)!.slice('round-'.length)))
    expect(received).toEqual([...received].sort((a, b) => a - b))
    expect(received.at(-1)).toBe(rounds)
    // Its cursor moved only with what was sent, so the shells it did get carry every event, once, in order.
    expect(shells.flatMap(message => (message.eventPage as { events: { seq: number }[] }).events.map(row => row.seq)))
      .toEqual(Array.from({ length: rounds }, (_, index) => index + 1))
    expect(slow.frames.isClosed).toBe(false)
  } finally { slow.frames.close(); steady.frames.close(); await server.close() }
})

it('frees a permission mode by what it allows, not by being listed first', async () => {
  // Devin lists only the modes its CLI reports. Without Accept edits there is no Ask first, and Smart,
  // which lets Devin edit unasked, comes first; it still needs the answer policy.
  const model = { id: 'devin-smart-first', provider: 'Devin', name: 'Devin', ready: true, providerModes: [
    { id: 'smart', name: 'Smart', allows: 'edits' as const }, { id: 'plan', name: 'Plan', allows: 'nothing' as const }] }
  const commands: string[] = []
  const service: HostService = {
    shell: () => { const state = host.service.shell(); return { ...state, host: { ...state.host, models: [...state.host.models, model] } } },
    state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    command: (command, identity) => { if (command.type === 'create-thread') commands.push(command.providerMode ?? ''); return host.service.command(command, identity) },
    events: (afterSeq, threadId, limit) => host.service.events(afterSeq, threadId, limit), subscribe: listener => host.service.subscribe(listener),
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Modes')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
  try {
    await client.connect()
    await expect(client.command({ type: 'create-thread', projectId: 'project', title: 'Smart', modelId: model.id, providerMode: 'smart' })).rejects.toMatchObject({ code: 'forbidden' })
    // Plan allows nothing, so it reaches the host; whether the host can make the thread is its own answer.
    await client.command({ type: 'create-thread', projectId: 'project', title: 'Plan', modelId: model.id, providerMode: 'plan' }).catch(() => undefined)
    expect(commands).toEqual(['plan'])
  } finally { await client.close(); await server.close() }
})

it('keeps no receipts for selections and drops settled ones, so a long-running host is never falsely busy', async () => {
  let now = 1_000_000
  const release: (() => void)[] = []
  const service: HostService = {
    shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
    // An interrupt here stays pending until the test lets it go, standing in for work that is still running.
    command: async (command, identity) => { if (command.type === 'interrupt') await new Promise<void>(resolve => release.push(resolve)); return host.service.command(command, identity) },
    events: (afterSeq, threadId, limit) => host.service.events(afterSeq, threadId, limit), subscribe: listener => host.service.subscribe(listener),
  }
  const server = await startSocketServer({ service, pairing: host.pairing, receipts: new CommandReceipts({ lifetimeMs: 1000, limit: 2, now: () => now }) })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Receipts')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
  try {
    await client.connect()
    // More selections than the cap holds, and none of them counts against it.
    for (let index = 0; index < 3; index++) { await client.command({ type: 'select-project', projectId: 'project' }); await client.command({ type: 'observe-threads', threadIds: [] }) }
    const first = randomUUID(), second = randomUUID(), third = randomUUID()
    await client.command({ type: 'configure', patch: { enabled: false } }, undefined, first)
    await client.command({ type: 'configure', patch: { enabled: true } }, undefined, second)
    // Full of settled receipts: the oldest makes room rather than refusing.
    await client.command({ type: 'configure', patch: { enabled: false } }, undefined, third)
    expect(await client.receipt(first)).toEqual({ status: 'unknown' })
    expect(await client.receipt(third)).toEqual({ status: 'completed' })
    now += 2000
    const pending = [client.command({ type: 'interrupt', threadId: 'missing' }), client.command({ type: 'interrupt', threadId: 'missing' })]
    await expect.poll(() => release.length).toBe(2)
    expect(await client.receipt(second)).toEqual({ status: 'unknown' })
    // Only work that is really still pending fills the host.
    await expect(client.command({ type: 'configure', patch: { enabled: true } })).rejects.toMatchObject({ code: 'busy' })
    for (const resolve of release) resolve()
    await Promise.allSettled(pending)
  } finally { await client.close(); await server.close() }
})

it('coalesces a burst of shell changes and answers a thread or an event page too large for a frame with an error naming it', async () => {
  let publish = (): void => undefined
  const huge = { threadId: 'huge', revision: 1, messages: [{ id: 'm', role: 'assistant' as const, text: 'x'.repeat(17 * 1024 * 1024), createdAt: new Date().toISOString() }] }
  let fits = false
  const service: HostService = {
    shell: () => host.service.shell(), state: () => host.service.state(),
    threadDetail: id => id === 'huge' ? (fits ? { ...huge, revision: 2, messages: [] } : huge) : host.service.threadDetail(id),
    command: (command, identity) => host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => threadId === 'huge'
      ? [{ seq: afterSeq + 1, threadId, event: { kind: 'message-text-appended' as const, at: new Date().toISOString(), messageId: 'm', appendText: 'x'.repeat(17 * 1024 * 1024) } }]
      : host.service.events(afterSeq, threadId, limit),
    subscribe: listener => { publish = () => listener(host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: host.pairing })
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Bursts')
  const pushErrors: (string | null)[] = []
  let connected = true
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: message => pushErrors.push(message),
    onPushErrorCleared: () => pushErrors.push(null), onConnectionChange: value => { connected = value } }); clients.push(client)
  try {
    await client.connect()
    let shells = 0
    client.subscribe(() => { shells++ })
    for (let index = 0; index < 50; index++) publish()
    // One leading push and one trailing push carry the whole burst. Any push beyond them would have left
    // before the trailing one, and a later round trip arrives after every push the host sent before it.
    await expect.poll(() => shells).toBe(2)
    await client.receipt('burst-settled')
    expect(shells).toBe(2)
    await client.observe(['huge'])
    await expect.poll(() => pushErrors).toEqual([expect.stringContaining('too large to send to this device')])
    await expect(client.readThreadDetail('huge')).rejects.toMatchObject({ code: 'too_large', message: expect.stringContaining('A thread on this host') })
    // An event page is part of the thread list's stream, not one thread's detail, and its error says so.
    await expect(client.readEvents(0, 'huge')).rejects.toMatchObject({ code: 'too_large', message: expect.stringContaining('The thread list') })
    expect(connected).toBe(true)
    // Shell pushes carry on meanwhile and do not clear a thread's error; that thread arriving does.
    publish()
    await expect.poll(() => shells).toBe(3)
    expect(pushErrors.at(-1)).not.toBeNull()
    fits = true
    await client.readThreadDetail('huge')
    expect(pushErrors.at(-1)).toBeNull()
  } finally { await client.close(); await server.close() }
})


describe('thread detail over the socket', () => {
  const message = (text: string) => ({ id: 'reply', role: 'assistant' as const, text, createdAt: '2026-09-23T00:00:00.000Z' })
  const delta = (baseRevision: number, revision: number, appendText: string): AgentThreadDetailDelta => ({ threadId: 'streaming', baseRevision, revision, messageDeltas: [{ id: 'reply', appendText }], activityDeltas: [] })
  /**
   * A service whose two threads' histories the test sets, and whose detail stream the test drives. Like the
   * coordinator, it publishes a thread whole the moment some client starts observing it, and forgets what it
   * published once nobody does.
   */
  async function streamingHost() {
    const stream: { current: AgentThreadDetail; quiet: AgentThreadDetail; reads: number; emit: (update: AgentThreadDetailUpdate) => void } = { current: { threadId: 'streaming', revision: 1, messages: [message('Hello')] },
      quiet: { threadId: 'quiet', revision: 1, messages: [message('Quiet')] }, reads: 0, emit: () => undefined }
    const published = new Set<string>()
    const service: HostService = {
      shell: () => host.service.shell(), state: () => host.service.state(),
      threadDetail: id => {
        if (id === 'quiet') return structuredClone(stream.quiet)
        if (id !== 'streaming') return host.service.threadDetail(id)
        stream.reads++; return structuredClone(stream.current)
      },
      command: (command, identity) => {
        if (command.type === 'observe-threads') {
          const targets: string[] = command.threadIds.filter(id => id === 'streaming' || id === 'quiet')
          for (const id of [...published]) if (!targets.includes(id)) published.delete(id)
          for (const id of targets) if (!published.has(id)) { published.add(id); stream.emit(service.threadDetail(id)!) }
        }
        return host.service.command(command, identity)
      },
      events: (afterSeq, threadId, limit) => host.service.events(afterSeq, threadId, limit), subscribe: listener => host.service.subscribe(listener),
      subscribeThreadDetail: listener => { stream.emit = listener; return () => undefined },
    }
    const server = await startSocketServer({ service, pairing: host.pairing })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Streaming')
    const pushErrors: (string | null)[] = []
    let connected = true
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: text => pushErrors.push(text),
      onPushErrorCleared: () => pushErrors.push(null), onConnectionChange: value => { connected = value } }); clients.push(client)
    await client.connect()
    const updates: AgentThreadDetailUpdate[] = []
    client.subscribeThreadDetail(update => updates.push(update))
    await client.observe(['streaming'])
    expect(client.threadDetail('streaming')?.revision).toBe(1)
    return { stream, server, client, updates, pushErrors, connected: () => connected, session: () => host.pairing.signSession(paired.clientId) }
  }

  it('stops materialising observed details after the peer closes while waiting for drain', async () => {
    const { client } = await pair()
    await client.command({ type: 'connect', provider: 'codex' })
    const ids = client.shell().host.threads.slice(0, 2).map(thread => thread.id)
    const details = vi.spyOn(host.service, 'threadDetail')
    const drain = vi.spyOn(SocketFrames.prototype, 'drained').mockImplementation(function (this: SocketFrames) {
      this.close(); return Promise.resolve()
    })
    try {
      await expect(client.observe(ids)).rejects.toMatchObject({ code: 'disconnected' })
      expect(drain).toHaveBeenCalled()
      expect(details).not.toHaveBeenCalled()
    } finally { drain.mockRestore(); details.mockRestore() }
  })
  it('receives each observed detail once on reconnect', async () => {
    const { stream, server, client } = await streamingHost()
    try {
      const reads = stream.reads
      await client.close()
      await client.connect()
      expect(stream.reads).toBe(reads + 1)
      expect(client.threadDetail('streaming')?.revision).toBe(1)
    } finally { await client.close(); await server.close() }
  })

  it('sends a thread whole once when a client starts observing it, and not again while it holds it (#700)', async () => {
    const { stream, server, session } = await streamingHost()
    const phone = await rawPeer(server.descriptor.port, session())
    const wholes = (threadId: string) => phone.messages.filter(item => item.event === 'detail' && item.threadId === threadId)
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      // Nobody observed this thread: the service publishes it whole as the phone starts observing it, and that is the only copy.
      await phone.call('observe-quiet', { op: 'observe', threadIds: ['quiet'] })
      expect(wholes('quiet')).toHaveLength(1)
      // Adding a thread sends only that thread, and one the phone already holds is not sent again.
      await phone.call('observe-both', { op: 'observe', threadIds: ['quiet', 'streaming'] })
      expect(wholes('quiet')).toHaveLength(1)
      expect(wholes('streaming')).toHaveLength(1)
      // Opening the same thread again sends nothing, and the read the phone makes when it holds no copy still answers whole.
      await phone.call('observe-again', { op: 'observe', threadIds: ['quiet', 'streaming'] })
      expect(phone.messages.filter(item => item.event === 'detail')).toHaveLength(2)
      expect(await phone.call('read', { op: 'detail', threadId: 'streaming' })).toMatchObject({ ok: true, result: stream.current })
      // A thread let go and observed again is sent whole again: nothing kept it current in between.
      await phone.call('observe-one', { op: 'observe', threadIds: ['streaming'] })
      await phone.call('observe-back', { op: 'observe', threadIds: ['streaming', 'quiet'] })
      expect(wholes('quiet')).toHaveLength(2)
      expect(wholes('streaming')).toHaveLength(1)
    } finally { phone.frames.close(); await server.close() }
  })

  it('does not send a thread whole a second time when the copy published as it was observed was still waiting to go (#700)', async () => {
    const { stream, server, session } = await streamingHost()
    const phone = await rawPeer(server.descriptor.port, session())
    const wholes = () => phone.messages.filter(item => item.event === 'detail' && item.threadId === 'quiet')
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // The thread was published a moment ago, so what the service publishes as the phone observes it waits for the window to close.
      stream.emit(structuredClone(stream.quiet))
      await phone.call('observe', { op: 'observe', threadIds: ['quiet'] })
      expect(wholes()).toHaveLength(1)
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      // A delta published after the waiting copy goes out behind it, so its arrival shows the copy was not sent.
      stream.quiet = { threadId: 'quiet', revision: 2, messages: [message('Quiet now')] }
      stream.emit({ threadId: 'quiet', baseRevision: 1, revision: 2, messageDeltas: [{ id: 'reply', appendText: ' now' }], activityDeltas: [] })
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      vi.useRealTimers()
      await expect.poll(() => phone.messages.some(item => item.event === 'detail-delta' && item.threadId === 'quiet')).toBe(true)
      expect(wholes()).toHaveLength(1)
    } finally { vi.useRealTimers(); phone.frames.close(); await server.close() }
  })

  it('sends a thread whole once to a client that starts observing it while another client\'s whole copy is still waiting to go (#700)', async () => {
    // Every coalescing window stays open until the test closes it, from the first copy the desktop client is sent.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { stream, server, client, session } = await streamingHost()
    const phone = await rawPeer(server.descriptor.port, session())
    const wholes = () => phone.messages.filter(item => item.event === 'detail' && item.threadId === 'streaming')
    try {
      await phone.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      // The desktop client already observes the thread, so observing it publishes nothing. The thread went out a moment
      // ago and was then rewritten, so its whole copy is waiting to go.
      stream.emit(structuredClone(stream.current))
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Rewritten')] }
      stream.emit(structuredClone(stream.current))
      await phone.call('observe', { op: 'observe', threadIds: ['streaming'] })
      expect(wholes()).toEqual([expect.objectContaining({ detail: stream.current })])
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(2)
      // A delta published after the waiting copy goes out behind it, so its arrival shows the copy was not sent again.
      stream.current = { threadId: 'streaming', revision: 3, messages: [message('Rewritten!')] }
      stream.emit(delta(2, 3, '!'))
      vi.advanceTimersByTime(AGENT_STATE_PUBLISH_INTERVAL_MS)
      vi.useRealTimers()
      await expect.poll(() => phone.messages.some(item => item.event === 'detail-delta' && item.threadId === 'streaming')).toBe(true)
      expect(wholes()).toHaveLength(1)
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(3)
    } finally { vi.useRealTimers(); phone.frames.close(); await client.close(); await server.close() }
  })

  it('pushes what changed as a delta the client applies and passes on, and the whole thread to a client that never asked for deltas', async () => {
    const { stream, server, client, updates, session } = await streamingHost()
    try {
      const reads = stream.reads
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello, world')] }
      stream.emit(delta(1, 2, ', world'))
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe('Hello, world')
      expect(client.threadDetail('streaming')?.revision).toBe(2)
      // The window gets the same delta to apply to the revision it holds, and the host read no whole thread.
      expect(updates.at(-1)).toEqual(delta(1, 2, ', world'))
      expect(stream.reads).toBe(reads)

      // A client from before the freeze says nothing about deltas in its hello, and keeps getting whole threads.
      const legacy = await rawPeer(server.descriptor.port, session())
      try {
        // This detail-only service has no native Check implementation, so it must not advertise answer-check.
        expect(await legacy.call('hello', { op: 'hello', afterSeq: 0 })).toMatchObject({ ok: true, result: { sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts'] } })
        await legacy.call('observe', { op: 'observe', threadIds: ['streaming'] })
        stream.current = { threadId: 'streaming', revision: 3, messages: [message('Hello, world!')] }
        stream.emit(delta(2, 3, '!'))
        await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(3)
        await expect.poll(() => legacy.messages.some(item => item.event === 'detail' && (item.detail as AgentThreadDetail).revision === 3)).toBe(true)
        expect(legacy.messages.some(item => item.event === 'detail-delta')).toBe(false)
        expect(updates.at(-1)).toEqual(delta(2, 3, '!'))
      } finally { legacy.frames.close() }
    } finally { await client.close(); await server.close() }
  })

  it('sends activity summaries to a client that accepts them, in every detail, delta and detail answer, and whole records to one that does not (#701)', async () => {
    const at = '2026-09-23T00:00:00.000Z'
    const running: AgentActivity = { id: 'build', turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Run the build',
      command: 'npm run build', cwd: '/synthetic/project', output: 'compiled '.repeat(2_000), startedAt: at, timingSource: 'observed' }
    const activities: AgentActivity[] = [
      { id: 'turn', turnId: 'turn', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
      running,
      { id: 'edit', turnId: 'turn', sequence: 2, kind: 'file-change', status: 'completed', title: 'Edited two files', afterMessageId: 'reply',
        changes: [{ path: 'src/a.ts', kind: 'update', diff: '+a\n'.repeat(500) }, { path: 'src/b.ts', kind: 'add', diff: '+b\n'.repeat(500) }], durationMs: 40 },
      { id: 'think', turnId: 'turn', sequence: 3, kind: 'reasoning', status: 'completed', title: 'Thinking', text: 'considered '.repeat(500) },
      { id: 'plan', turnId: 'turn', sequence: 4, kind: 'plan', status: 'completed', title: 'Plan', steps: [{ text: 'Build it', status: 'running' }] },
      { id: 'agents', turnId: 'turn', sequence: 5, kind: 'subagent', status: 'failed', title: 'Reviewers', error: 'One reviewer stopped.', parentId: 'turn',
        agents: [{ id: 'reviewer', status: 'failed', message: 'review notes '.repeat(200), prompt: 'Review the change' }], context: { before: 1000, after: 400 } },
      { id: 'test', turnId: 'turn', sequence: 6, kind: 'command', status: 'failed', title: 'Run the tests', command: 'npm test', output: 'FAIL '.repeat(1_000),
        error: 'Exit 1', exitCode: 1, durationMs: 1234.5, startedAt: at, completedAt: at },
    ]
    /** What a summary row reads, and nothing else. */
    const summary = (record: AgentActivity) => {
      const kept: Record<string, unknown> = { id: record.id, turnId: record.turnId, sequence: record.sequence, kind: record.kind, status: record.status, title: record.title }
      for (const key of ['command', 'exitCode', 'durationMs', 'startedAt'] as const) if (record[key] !== undefined) kept[key] = record[key]
      if (record.changes) kept.changes = record.changes.map(change => ({ path: change.path, kind: change.kind }))
      return kept
    }
    /** Fields a summary row never reads, checked on the activity alone: a message has text of its own. */
    const bodies = ['text', 'output', 'error', 'cwd', 'diff', 'steps', 'agents', 'context', 'completedAt', 'timingSource', 'parentId', 'afterMessageId']
    const carriesNoBodies = (value: unknown) => { for (const key of bodies) expect(JSON.stringify(value)).not.toContain(`"${key}":`) }
    const { stream, server, client, session } = await streamingHost()
    const summaries = await rawPeer(server.descriptor.port, session())
    const wholePeer = await rawPeer(server.descriptor.port, session())
    // A client may take summaries without deltas: it is sent each change as a whole detail of summaries.
    const summariesNoDeltas = await rawPeer(server.descriptor.port, session())
    const peers = [summaries, wholePeer, summariesNoDeltas]
    try {
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello')], activities }
      await summaries.call('hello', { op: 'hello', accepts: ['detail-delta', 'activity-summaries'] })
      await wholePeer.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      await summariesNoDeltas.call('hello', { op: 'hello', accepts: ['activity-summaries'] })
      for (const peer of peers) await peer.call('observe', { op: 'observe', threadIds: ['streaming'] })
      const detailPush = (peer: typeof summaries, revision: number) => peer.messages.find(item => item.event === 'detail' && (item.detail as AgentThreadDetail).revision === revision)
      const summarised = (detail: AgentThreadDetail) => ({ ...detail, activities: detail.activities!.map(summary) })
      // The detail each observer is sent on observing.
      for (const peer of [summaries, summariesNoDeltas]) {
        const pushed = detailPush(peer, 2)!
        expect(hostPushSchema.parse(pushed)).toEqual(pushed)
        expect(pushed.detail).toEqual(summarised(stream.current))
        carriesNoBodies((pushed.detail as AgentThreadDetail).activities)
        for (const record of (pushed.detail as AgentThreadDetail).activities!) expect(agentActivitySchema.parse(record)).toEqual(record)
      }
      expect(detailPush(wholePeer, 2)!.detail).toEqual(stream.current)

      // The running command's output grew and the plan went. The record goes as its summary to the client that accepts
      // summaries and whole to the one that does not; the revisions are the same, so both apply it.
      const grown: AgentActivity = { ...running, output: running.output + 'linked '.repeat(1_000) }
      stream.current = { ...stream.current, revision: 3, activities: activities.filter(record => record.id !== 'plan').map(record => record.id === 'build' ? grown : record) }
      stream.emit({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [], activityDeltas: [{ record: grown }, { id: 'plan', removed: true }] })
      const deltaPush = (peer: typeof summaries) => peer.messages.find(item => item.event === 'detail-delta' && (item.delta as AgentThreadDetailDelta).revision === 3)
      await expect.poll(() => deltaPush(summaries)).toBeTruthy()
      await expect.poll(() => deltaPush(wholePeer)).toBeTruthy()
      expect(hostPushSchema.parse(deltaPush(summaries))).toEqual(deltaPush(summaries))
      expect(deltaPush(summaries)!.delta).toEqual({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [], activityDeltas: [{ record: summary(grown) }, { id: 'plan', removed: true }] })
      carriesNoBodies((deltaPush(summaries)!.delta as AgentThreadDetailDelta).activityDeltas)
      expect(deltaPush(wholePeer)!.delta).toEqual({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [], activityDeltas: [{ record: grown }, { id: 'plan', removed: true }] })
      await expect.poll(() => detailPush(summariesNoDeltas, 3)).toBeTruthy()
      expect(detailPush(summariesNoDeltas, 3)!.detail).toEqual(summarised(stream.current))
      // The desktop's own client never asks for summaries and keeps every record whole.
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(3)
      expect(client.threadDetail('streaming')).toEqual(stream.current)

      // A whole detail the service publishes, and the detail a client reads, follow the same rule.
      stream.current = { ...stream.current, revision: 4 }
      stream.emit(stream.current)
      await expect.poll(() => detailPush(summaries, 4)).toBeTruthy()
      await expect.poll(() => detailPush(wholePeer, 4)).toBeTruthy()
      expect(detailPush(summaries, 4)!.detail).toEqual(summarised(stream.current))
      expect(detailPush(wholePeer, 4)!.detail).toEqual(stream.current)
      expect((await summaries.call('read', { op: 'detail', threadId: 'streaming' })).result).toEqual(summarised(stream.current))
      expect((await wholePeer.call('read', { op: 'detail', threadId: 'streaming' })).result).toEqual(stream.current)
      expect(await client.readThreadDetail('streaming')).toEqual(stream.current)
    } finally { for (const peer of peers) peer.frames.close(); await client.close(); await server.close() }
  })

  it('delivers saved long messages in whole details and replacement deltas and reopens without disconnecting', async () => {
    const { stream, server, client, connected, pushErrors } = await streamingHost()
    const store = new ThreadStore(join(root, 'long-replies.sqlite'))
    store.open()
    const text = 'a'.repeat(200_001)
    const replacement = 'b'.repeat(300_001)
    const save = (kind: 'message-added' | 'message-replaced', text: string) => {
      store.appendMany('streaming', [
        { kind, at: message('').createdAt, message: message(text.slice(0, 100_000)) },
        ...Array.from({ length: Math.ceil(text.length / 100_000) - 1 }, (_, index) => ({
          kind: 'message-text-appended' as const, at: message('').createdAt, messageId: 'reply', appendText: text.slice((index + 1) * 100_000, (index + 2) * 100_000),
        })),
      ])
    }
    try {
      save('message-added', text)
      stream.current = { threadId: 'streaming', revision: 2, messages: store.readMessages('streaming').messages }
      stream.emit(stream.current)
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe(text)
      save('message-replaced', replacement)
      stream.current = { threadId: 'streaming', revision: 3, messages: store.readMessages('streaming').messages }
      stream.emit({ threadId: 'streaming', baseRevision: 2, revision: 3, messageDeltas: [{ message: stream.current.messages[0]! }], activityDeltas: [] })
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe(replacement)
      expect(connected()).toBe(true)
      expect(pushErrors).toEqual([])
      const suffix = 'c'.repeat(150_001)
      stream.current = { ...stream.current, revision: 4, messages: [message(replacement + suffix)] }
      stream.emit(delta(3, 4, suffix))
      await expect.poll(() => client.threadDetail('streaming')?.messages[0]?.text).toBe(replacement + suffix)
      expect(connected()).toBe(true)
      store.close()
      store.open()
      store.rebuild()
      stream.current = { ...stream.current, messages: store.readMessages('streaming').messages }
      await client.close()
      await client.connect()
      await client.observe(['streaming'])
      expect((await client.readThreadDetail('streaming'))?.messages[0]?.text).toBe(replacement)
      expect(connected()).toBe(true)
      expect(pushErrors).toEqual([])
    } finally { store.close(); await client.close(); await server.close() }
  })

  it('reads the whole thread once when a delta does not follow the revision the client holds', async () => {
    const { stream, server, client, updates } = await streamingHost()
    try {
      const reads = stream.reads
      // The client holds revision 1 and never saw 1 to 3: neither delta applies, and one read catches it up.
      stream.current = { threadId: 'streaming', revision: 5, messages: [message('Hello, world, again')] }
      stream.emit(delta(3, 4, ', world'))
      stream.emit(delta(4, 5, ', again'))
      await expect.poll(() => client.threadDetail('streaming')?.revision).toBe(5)
      expect(client.threadDetail('streaming')?.messages[0]?.text).toBe('Hello, world, again')
      await client.receipt('settled')
      expect(stream.reads).toBe(reads + 1)
      // What the window is given is the whole thread it can hold, not a delta it cannot follow either.
      expect(updates.at(-1)).toEqual(stream.current)
    } finally { await client.close(); await server.close() }
  })

  it('finishes a reconnect with an observed thread too large to send, reporting the thread instead of failing the connection', async () => {
    const { stream, server, client, pushErrors, connected } = await streamingHost()
    try {
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello' + 'x'.repeat(17 * 1024 * 1024))] }
      await client.close()
      // Failing here would have the desktop retry, and read the same thread whole, for as long as it stayed too large.
      await client.connect()
      expect(connected()).toBe(true)
      expect(pushErrors.at(-1)).toEqual(expect.stringContaining('A thread on this host is too large to send to this device'))
      expect(await client.receipt('still-open')).toEqual({ status: 'unknown' })
    } finally { await client.close(); await server.close() }
  })

  it('answers a delta too large for a frame with an error naming its thread, and does not ask for that thread again until it is observed again', async () => {
    const { stream, server, client, pushErrors, connected, session } = await streamingHost()
    // A second peer accepting deltas shows when the host has sent one: it sends to every peer in the same pass.
    const witness = await rawPeer(server.descriptor.port, session())
    try {
      await witness.call('hello', { op: 'hello', accepts: ['detail-delta'] })
      await witness.call('observe', { op: 'observe', threadIds: ['streaming'] })
      const reads = stream.reads
      const huge = 'x'.repeat(17 * 1024 * 1024)
      stream.current = { threadId: 'streaming', revision: 2, messages: [message('Hello' + huge)] }
      stream.emit(delta(1, 2, huge))
      await expect.poll(() => pushErrors).toEqual([expect.stringContaining('A thread on this host is too large to send to this device')])
      expect(witness.messages).toContainEqual(expect.objectContaining({ event: 'error', threadId: 'streaming', error: expect.objectContaining({ code: 'too_large' }) }))
      // The next delta fits, but follows a revision the client never got; the whole thread would not fit either.
      stream.current = { threadId: 'streaming', revision: 3, messages: [message('Hello' + huge + '!')] }
      stream.emit(delta(2, 3, '!'))
      await expect.poll(() => witness.messages.some(item => item.event === 'detail-delta' && (item.delta as AgentThreadDetailDelta).revision === 3)).toBe(true)
      await client.receipt('settled')
      expect(stream.reads).toBe(reads)
      expect(pushErrors).toHaveLength(1)
      expect(connected()).toBe(true)
      // Observing the thread again sends it whole, and once it fits the error clears.
      stream.current = { threadId: 'streaming', revision: 4, messages: [message('Short again')] }
      await client.observe(['streaming'])
      expect(client.threadDetail('streaming')?.revision).toBe(4)
      expect(pushErrors.at(-1)).toBeNull()
    } finally { witness.frames.close(); await client.close(); await server.close() }
  })
})

describe('staged images over the socket (ADR-0031)', () => {
  it('stages an image on the host that runs the thread, sends the handle with the draft, and hands the bytes back by digest', async () => {
    const { client } = await pair()
    const bytes = Buffer.alloc(300 * 1024, 3); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
    const dimensions = { original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } }
    const handle = await client.stageAttachment({ name: 'Remote.png', mimeType: 'image/png', bytes, dimensions })
    expect(handle).toMatchObject({ name: 'Remote.png', mimeType: 'image/png', sizeBytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), dimensions })
    // The content is the host's, in its own data folder; the desktop keeps none of it.
    expect(await readFile(join(root, 'attachments', `${handle.digest}.png`))).toEqual(bytes)
    await client.command({ type: 'configure', patch: { enabledProviders: ['codex'], provider: 'codex' } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads[0]!.id
    const state = await client.command({ type: 'save-thread-draft', threadId, draftId: randomUUID(), text: 'Look', attachments: [handle], requestId: null })
    expect(state.threadDrafts).toEqual([expect.objectContaining({ threadId, attachments: [handle] })])
    expect(JSON.stringify(client.shell())).not.toContain(bytes.toString('base64').slice(0, 200))
    const content = await client.attachmentContent(handle.digest)
    expect(content?.mimeType).toBe('image/png'); expect(Buffer.from(content!.bytes)).toEqual(bytes)
    expect(await client.attachmentContent('f'.repeat(64))).toBeNull()
    // After a reload a draft's chips ask for their images at once. The host answers one such frame at a time per
    // device, as it does previews, and the client queues them behind one another, so none is refused as busy.
    const many = await Promise.all(Array.from({ length: 4 }, () => client.attachmentContent(handle.digest)))
    expect(many.map(item => item?.bytes.byteLength)).toEqual(Array(4).fill(bytes.length))
    // Staging takes the same one-at-a-time guard, and the client queues it with the reads, so several at once all land.
    const staged = await Promise.all(Array.from({ length: 3 }, (_, index) => {
      const each = Buffer.from(bytes); each[bytes.length - 1] = index
      return client.stageAttachment({ name: `Remote ${index}.png`, mimeType: 'image/png', bytes: each })
    }).concat([client.attachmentContent(handle.digest).then(() => handle)]))
    expect(new Set(staged.map(item => item.digest)).size).toBe(4)
    // Content that is not the image it claims is refused on the host, whoever sent it, and the desktop is told why.
    await expect(client.stageAttachment({ name: 'Fake.png', mimeType: 'image/png', bytes: Buffer.from('<svg/>') })).rejects.toMatchObject({ code: 'invalid_request', message: SCREENSHOT_NOT_ITS_TYPE })
  })
})

describe('host version and features', () => {
  it('advertises the Sotto version and features in health, the listener file and the hello reply', async () => {
    const health = await (await fetch(url + '/v1/health')).json() as Record<string, unknown>
    expect(health).toMatchObject({ v: 1, status: 'ready', sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions'] })
    const listener = JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as Record<string, unknown>
    expect(listener).toMatchObject({ v: 1, sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions'] })
    const { client } = await pair()
    expect(await client.connect()).toMatchObject({ sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions'], capabilities: { mayAnswer: false } })
  })

  it('runs client updates only where it offers them: the headless host does, the phone listener does not (#480)', async () => {
    const { client } = await pair()
    expect(client.offersClientUpdates()).toBe(true)
    // The command reaches the host, which refuses it in words: nothing has been checked here yet.
    expect((await client.command({ type: 'queue-client-updates', providers: ['codex'] })).error).toBe('Sotto has not checked Codex yet. Check again, then update it.')
    const phone = await startSocketServer({ service: host.service, pairing: host.pairing })
    try {
      expect(phone.descriptor.features).not.toContain('client-updates')
      const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'iPhone')
      const other = new SocketHostService({ url: 'http://127.0.0.1:' + phone.descriptor.port, token: paired.token }); clients.push(other)
      await other.connect()
      expect(other.offersClientUpdates()).toBe(false)
      await expect(other.command({ type: 'queue-client-updates', providers: ['codex'] })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(other.command({ type: 'cancel-client-updates', providers: ['codex'] })).rejects.toMatchObject({ code: 'forbidden' })
    } finally { await phone.close() }
  })

  it('sends the mise channel and the waiting state only to a client that accepts client-updates, and the rest as it knew them (#480)', async () => {
    const reading = { id: 'codex' as const, installed: '0.155.1', published: '0.158.0', behind: true, channel: 'mise' as const, command: 'mise upgrade codex',
      canInstall: true, checkedAt: '2026-09-29T12:00:00.000Z', state: 'queued' as const }
    const service: HostService = {
      shell: () => ({ ...host.service.shell(), clientUpdates: [reading] }), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
    }
    // A client accepts client-updates in its hello when the host lists it; one from before #480, or the iPhone client, never does.
    for (const [offered, expected] of [[true, { channel: 'mise', state: 'queued' }], [false, { channel: 'unknown', state: 'idle' }]] as const) {
      const server = await startSocketServer({ service, pairing: host.pairing, clientUpdates: offered })
      try {
        const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, offered ? 'Desktop' : 'Older desktop')
        const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
        await client.connect()
        expect(client.shell().clientUpdates, String(offered)).toEqual([expect.objectContaining(expected)])
      } finally { await server.close() }
    }
  })

  it('keeps the version sentence for an unreadable push from a host of another version when a thread once too large arrives', async () => {
    const message = (text: string) => ({ id: 'reply', role: 'assistant' as const, text, createdAt: '2026-09-23T00:00:00.000Z' })
    let current: AgentThreadDetail = { threadId: 'streaming', revision: 1, messages: [message('Hello')] }
    let emitDetail: (update: AgentThreadDetailUpdate) => void = () => undefined
    let emitShell: (state: ReturnType<HostService['shell']>) => void = () => undefined
    let unreadableShell = false
    const service: HostService = {
      // What a later host might send: a shell this client cannot read.
      shell: () => unreadableShell ? { ...host.service.shell(), host: 'a later shape' } as unknown as ReturnType<HostService['shell']> : host.service.shell(),
      state: () => host.service.state(),
      threadDetail: id => id === 'streaming' ? structuredClone(current) : host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity),
      events: (afterSeq, threadId, limit) => host.service.events(afterSeq, threadId, limit),
      subscribe: listener => { emitShell = listener; return () => undefined },
      subscribeThreadDetail: listener => { emitDetail = listener; return () => undefined },
    }
    const server = await startSocketServer({ service, pairing: host.pairing, sottoVersion: '0.0.1' })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Older host')
    const pushErrors: (string | null)[] = []
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, owned: true,
      onPushError: text => pushErrors.push(text), onPushErrorCleared: () => pushErrors.push(null) }); clients.push(client)
    try {
      await client.connect()
      await client.observe(['streaming'])
      current = { threadId: 'streaming', revision: 2, messages: [message('Hello' + 'x'.repeat(17 * 1024 * 1024))] }
      emitDetail(current)
      await expect.poll(() => pushErrors.at(-1)).toEqual(expect.stringContaining('A thread on this host is too large'))
      unreadableShell = true
      emitShell(host.service.shell())
      const mismatch = hostVersionMismatch(packageVersion, '0.0.1', true)
      await expect.poll(() => pushErrors.at(-1)).toBe(mismatch)
      // The thread that was too large arrives again; the skew is still there, so the sentence stays.
      current = { threadId: 'streaming', revision: 3, messages: [message('Short again')] }
      await client.observe(['streaming'])
      expect(client.threadDetail('streaming')?.revision).toBe(3)
      expect(pushErrors.at(-1)).toBe(mismatch)
    } finally { await client.close(); await server.close() }
  })

  it('refuses a request it cannot read by its id, and a client of another version names the version instead', async () => {
    const unreadable = { type: 'a-command-from-a-later-version', threadId: 'thread' } as unknown as AgentCommand
    // The same version: the request is refused as unsupported, and the socket stays open.
    const { client } = await pair()
    await expect(client.command(unreadable)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('This request is not supported') })
    expect(await client.receipt('still-open')).toEqual({ status: 'unknown' })
    // A host of another version: the same refusal is version skew, and says which side to bring up to date.
    const server = await startSocketServer({ service: host.service, pairing: host.pairing, sottoVersion: '0.0.1' })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Older host')
    const skewed = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(skewed)
    try {
      expect((await skewed.connect()).sottoVersion).toBe('0.0.1')
      await expect(skewed.command(unreadable)).rejects.toMatchObject({ code: 'version_mismatch', message: hostVersionMismatch(packageVersion, '0.0.1', false) })
      expect(await skewed.receipt('still-open')).toEqual({ status: 'unknown' })
    } finally { await skewed.close(); await server.close() }
  })
})

describe('model catalog revisions (#699)', () => {
  /** A host whose shell lists `models()`, rebuilt into new arrays on every read the way the coordinator's shell is. */
  function catalogHost(models: () => AgentModel[], large: () => boolean = () => false) {
    let publish = (): void => undefined
    const huge = [{ id: 'huge', role: 'assistant' as const, text: 'x'.repeat(17 * 1024 * 1024), createdAt: new Date().toISOString() }]
    const service: HostService = {
      shell: () => {
        const state = host.service.shell()
        const threads = large() ? [{ id: 'huge', projectId: 'project', title: 'Huge', modelId: 'fixture-model', status: 'idle' as const, messages: huge, requests: [] }] : state.host.threads
        return { ...state, host: { ...state.host, threads, models: structuredClone(models()) } }
      },
      state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity), events: () => [],
      subscribe: listener => { publish = () => listener(service.shell()); return () => undefined },
    }
    return { service, publish: () => publish() }
  }
  type Frame = Record<string, unknown> & { result?: { host?: Record<string, unknown>; shell?: { host: Record<string, unknown> } }; state?: { host: Record<string, unknown> } }
  /** The host of the first shell push `peer` receives after `send`, or the error push sent in its place. */
  async function nextShell(peer: Awaited<ReturnType<typeof rawPeer>>, send: () => void): Promise<Record<string, unknown>> {
    const from = peer.messages.length
    const arrived = () => peer.messages.slice(from).find(message => message.event === 'shell' || message.event === 'error') as Frame | undefined
    send()
    await expect.poll(arrived).toBeDefined()
    const frame = arrived()!
    return frame.event === 'shell' ? frame.state!.host : frame
  }

  it('sends an accepting client the catalog once per revision, again when it changes and on a fresh connection, and every other client the whole catalog', async () => {
    let models = syntheticModelCatalog(5)
    const { service, publish } = catalogHost(() => models)
    const server = await startSocketServer({ service, pairing: host.pairing })
    expect(server.descriptor.features).toContain('model-catalog-revision')
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'iPhone')
    const session = host.pairing.signSession(paired.clientId)
    const phone = await rawPeer(server.descriptor.port, session), older = await rawPeer(server.descriptor.port, session)
    let fresh: Awaited<ReturnType<typeof rawPeer>> | undefined
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['detail-delta', 'model-catalog-revision'] }) as Frame
      expect(hello.result!.shell!.host).toMatchObject({ models, modelsRevision: expect.any(Number) })
      const first = hello.result!.shell!.host.modelsRevision as number
      const olderHello = await older.call('hello', { op: 'hello', accepts: ['detail-delta'] }) as Frame
      expect(olderHello.result!.shell!.host.models).toEqual(models)
      expect(olderHello.result!.shell!.host).not.toHaveProperty('modelsRevision')

      // Unchanged: every shell names the revision and leaves the catalog out, push, read and command answer alike.
      const pushed = await nextShell(phone, publish)
      expect(pushed).toMatchObject({ modelsRevision: first }); expect(pushed).not.toHaveProperty('models')
      const read = await phone.call('read', { op: 'shell' }) as Frame
      expect(read.result!.host).toMatchObject({ modelsRevision: first }); expect(read.result!.host).not.toHaveProperty('models')
      const answered = await phone.call('select', { op: 'command', command: { type: 'select-project', projectId: 'project' } }) as Frame
      expect(answered).toMatchObject({ ok: true }); expect(answered.result!.host).toMatchObject({ modelsRevision: first })
      expect(answered.result!.host).not.toHaveProperty('models')

      // A client that did not accept the feature is sent exactly what v1 sends: the whole catalog, every time.
      const olderPush = await nextShell(older, publish)
      expect(olderPush.models).toEqual(models); expect(olderPush).not.toHaveProperty('modelsRevision')
      const olderAnswer = await older.call('select', { op: 'command', command: { type: 'select-project', projectId: 'project' } }) as Frame
      expect(olderAnswer.result!.host!.models).toEqual(models); expect(olderAnswer.result!.host).not.toHaveProperty('modelsRevision')

      // A changed catalog goes whole once, under a new revision, then is named again.
      models = syntheticModelCatalog(6)
      const changed = await nextShell(phone, publish)
      expect(changed.models).toEqual(models)
      const second = changed.modelsRevision as number
      expect(second).toBeGreaterThan(first)
      const repeat = await nextShell(phone, publish)
      expect(repeat).toMatchObject({ modelsRevision: second }); expect(repeat).not.toHaveProperty('models')

      // A new connection starts with nothing recorded, so its hello carries the catalog whole.
      fresh = await rawPeer(server.descriptor.port, session)
      const again = await fresh.call('hello', { op: 'hello', accepts: ['model-catalog-revision'] }) as Frame
      expect(again.result!.shell!.host).toMatchObject({ models, modelsRevision: second })
    } finally { phone.frames.close(); older.frames.close(); fresh?.frames.close(); await server.close() }
  })

  it('records a catalog as sent only once a frame carrying it was written, not when too_large went in its place', async () => {
    let models = syntheticModelCatalog(3), large = false
    const { service, publish } = catalogHost(() => models, () => large)
    const server = await startSocketServer({ service, pairing: host.pairing })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'iPhone')
    const phone = await rawPeer(server.descriptor.port, host.pairing.signSession(paired.clientId))
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['model-catalog-revision'] }) as Frame
      const first = hello.result!.shell!.host.modelsRevision as number
      models = syntheticModelCatalog(4); large = true
      expect(await nextShell(phone, publish)).toMatchObject({ event: 'error', error: { code: 'too_large' } })
      expect(await phone.call('read', { op: 'shell' })).toMatchObject({ ok: false, error: { code: 'too_large' } })
      large = false
      const next = await nextShell(phone, publish)
      expect(next.models).toEqual(models)
      expect(next.modelsRevision).toBeGreaterThan(first)
    } finally { phone.frames.close(); await server.close() }
  })

  it('keeps sending the desktop’s own client the whole catalog from a host that offers revisions', async () => {
    const models = syntheticModelCatalog(4)
    const { service, publish } = catalogHost(() => models)
    const server = await startSocketServer({ service, pairing: host.pairing })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Desktop')
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); clients.push(client)
    try {
      await client.connect()
      expect(client.shell().host.models).toEqual(models)
      let shells = 0
      client.subscribe(() => { shells++ })
      publish()
      await expect.poll(() => shells).toBe(1)
      expect(client.shell().host.models).toEqual(models)
      expect((await client.readShell()).host.models).toEqual(models)
      expect((await client.command({ type: 'select-project', projectId: 'project' })).host.models).toEqual(models)
    } finally { await client.close(); await server.close() }
  })
})

describe('request budgets', () => {
  it('counts no health request, so a loop on it never blocks a session', async () => {
    const { client, result } = await pair()
    for (let index = 0; index < 150; index++) expect((await fetch(url + '/v1/health')).status).toBe(200)
    await expect(client.connect()).resolves.toMatchObject({ hostId: result.hostId })
  })
  it('keeps a session budget per paired client and says the host is busy past it, not that the device needs pairing', async () => {
    const first = await pair('First'), second = await pair('Second')
    const session = (token: string) => fetch(url + '/v1/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })
    // A loop on a token the host does not know spends nobody's budget.
    for (let index = 0; index < 150; index++) expect((await session('not-a-paired-token')).status).toBe(401)
    let response = await session(first.result.token)
    for (let index = 0; response.status === 200 && index < 200; index++) response = await session(first.result.token)
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { code: 'busy', message: HOST_BUSY } })
    await expect(first.client.connect()).rejects.toMatchObject({ code: 'busy', message: HOST_BUSY, pairingRequired: false })
    await expect(second.client.connect()).resolves.toMatchObject({ clientId: second.result.clientId })
  })
  it('keeps failed pairing budgets separate and checks them before redemption', async () => {
    const { client } = await pair()
    const redeem = (code: string, address: string) => fetch(url + '/v1/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
      body: JSON.stringify({ v: 1, code, name: 'Phone' }),
    })
    const checked = vi.spyOn(host.pairing, 'redeem')
    for (let index = 0; index < 10; index++) expect((await redeem('WRONG' + index, '100.64.0.1')).status).toBe(401)
    const code = host.pairing.issuePairingCode().code
    expect((await redeem(code, '100.64.0.1')).status).toBe(429)
    expect(checked).toHaveBeenCalledTimes(10)
    expect((await redeem(code, '100.64.0.2')).status).toBe(200)
    expect(checked).toHaveBeenCalledTimes(11)
    await expect(client.connect()).resolves.toBeDefined()
  })
  it('evicts the oldest pairing budget and expires entries after a minute', async () => {
    const redeem = (address: string) => fetch(url + '/v1/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
      body: JSON.stringify({ v: 1, code: 'WRONG', name: 'Phone' }),
    })
    for (let index = 0; index < 10; index++) expect((await redeem('100.64.0.1')).status).toBe(401)
    expect((await redeem('100.64.0.1')).status).toBe(429)
    for (let index = 2; index <= 1025; index++) {
      expect((await redeem('100.64.' + Math.floor(index / 256) + '.' + index % 256)).status).toBe(401)
    }
    expect((await redeem('100.64.0.1')).status).toBe(401)
    for (let index = 0; index < 9; index++) await redeem('100.64.0.1')
    expect((await redeem('100.64.0.1')).status).toBe(429)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_001)
    try { expect((await redeem('100.64.0.1')).status).toBe(401) } finally { clock.mockRestore() }
  })
  it('uses the local pairing budget for a forwarded address that is not one IP', async () => {
    const redeem = (address: string) => fetch(url + '/v1/pair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address },
      body: JSON.stringify({ v: 1, code: 'WRONG', name: 'Phone' }),
    })
    for (let index = 0; index < 10; index++) expect((await redeem('100.64.0.1, 100.64.0.2')).status).toBe(401)
    expect((await redeem('not-an-address')).status).toBe(429)
    await expect(SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Phone')).rejects.toMatchObject({ code: 'busy' })
  })
  it('does not spend the failed pairing budget on successful redemptions', async () => {
    for (let index = 0; index < 12; index++) await expect(SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Phone')).resolves.toBeDefined()
  })
  it('paces a client paging through a long log instead of closing it at the per-second cutoff', async () => {
    // The hello carries the first page and 101 event pages follow: one more than a peer may send of anything
    // else in a second. The clock is held still so every page lands in the same second however fast the
    // runner is; the cutoff would close this peer, and pacing instead holds the last page for a second.
    const pages = 101, last = HOST_EVENT_PAGE_SIZE * pages + 1
    const rows = Array.from({ length: last }, (_, index) => ({ seq: index + 1, threadId: 'synthetic', event: { kind: 'messages-reset' as const, at: new Date().toISOString() } }))
    let reads = 0
    const service: HostService = {
      shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity),
      events: (afterSeq, threadId, limit) => { reads++; return rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit) },
      subscribe: () => () => undefined,
    }
    const server = await startSocketServer({ service, pairing: host.pairing })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Long log')
    let drops = 0
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onConnectionChange: value => { if (!value) drops++ } }); clients.push(client)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const started = performance.now()
      await client.connect()
      // The hello and every page were read in the same held second, and the page past the budget waited for the next.
      expect(reads).toBe(1 + pages)
      expect(performance.now() - started).toBeGreaterThanOrEqual(900)
      expect(client.events(last - 1).map(row => row.seq)).toEqual([last])
      expect(drops).toBe(0)
      await expect(client.readShell()).resolves.toBeDefined()
    } finally { vi.useRealTimers(); await client.close(); await server.close() }
  })

  it.each([undefined, 0])('advances hello and event pages before later shell pushes (start: %s)', async afterSeq => {
    const rows = Array.from({ length: 2 }, (_, index) => ({ seq: index + 1, threadId: 'synthetic',
      event: { kind: 'messages-reset' as const, at: new Date().toISOString() } }))
    let publish = () => {}
    const service: HostService = {
      shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity),
      events: (cursor, threadId, limit) => rows.filter(row => row.seq > cursor && (!threadId || row.threadId === threadId)).slice(0, limit),
      subscribe: listener => { publish = () => listener(service.shell()); return () => {} },
    }
    const server = await startSocketServer({ service, pairing: host.pairing })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Cursor test')
    const peer = await rawPeer(server.descriptor.port, host.pairing.signSession(paired.clientId))
    try {
      const hello = await peer.call('hello', { op: 'hello', ...(afterSeq === undefined ? {} : { afterSeq }) })
      expect(hello).toMatchObject({ ok: true, result: { events: afterSeq === undefined ? [] : rows } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [] } })
      peer.messages.length = 0
      rows.push({ seq: 3, threadId: 'synthetic', event: { kind: 'messages-reset', at: new Date().toISOString() } })
      expect(await peer.call('events', { op: 'events', afterSeq: 2 })).toMatchObject({ ok: true, result: { events: [rows[2]], latestSeq: 3 } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [], latestSeq: 3 } })
      peer.messages.length = 0
      rows.push({ seq: 4, threadId: 'synthetic', event: { kind: 'messages-reset', at: new Date().toISOString() } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [rows[3]], latestSeq: 4 } })
    } finally { peer.frames.close(); await server.close() }
  })

  it('preserves the shell cursor while reading older and thread-filtered history', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ seq: index + 1, threadId: index === 4 ? 'other' : 'synthetic',
      event: { kind: 'messages-reset' as const, at: new Date().toISOString() } }))
    let publish = () => {}
    const service: HostService = {
      shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity),
      events: (cursor, threadId, limit) => rows.filter(row => row.seq > cursor && (!threadId || row.threadId === threadId)).slice(0, Math.min(limit ?? 1, 1)),
      subscribe: listener => { publish = () => listener(service.shell()); return () => {} },
    }
    const server = await startSocketServer({ service, pairing: host.pairing })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'History test')
    const peer = await rawPeer(server.descriptor.port, host.pairing.signSession(paired.clientId))
    try {
      await peer.call('hello', { op: 'hello', afterSeq: 2 })
      expect(await peer.call('older', { op: 'events', afterSeq: 0 })).toMatchObject({ result: { latestSeq: 1 } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [rows[3]], latestSeq: 4 } })
      peer.messages.length = 0
      expect(await peer.call('thread', { op: 'events', afterSeq: 4, threadId: 'other' })).toMatchObject({ result: { latestSeq: 5 } })
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { events: [rows[4]], latestSeq: 5 } })
    } finally { peer.frames.close(); await server.close() }
  })

  it('waits for hello before reading events for a shell push', async () => {
    let publish = () => {}
    const reads = vi.fn(() => [])
    const service: HostService = {
      shell: () => host.service.shell(), state: () => host.service.state(), threadDetail: id => host.service.threadDetail(id),
      command: (command, identity) => host.service.command(command, identity), events: reads,
      subscribe: listener => { publish = () => listener(service.shell()); return () => {} },
    }
    const server = await startSocketServer({ service, pairing: host.pairing })
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Opening connection')
    const peer = await rawPeer(server.descriptor.port, host.pairing.signSession(paired.clientId))
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      publish()
      await vi.advanceTimersByTimeAsync(50)
      expect(reads).not.toHaveBeenCalled()
      vi.useRealTimers()
      await peer.call('hello', { op: 'hello', afterSeq: 0 })
      expect(reads).toHaveBeenCalledWith(0, undefined, HOST_EVENT_PAGE_SIZE + 1)
      publish()
      await expect.poll(() => peer.messages.find(item => item.event === 'shell')).toMatchObject({ eventPage: { latestSeq: 0, events: [] } })
    } finally { vi.useRealTimers(); peer.frames.close(); await server.close() }
  })
})
