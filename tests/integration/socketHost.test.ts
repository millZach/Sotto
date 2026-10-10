// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { REMOTE_PERMISSION_DENIED } from '../../src/main/agents/authority'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { requestQuestionsDigest } from '../../src/main/agents/requestDrafts'
import { HostConnectionError, SocketHostService } from '../../src/main/agents/socketHostService'
import { TurnRecorder } from '../../src/main/agents/turns'
import { type AgentCommand, type AgentThreadDetailUpdate } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'
import { PIXEL_PNG } from '../fixtures/stagedImages'

const fixture = useSocketHostFixture()

const { pair } = fixture

describe('authenticated host socket', () => {
  it('acknowledges a targeted draft save over the real socket without reading history or reporting a read failure', async () => {
    const onPushError = vi.fn(), { client } = await pair('Autosave client', onPushError)
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const detail = vi.spyOn(client, 'readThreadDetail').mockRejectedValue(new Error('A history read must not delay typing.'))
    const events = vi.spyOn(client, 'readEvents').mockRejectedValue(new Error('An event read must not delay typing.'))
    const command = vi.spyOn(fixture.host.service, 'command')
    const result = await client.command({ type: 'compose', threadId, text: 'An acknowledged saved edit' })
    expect(result.error).toBeNull()
    expect(result.threadDrafts?.find(draft => draft.threadId === threadId)).toMatchObject({ text: 'An acknowledged saved edit', requestId: null })
    expect(fixture.host.service.shell().threadDrafts?.find(draft => draft.threadId === threadId)).toMatchObject({ text: 'An acknowledged saved edit', requestId: null })
    expect(command.mock.calls.filter(([input]) => input.type === 'compose')).toHaveLength(1)
    expect(detail).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); expect(onPushError).not.toHaveBeenCalled()
  })

  it('keeps forty real autosaves from starving Send, history, receipts or Check while an acknowledgement is held', async () => {
    const { client, result } = await pair('Burst saves')
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const created = await client.command({ type: 'create-project', provider: 'codex', title: 'Burst project', path: fixture.root, useExisting: true })
    const projectId = created.host.projects.find(project => project.path === fixture.root)!.id
    const opened = await client.command({ type: 'create-thread', projectId, title: 'Burst thread', modelId: created.host.models[0]!.id })
    const threadId = opened.host.threads.find(thread => thread.title === 'Burst thread')!.id
    await client.command({ type: 'select-thread', threadId })
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(fixture.url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    const actual = fixture.host.service.command.bind(fixture.host.service), calls: AgentCommand[] = []
    const { promise: gate, resolve: release } = deferred<void>()

    const { promise: started, resolve: entered } = deferred<void>()
    const { promise: sendAdmitted, resolve: sent } = deferred<void>()
    const pending: Promise<unknown>[] = []
    const spy = vi.spyOn(fixture.host.service, 'command').mockImplementation(async (...args) => {
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
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(fixture.url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    const image = await client.stageAttachment({ name: 'Synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    const control = (fixture.host.service as unknown as { control: { persist(): Promise<void> } }).control
    const persist = control.persist.bind(control)
    const { promise: gate, resolve: release } = deferred<void>()

    const { promise: started, resolve: entered } = deferred<void>()
    const held = vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    const actual = fixture.host.service.command.bind(fixture.host.service), admitted: AgentCommand[] = []
    const command = vi.spyOn(fixture.host.service, 'command').mockImplementation((...args) => {
      const operation = actual(...args); admitted.push(structuredClone(args[0])); return operation
    })
    const nativeWrites = vi.spyOn(fixture.native, 'execute'), pending: Promise<unknown>[] = []
    try {
      pending.push(client.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
      pending.push(client.command({ type: 'compose', threadId, text: 'First prompt', attachments: [image] }, undefined, 'first-save'))
      await expect.poll(() => admitted.filter(input => input.type === 'compose').length).toBe(1)
      fixture.native.event({ type: 'question', threadId: 'workshop', text: 'New question', request: {
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
        const disk = JSON.parse(await readFile(join(fixture.root, 'agents.json'), 'utf8'))
        return disk.threadDrafts.find((draft: { threadId: string }) => draft.threadId === threadId)
      }).toMatchObject({ threadId, requestId: null, text: 'Latest packet', attachments: [] })
      expect(nativeWrites.mock.calls.filter(([input]) => input.type === 'send' || input.type === 'answer')).toEqual([])
      expect(fixture.host.service.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId, requestId: null, text: 'Latest packet', attachments: [] }))
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
    const control = (fixture.host.service as unknown as { control: { persist(): Promise<void> } }).control
    const persist = control.persist.bind(control)
    const { promise: gate, resolve: release } = deferred<void>()

    const { promise: started, resolve: entered } = deferred<void>()
    const held = vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    const actual = fixture.host.service.command.bind(fixture.host.service), admitted: AgentCommand[] = []
    const command = vi.spyOn(fixture.host.service, 'command').mockImplementation((...args) => {
      const operation = actual(...args); admitted.push(structuredClone(args[0])); return operation
    })
    const pending: Promise<unknown>[] = []
    try {
      pending.push(client.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
      pending.push(client.command({ type: 'compose', threadId, text: 'First plain intent', attachments: [image] }))
      await expect.poll(() => admitted.some(input => input.type === 'compose')).toBe(true)
      fixture.native.event({ type: 'question', threadId: 'workshop', text: 'New question', request: {
        id: 'new-question', kind: 'question', text: 'New question', options: [{ id: 'native:blue', label: 'Blue' }] } })
      await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
      const latest = client.command({ type: 'compose', threadId, text: 'Newest plain intent' })
      pending.push(latest, client.command({ type: 'observe-threads', threadIds: [] }))
      const settled = Promise.allSettled(pending)
      release(); await settled
      expect((await latest).error).toBeNull()
      expect(JSON.parse(await readFile(join(fixture.root, 'agents.json'), 'utf8')).threadDrafts).toContainEqual(expect.objectContaining({
        threadId, requestId: null, text: 'Newest plain intent', attachments: [image],
      }))
      expect(fixture.host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests.map(request => request.id)).toEqual(['new-question'])
    } finally { release(); await Promise.allSettled(pending); command.mockRestore(); held.mockRestore() }
  })

  it.each(['live', 'uncertain', 'retry-ready'] as const)('checks current answer authority at real targeted Compose execution for %s, including revocation after admission', async delivery => {
    const { client, result } = await pair('Compose authority')
    const second = (await pair('Other window')).client
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (allowed: boolean) => expect((await fetch(fixture.url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    fixture.native.event({ type: 'question', threadId: 'workshop', text: 'Question', request: {
      id: 'bound-question', kind: 'question', text: 'Question', options: [{ id: 'native:blue', label: 'Blue' }],
      ...(delivery === 'uncertain' ? { delivery: 'uncertain' } : delivery === 'retry-ready' ? { answerRetryReady: true } : {}) } })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const sharedFeedback = () => {
      const state = fixture.host.service.shell()
      return structuredClone({ error: state.error, notice: state.notice })
    }
    const otherFeedback = () => {
      const state = second.shell()
      return structuredClone({ error: state.error, notice: state.notice })
    }
    await second.readShell()
    const initialShared = sharedFeedback(), initialOther = otherFeedback()
    const writes = vi.spyOn(fixture.native, 'execute')
    for (const text of ['N', 'No', 'No policy']) expect((await client.command({ type: 'compose', threadId, text })).error).toBe(REMOTE_PERMISSION_DENIED)
    expect(sharedFeedback()).toEqual(initialShared)
    await second.readShell()
    expect(otherFeedback()).toEqual(initialOther)
    expect(fixture.host.service.shell().threadDrafts).toEqual([])
    await policy(true)
    expect((await client.command({ type: 'compose', threadId, text: 'Authorized answer' })).error).toBeNull()
    const before = JSON.parse(await readFile(join(fixture.root, 'agents.json'), 'utf8')).threadDrafts
    await second.readShell()
    const beforeShared = sharedFeedback(), beforeOther = otherFeedback()
    const { promise: gate, resolve: release } = deferred<void>()

    const { promise: started, resolve: entered } = deferred<void>()
    const actual = fixture.host.service.command.bind(fixture.host.service)
    const held = vi.spyOn(fixture.host.service, 'command').mockImplementationOnce(async (...args) => { entered(); await gate; return actual(...args) })
    const editing = client.command({ type: 'compose', threadId, text: 'Revoked answer' })
    try {
      await started; await policy(false); release()
      expect((await editing).error).toBe(REMOTE_PERMISSION_DENIED)
      expect(sharedFeedback()).toEqual(beforeShared)
      await second.readShell()
      expect(otherFeedback()).toEqual(beforeOther)
      expect(JSON.parse(await readFile(join(fixture.root, 'agents.json'), 'utf8')).threadDrafts).toEqual(before)
      fixture.native.event({ type: 'history', threadId: 'workshop', text: '', messages: [] })
      await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(0)
      expect((await client.command({ type: 'compose', threadId, text: 'A saved stale answer still needs policy' })).error).toBe(REMOTE_PERMISSION_DENIED)
      expect(JSON.parse(await readFile(join(fixture.root, 'agents.json'), 'utf8')).threadDrafts).toEqual(before)
      expect(writes.mock.calls.filter(([input]) => input.type === 'send' || input.type === 'answer')).toEqual([])
    } finally { release(); await Promise.allSettled([editing]); held.mockRestore(); writes.mockRestore() }
  })

  it('ignores a closed-question binding in an empty active composer over the real socket', async () => {
    const { client, result } = await pair('Empty stale composer')
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    await client.command({ type: 'select-thread', threadId })
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (allowed: boolean) => expect((await fetch(fixture.url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    await fixture.host.service.command({ type: 'select-thread', threadId }, desktopWindowClient())
    await policy(true)
    fixture.native.event({ type: 'question', threadId: 'workshop', text: 'Question', request: {
      id: 'closed-question', kind: 'question', text: 'Question', options: [{ id: 'native:blue', label: 'Blue' }] } })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    await fixture.host.service.command({ type: 'cancel-draft' }, desktopWindowClient())
    expect((await fixture.host.service.command({ type: 'compose', text: '' }, desktopWindowClient())).error).toBeNull()
    expect(fixture.host.service.shell()).toMatchObject({ composing: true, draftThreadId: threadId, draftRequestId: 'closed-question', threadDrafts: [] })
    fixture.native.event({ type: 'history', threadId: 'workshop', text: '', messages: [] })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(0)
    await policy(false)
    expect((await client.command({ type: 'compose', threadId, text: 'A new plain prompt' })).error).toBeNull()
    expect(JSON.parse(await readFile(join(fixture.root, 'agents.json'), 'utf8')).threadDrafts).toContainEqual(expect.objectContaining({ threadId, requestId: null, text: 'A new plain prompt' }))
  })

  it.each(['missing-thread', 'wrong-provider', 'missing-request', 'changed-form', 'changed-during-read', 'closed-during-read', 'disconnected-provider', 'revoked-during-read', 'unexpected-native-error'] as const)('keeps safe answer Check guidance across the socket for %s', async scenario => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (action: 'allow-answers' | 'deny-answers') => {
      expect((await fetch(fixture.url + '/v1/admin/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    }
    await policy('allow-answers')
    const questions = [{ id: 'q', question: 'Which color?', options: [], multiSelect: false, allowFreeText: true }]
    fixture.native.event({ type: 'question', threadId: 'workshop', text: '', request: { id: 'check-question', kind: 'question', text: '', options: [], questions, delivery: 'uncertain' } })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.some(request => request.id === 'check-question')).toBe(true)
    const refresh = vi.fn(async () => {
      if (scenario === 'unexpected-native-error') throw new Error('Synthetic private provider output must not cross the socket')
      const snapshot = await fixture.native.snapshot()
      const thread = snapshot.threads.find(thread => thread.id === 'workshop')!
      if (scenario === 'changed-during-read') thread.requests[0]!.questions![0]!.question = 'A replacement question'
      if (scenario === 'closed-during-read') thread.settledAt = new Date().toISOString()
      if (scenario === 'revoked-during-read') await policy('deny-answers')
      return snapshot
    })
    Object.assign(fixture.native, { refreshThread: refresh })
    const execute = vi.spyOn(fixture.native, 'execute')
    if (scenario === 'disconnected-provider') {
      fixture.native.event({ type: 'disconnect', threadId: 'workshop', text: '' })
      await expect.poll(() => fixture.host.service.shell().host.providers?.find(provider => provider.id === 'codex')?.connection).toBe('disconnected')
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
    const command = vi.spyOn(fixture.host.service, 'command').mockResolvedValueOnce({ ...fixture.host.service.shell(), error: null, worktreeReclaimPreview: preview })
    const pushes: unknown[] = []
    const unsubscribe = client.subscribe(state => pushes.push(state.worktreeReclaimPreview))
    try {
      const result = await client.command({ type: 'preview-reclaim-thread-worktree', threadId: randomUUID() })
      expect(result.worktreeReclaimPreview).toEqual(preview)
      expect(client.shell().worktreeReclaimPreview).toBeUndefined()
      expect(other.client.shell().worktreeReclaimPreview).toBeUndefined()
      expect(fixture.host.service.shell().worktreeReclaimPreview).toBeUndefined()
      expect(pushes).not.toContainEqual(preview)
      command.mockResolvedValueOnce({ ...fixture.host.service.shell(), error: 'Checking this worktree is unavailable. Nothing was removed.' })
      expect((await client.command({ type: 'preview-reclaim-thread-worktree', threadId: randomUUID() })).error).toContain('Nothing was removed')
    } finally { unsubscribe(); command.mockRestore() }
  })
  it('exposes only loopback health before pairing and rejects unsigned operations', async () => {
    expect(await (await fetch(fixture.url + '/v1/health')).json()).toMatchObject({ v: 1, hostId: fixture.host.service.shell().hostId, port: fixture.host.descriptor!.port })
    expect((await fetch(fixture.url + '/v1/session', { method: 'POST' })).status).toBe(401)
    expect((await fetch(fixture.url + '/v1/admin/pairing-code', { method: 'POST' })).status).toBe(401)
    const client = new SocketHostService({ url: fixture.url, token: 'bad' }); fixture.clients.push(client)
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
    expect((await fetch(fixture.url + '/v1/health', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(401)
  })
  it('pairs once, negotiates a shell and revokes a live session immediately', async () => {
    const { client, result } = await pair()
    expect(client.shell().hostId).toBe(result.hostId)
    const shell = await client.readShell()
    expect(shell).not.toHaveProperty('membership')
    expect(shell.configuration).not.toHaveProperty('membershipEndpoint')
    expect((await client.connect()).capabilities.mayAnswer).toBe(false)
    await client.revokePairing()
    expect(fixture.host.pairing.verifyToken(result.token)).toBeUndefined()
    await expect(client.connect()).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('keeps the retired account fields on raw protocol v1 shell frames', async () => {
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older desktop')
    const session = fixture.host.pairing.signSession(paired.clientId)
    const peer = await rawPeer(fixture.host.descriptor!.port, session)
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
    const peers = await Promise.all([first, second].map(({ result }) => rawPeer(fixture.host.descriptor!.port, fixture.host.pairing.signSession(result.clientId))))
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    try {
      for (const peer of peers) await peer.call('hello', { op: 'hello' })
      for (const allowed of [true, false]) {
        for (const peer of peers) peer.messages.length = 0
        const response = await fetch(fixture.url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), {
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
    expect(fixture.host.service.shell().configuration.enabled).toBe(false)
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
    expect(fixture.host.service.shell().host.threads.find(thread => thread.id === threadId)?.title).toBe('Renamed once')
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
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    const policy = async (action: string) => {
      const response = await fetch(fixture.url + '/v1/admin/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })
      expect(response.status).toBe(200)
    }
    await policy('allow-answers')
    expect((await client.connect()).capabilities.mayAnswer).toBe(true)
    fixture.native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-one', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const answerId = randomUUID()
    expect((await client.command({ type: 'answer', threadId, requestId: 'permission-one', answer: '', approved: true }, undefined, answerId)).error).toBeNull()
    expect(await client.receipt(answerId)).toEqual({ status: 'completed', answerDelivered: true })
    expect(fixture.host.service.events(0, threadId)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ kind: 'answer-given', attribution: expect.objectContaining({ clientId: result.clientId, user: 'Studio laptop', transport: 'socket' }) }) }))
    await policy('deny-answers')
    fixture.native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-two', text: 'Again?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.some(request => request.id === 'permission-two')).toBe(true)
    await expect(client.command({ type: 'answer', threadId, requestId: 'permission-two', answer: '', approved: true })).rejects.toMatchObject({ code: 'forbidden' })
    expect(fixture.host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests).toContainEqual(expect.objectContaining({ id: 'permission-two' }))
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
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(fixture.url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    fixture.native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const execute = fixture.native.execute.bind(fixture.native)
    const spy = vi.spyOn(fixture.native, 'execute').mockImplementation(async command => {
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
      expect(fixture.host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests).toHaveLength(requestLeaves ? 0 : 1)
    } finally { spy.mockRestore() }
  })
  it.each([false, true])('keeps an uncertain question draft send private when accepted is %s', async accepted => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(fixture.url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    fixture.native.event({ type: 'question', threadId: 'workshop', requestId: 'question-draft-receipt', text: 'Which color?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.some(item => item.id === 'question-draft-receipt')).toBe(true)
    await client.command({ type: 'select-thread', threadId })
    expect(await client.command({ type: 'compose', text: 'Blue' })).toMatchObject({ composing: true, draft: 'Blue', draftRequestId: 'question-draft-receipt' })
    const execute = fixture.native.execute.bind(fixture.native)
    const adapter = vi.spyOn(fixture.native, 'execute').mockImplementation(command => command.type === 'answer'
      ? Promise.resolve({ accepted, uncertain: true }) : execute(command))
    const dispatch = fixture.host.service.command.bind(fixture.host.service)
    let coordinatorError: string | null | undefined
    const coordinator = vi.spyOn(fixture.host.service, 'command').mockImplementation(async (command, identity) => {
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
      expect(fixture.host.service.shell().error).toBeNull()
      await expect(client.command({ type: 'send' }, undefined, commandId)).rejects.toMatchObject({ code: 'unavailable' })
      expect(adapter.mock.calls.filter(([command]) => command.type === 'answer')).toHaveLength(1)
    } finally { refresh.mockRestore(); coordinator.mockRestore(); adapter.mockRestore() }
  })
  it('confirms a socket answer whose delayed delivery finishes before the wrapped result arrives', async () => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(fixture.url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    fixture.native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const execute = fixture.native.execute.bind(fixture.native)
    const spy = vi.spyOn(fixture.native, 'execute').mockImplementation(async command => {
      const outcome = await execute(command)
      return command.type === 'answer' ? { accepted: false, uncertain: true, answerCompletion: Promise.resolve(true) } : outcome
    })
    try {
      const commandId = randomUUID()
      expect((await client.command({ type: 'answer', threadId, requestId: 'permission-receipt', answer: '', approved: true }, undefined, commandId)).error).toBeNull()
      expect(await client.receipt(commandId)).toEqual({ status: 'completed', answerDelivered: true })
      expect(fixture.host.service.shell().error).toBeNull()
      expect(fixture.host.service.shell().host.threads.find(thread => thread.id === threadId)?.requests).toHaveLength(0)
    } finally { spy.mockRestore() }
  })
  it('settles socket delivery confirmed while the failed command is being finalized', async () => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(fixture.url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    fixture.native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const { promise: completion, resolve: complete } = deferred<boolean>()
    const execute = fixture.native.execute.bind(fixture.native)
    const spy = vi.spyOn(fixture.native, 'execute').mockImplementation(command => {
      if (command.type !== 'answer') return execute(command)
      return Promise.resolve({ accepted: false, uncertain: true, answerCompletion: completion })
    })
    const finish = TurnRecorder.prototype.finish
    let settledDuringFinish = false
    const finalize = vi.spyOn(TurnRecorder.prototype, 'finish').mockImplementation(async function (this: TurnRecorder, turn, outcome) {
      if (turn?.commandType === 'answer') {
        expect(outcome).toBe('failed')
        expect(fixture.host.service.shell().error).toBeNull()
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
      expect(fixture.host.service.shell().error).toBeNull()
    } finally { finalize.mockRestore(); spy.mockRestore() }
  })
  it('confirms a successful answer receipt despite another command failing while it runs', async () => {
    const { client, result } = await pair()
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const descriptor = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
    expect((await fetch(fixture.url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: result.clientId }) })).status).toBe(200)
    fixture.native.event({ type: 'permission', threadId: 'workshop', requestId: 'permission-receipt', text: 'Build?' })
    await expect.poll(() => client.shell().host.threads.find(thread => thread.id === threadId)?.requests.length).toBe(1)
    const { promise: gate, resolve: release } = deferred<void>()
    let started = false
    const execute = fixture.native.execute.bind(fixture.native)
    const spy = vi.spyOn(fixture.native, 'execute').mockImplementation(async command => {
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
      expect(fixture.host.service.shell().error).toBe(failed.error)
      expect(await client.receipt(commandId)).toEqual({ status: 'completed', answerDelivered: true })
    } finally { release(); await answer; spy.mockRestore() }
  })
  it('composes and sends to the peer selection while preserving another thread draft', async () => {
    const { client } = await pair()
    await client.command({ type: 'connect', provider: 'codex' })
    const threads = client.shell().host.threads
    const localId = threads[0]!.id
    const created = await client.command({ type: 'create-project', provider: 'codex', title: 'Remote project', path: fixture.root, useExisting: true })
    const projectId = created.host.projects.find(project => project.path === fixture.root)!.id
    const opened = await client.command({ type: 'create-thread', projectId, title: 'Remote thread', modelId: created.host.models[0]!.id })
    const remoteId = opened.host.threads.find(thread => thread.title === 'Remote thread')!.id
    await fixture.host.service.command({ type: 'select-thread', threadId: localId }, desktopWindowClient())
    await fixture.host.service.command({ type: 'compose', text: 'Host draft' }, desktopWindowClient())
    await client.command({ type: 'select-thread', threadId: remoteId })
    const before = fixture.host.service.shell()
    expect((await client.command({ type: 'compose', text: 'Remote draft' })).error).toBeNull()
    expect(fixture.host.service.shell().threadDrafts).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: remoteId, text: 'Remote draft' })]))
    await client.observe([remoteId])
    // The reconnect is sent the observed thread whole once, whether the host published it or read it for this client.
    const wholes: AgentThreadDetailUpdate[] = []
    const stopCounting = client.subscribeThreadDetail(update => { if (update.threadId === remoteId && !('baseRevision' in update)) wholes.push(update) })
    await client.connect()
    expect(wholes).toHaveLength(1)
    stopCounting()
    expect((await client.readShell()).activeThreadId).toBe(remoteId)
    expect((await client.command({ type: 'send' })).error).toBeNull()
    expect(fixture.host.service.threadDetail(remoteId)!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', text: 'Remote draft' })]))
    expect(fixture.host.service.shell().activeThreadId).toBe(before.activeThreadId)
    expect(fixture.host.service.shell().draft).toBe(before.draft)
    expect(fixture.host.service.shell().threadDrafts).toEqual(expect.arrayContaining(before.threadDrafts ?? []))
  })

  it('refuses a second listener before it can open or overwrite the running host stores', async () => {
    await expect(startHeadlessHost({ dataDirectory: fixture.root, port: 0 })).rejects.toThrow(`Another host (process ${process.pid}) is using this data folder`)
    expect((await fetch(fixture.url + '/v1/health')).status).toBe(200)
  })
  it('does not turn caller-supplied IPC identity into permission authority', async () => {
    const { client } = await pair()
    await expect(client.command({ type: 'answer', threadId: 'missing', requestId: 'missing', answer: '', approved: true }, { clientId: 'desktop-window', user: 'owner', transport: 'ipc' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
