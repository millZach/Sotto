// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { version as packageVersion } from '../../package.json'
import { startSocketServer } from '../../src/host/socketServer'
import { desktopWindowClient, type HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { SCREENSHOT_NOT_ITS_TYPE, type AgentCommand, type AgentModel, type AgentThreadDetail, type AgentThreadDetailUpdate } from '../../src/shared/agents'
import { hostVersionMismatch } from '../../src/shared/hostProtocol'
import { syntheticModelCatalog } from '../fixtures/modelCatalog'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const { pair } = fixture

describe('staged images over the socket (ADR-0031)', () => {
  it('stages an image on the host that runs the thread, sends the handle with the draft, and hands the bytes back by digest', async () => {
    const { client } = await pair()
    const bytes = Buffer.alloc(300 * 1024, 3); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
    const dimensions = { original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } }
    const handle = await client.stageAttachment({ name: 'Remote.png', mimeType: 'image/png', bytes, dimensions })
    expect(handle).toMatchObject({ name: 'Remote.png', mimeType: 'image/png', sizeBytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), dimensions })
    // The content is the host's, in its own data folder; the desktop keeps none of it.
    expect(await readFile(join(fixture.root, 'attachments', `${handle.digest}.png`))).toEqual(bytes)
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
    const health = await (await fetch(fixture.url + '/v1/health')).json() as Record<string, unknown>
    expect(health).toMatchObject({ v: 1, status: 'ready', sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions', 'background-refresh', 'pull-request-babysit'] })
    const listener = JSON.parse(await readFile(join(fixture.root, 'host-listener.json'), 'utf8')) as Record<string, unknown>
    expect(listener).toMatchObject({ v: 1, sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions', 'background-refresh', 'pull-request-babysit'] })
    const { client } = await pair()
    expect(await client.connect()).toMatchObject({ sottoVersion: packageVersion, features: ['client-liveness', 'message-aliases', 'detail-delta', 'git-refs', 'git-changed-files', 'git-pull-request', 'attachment-staging', 'host-folders', 'provider-sign-in', 'client-updates', 'activity-summaries', 'model-catalog-revision', 'thread-files', 'thread-changes', 'subagents', 'answer-receipts', 'answer-check', 'atomic-send', 'draft-revisions', 'background-refresh', 'pull-request-babysit'], capabilities: { mayAnswer: false } })
  })

  it('takes the user’s Babysit pull request from a paired client, and refuses one the thread does not know in words (ADR-0061)', async () => {
    const { client } = await pair()
    expect(client.supportsBabysitting).toBe(true)
    await client.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } })
    await client.command({ type: 'connect', provider: 'codex' })
    const threadId = client.shell().host.threads.find(thread => thread.title === 'Workshop')!.id
    const pullRequest = 'https://github.com/o/r/pull/42'
    expect((await client.command({ type: 'babysit-pull-request', threadId, url: pullRequest })).error).toBe('Link this pull request to the thread first. Nothing was started.')
    expect((await client.command({ type: 'stop-babysitting', threadId, url: pullRequest })).notice).toBe('This thread was not babysitting PR #42.')
    expect(client.shell().host.threads.find(thread => thread.id === threadId)!.babysitting).toBeUndefined()
  })

  it('runs client updates only where it offers them: the headless host does, the phone listener does not (#480)', async () => {
    const { client } = await pair()
    expect(client.offersClientUpdates()).toBe(true)
    // The command reaches the host, which refuses it in words: nothing has been checked here yet.
    expect((await client.command({ type: 'queue-client-updates', providers: ['codex'] })).error).toBe('Sotto has not checked Codex yet. Check again, then update it.')
    const phone = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing })
    try {
      expect(phone.descriptor.features).not.toContain('client-updates')
      const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
      const other = new SocketHostService({ url: 'http://127.0.0.1:' + phone.descriptor.port, token: paired.token }); fixture.clients.push(other)
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
      shell: () => ({ ...fixture.host.service.shell(), clientUpdates: [reading] }), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [], subscribe: () => () => undefined,
    }
    // A client accepts client-updates in its hello when the host lists it; one from before #480, or the iPhone client, never does.
    for (const [offered, expected] of [[true, { channel: 'mise', state: 'queued' }], [false, { channel: 'unknown', state: 'idle' }]] as const) {
      const server = await startSocketServer({ service, pairing: fixture.host.pairing, clientUpdates: offered })
      try {
        const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, offered ? 'Desktop' : 'Older desktop')
        const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
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
      shell: () => unreadableShell ? { ...fixture.host.service.shell(), host: 'a later shape' } as unknown as ReturnType<HostService['shell']> : fixture.host.service.shell(),
      state: () => fixture.host.service.state(),
      threadDetail: id => id === 'streaming' ? structuredClone(current) : fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity),
      events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit),
      subscribe: listener => { emitShell = listener; return () => undefined },
      subscribeThreadDetail: listener => { emitDetail = listener; return () => undefined },
    }
    const server = await startSocketServer({ service, pairing: fixture.host.pairing, sottoVersion: '0.0.1' })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older host')
    const pushErrors: (string | null)[] = []
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, owned: true,
      onPushError: text => pushErrors.push(text), onPushErrorCleared: () => pushErrors.push(null) }); fixture.clients.push(client)
    try {
      await client.connect()
      await client.observe(['streaming'])
      current = { threadId: 'streaming', revision: 2, messages: [message('Hello' + 'x'.repeat(17 * 1024 * 1024))] }
      emitDetail(current)
      await expect.poll(() => pushErrors.at(-1)).toEqual(expect.stringContaining('A thread on this host is too large'))
      unreadableShell = true
      emitShell(fixture.host.service.shell())
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
    const server = await startSocketServer({ service: fixture.host.service, pairing: fixture.host.pairing, sottoVersion: '0.0.1' })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older host')
    const skewed = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(skewed)
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
        const state = fixture.host.service.shell()
        const threads = large() ? [{ id: 'huge', projectId: 'project', title: 'Huge', modelId: 'fixture-model', status: 'idle' as const, messages: huge, requests: [] }] : state.host.threads
        return { ...state, host: { ...state.host, threads, models: structuredClone(models()) } }
      },
      state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
      command: (command, identity) => fixture.host.service.command(command, identity), events: () => [],
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
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    expect(server.descriptor.features).toContain('model-catalog-revision')
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
    const session = fixture.host.pairing.signSession(paired.clientId)
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
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'iPhone')
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
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
    const server = await startSocketServer({ service, pairing: fixture.host.pairing })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
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

it('targets the peer selection for cancel-draft and preserves the host thread draft', async () => {
    const { client } = await pair()
    await client.command({ type: 'connect', provider: 'codex' })
    const threads = client.shell().host.threads
    await fixture.host.service.command({ type: 'select-thread', threadId: threads[0]!.id }, desktopWindowClient())
    await fixture.host.service.command({ type: 'compose', text: 'Host draft' }, desktopWindowClient())
    await client.command({ type: 'select-thread', threadId: threads[1]!.id })
    await client.command({ type: 'compose', text: 'Remote draft' })
    const before = fixture.host.service.shell()
    expect((await client.command({ type: 'cancel-draft' })).error).toBeNull()
    expect(fixture.host.service.shell().activeThreadId).toBe(before.activeThreadId)
    expect(fixture.host.service.shell().draft).toBe(before.draft)
    expect(fixture.host.service.shell().threadDrafts?.find(draft => draft.threadId === threads[1]!.id)?.text).toBeUndefined()
  })
