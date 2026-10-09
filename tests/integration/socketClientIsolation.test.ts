// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { initializeGitRepository, runFixtureGit } from '../fixtures/gitRepository'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandReceipts } from '../../src/host/commandReceipts'
import { SocketFrames } from '../../src/host/socketFrames'
import { startSocketServer } from '../../src/host/socketServer'
import { desktopWindowClient, type HostService } from '../../src/main/agents/hostService'
import { PairedClients, SESSION_LIFETIME_MS } from '../../src/main/agents/pairing'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()

const { pair } = fixture

describe('socket client isolation and reconnect', () => {
  it('carries a thread\'s Git status to a paired client through the shell it already receives', async () => {
    // The host reads the folder; the client only reads the record, over the socket, the way any other field arrives.
    await fixture.native.initializeWorkingFolders(join(fixture.root, 'workspaces'))
    const folder = join(fixture.root, 'workspaces', 'project') // where initializeWorkingFolders puts the fixture project
    const git = (...args: string[]) => runFixtureGit(folder, ...args)
    await initializeGitRepository(folder, { files: { 'work.txt': 'first\n' }, message: 'First' })
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
    await fixture.native.initializeWorkingFolders(join(fixture.root, 'workspaces'))
    const folder = join(fixture.root, 'workspaces', 'project')
    await mkdir(join(folder, 'notes'))
    await initializeGitRepository(folder, { files: { 'work.txt': 'first\n', 'notes/plan.md': '# Plan\n' }, message: 'First' })
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
    fixture.native.event({ type: 'manual', threadId: 'workshop', text: 'Synthetic prompt' })
    await expect.poll(() => workshop()?.status).toBe('running')
    fixture.native.event({ type: 'ready', threadId: 'workshop', text: 'Synthetic reply' })
    await expect.poll(() => marked(phone.client)).toBe(true)
    await expect.poll(() => marked(desktop.client)).toBe(true)
    // Opening the thread on one client reads it on all of them.
    await phone.client.observe([threadId])
    await expect.poll(() => marked(desktop.client)).toBeUndefined()
    expect(marked(phone.client)).toBeUndefined()
    // While a client has it open, finishing again earns nothing.
    fixture.native.event({ type: 'manual', threadId: 'workshop', text: 'Synthetic prompt' })
    await expect.poll(() => workshop()?.status).toBe('running')
    fixture.native.event({ type: 'ready', threadId: 'workshop', text: 'Synthetic reply' })
    await expect.poll(() => workshop()?.status).toBe('idle')
    expect(marked(desktop.client)).toBeUndefined()
  })
  it('lists a temp folder\'s subfolders over the socket for the Add project dialog\'s folder browser', async () => {
    const { client } = await pair()
    const folder = join(fixture.root, 'browse')
    await mkdir(join(folder, 'child'), { recursive: true })
    const result = await client.hostFolders({ path: folder })
    expect(result).toMatchObject({ status: 'listed', path: folder, folders: [{ name: 'child', git: false }], truncated: false })
  })
  it('resyncs after a dropped connection without sending the old command again', async () => {
    const { client } = await pair()
    const id = randomUUID()
    await client.command({ type: 'configure', patch: { enabled: false } }, undefined, id)
    await client.close()
    await fixture.host.service.command({ type: 'configure', patch: { enabled: true } }, desktopWindowClient())
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
    const pairing = new PairedClients(join(fixture.root, 'expiry'), { now: () => now }); await pairing.load()
    const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Expiring')
    const server = await startSocketServer({ service: fixture.host.service, pairing })
    const session = pairing.signSession(paired.clientId)
    const key = randomBytes(16).toString('base64')

    const { promise: reply, resolve: resolveMessage } = deferred<unknown>()

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
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
    command: (command, identity) => fixture.host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(fixture.host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'History')
  const session = fixture.host.pairing.signSession(paired.clientId)
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
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
    command: (command, identity) => fixture.host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(fixture.host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Catch-up')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
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
    shell: () => { const state = fixture.host.service.shell(); return large ? { ...state, host: { ...state.host, threads: state.host.threads.map((thread, index) => index === 0 ? { ...thread, messages } : thread) } } : state },
    state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
    command: (command, identity) => fixture.host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(fixture.host.service.shell()); return () => undefined },
  }
  await fixture.host.service.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, desktopWindowClient())
  await fixture.host.service.command({ type: 'connect', provider: 'codex' }, desktopWindowClient())
  expect(fixture.host.service.shell().host.threads.length).toBeGreaterThan(0)
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Large shell')
  const pushErrors: string[] = []
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: message => pushErrors.push(message) }); fixture.clients.push(client)
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
    shell: () => { const state = fixture.host.service.shell(); return { ...state, host: { ...state.host, models: [...state.host.models, ...catalog, { id: 'round-' + round, provider: 'Fixture', name: 'Round', ready: true }] } } },
    state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
    command: (command, identity) => fixture.host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => rows.filter(row => row.seq > afterSeq && (!threadId || row.threadId === threadId)).slice(0, limit),
    subscribe: listener => { publish = () => listener(fixture.host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Slow link')
  const session = fixture.host.pairing.signSession(paired.clientId)
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
    shell: () => { const state = fixture.host.service.shell(); return { ...state, host: { ...state.host, models: [...state.host.models, model] } } },
    state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
    command: (command, identity) => { if (command.type === 'create-thread') commands.push(command.providerMode ?? ''); return fixture.host.service.command(command, identity) },
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Modes')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
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
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(), threadDetail: id => fixture.host.service.threadDetail(id),
    // An interrupt here stays pending until the test lets it go, standing in for work that is still running.
    command: async (command, identity) => { if (command.type === 'interrupt') { const held = deferred(); release.push(held.resolve); await held.promise } return fixture.host.service.command(command, identity) },
    events: (afterSeq, threadId, limit) => fixture.host.service.events(afterSeq, threadId, limit), subscribe: listener => fixture.host.service.subscribe(listener),
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing, receipts: new CommandReceipts({ lifetimeMs: 1000, limit: 2, now: () => now }) })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Receipts')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
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
    shell: () => fixture.host.service.shell(), state: () => fixture.host.service.state(),
    threadDetail: id => id === 'huge' ? (fits ? { ...huge, revision: 2, messages: [] } : huge) : fixture.host.service.threadDetail(id),
    command: (command, identity) => fixture.host.service.command(command, identity),
    events: (afterSeq, threadId, limit) => threadId === 'huge'
      ? [{ seq: afterSeq + 1, threadId, event: { kind: 'message-text-appended' as const, at: new Date().toISOString(), messageId: 'm', appendText: 'x'.repeat(17 * 1024 * 1024) } }]
      : fixture.host.service.events(afterSeq, threadId, limit),
    subscribe: listener => { publish = () => listener(fixture.host.service.shell()); return () => undefined },
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Bursts')
  const pushErrors: (string | null)[] = []
  let connected = true
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token, onPushError: message => pushErrors.push(message),
    onPushErrorCleared: () => pushErrors.push(null), onConnectionChange: value => { connected = value } }); fixture.clients.push(client)
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
