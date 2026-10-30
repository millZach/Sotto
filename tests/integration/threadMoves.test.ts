// @vitest-environment node
// #1178 part 1 over a real paired host: a thread on This computer moves to the host, end to end. Its branch lands in the
// host's copy of the project, the host makes the new thread from it and sends its first prompt, the handover and Sotto's
// facts, at once; once that turn ends there, the source is settled, keeps its folder, and links to the new thread. A
// thread that cannot move says why, and a move refused before any thread exists is given back.
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { DesktopBranchMoves, foldersOfSnapshot } from '../../src/main/agents/branchMoves'
import { hostMachineReport, HostFactsSource } from '../../src/main/agents/hostFacts'
import { readProjectOrigins } from '../../src/main/agents/projectOrigins'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { moveTargetsOf, ThreadMoveService, type MoveRecord } from '../../src/main/agents/threadMoves'
import { HostThreadMoves } from '../../src/main/agents/threadMovesHost'
import { WatcherService } from '../../src/main/agents/watcher'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentThread } from '../../src/shared/agents'
import { branchMoveWords } from '../../src/shared/branchMoves'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { HANDOVER_LEAD } from '../../src/shared/handover'
import { MOVE_HANDOVER_CLOSE, THREAD_MOVE_WORDS, type ThreadMovePrepare, type ThreadMoveStart } from '../../src/shared/threadMoves'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { commitFile, git } from '../fixtures/branchRepositories'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const remote = useSocketHostFixture()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
/** A host whose own Owl answer turns on Work across machines, so it moves branches and takes moves. */
const OWL = '0.1.38-owl.20261013.1'

/**
 * This computer and forge, each with a copy of one GitHub repository: This computer's Codex project is the original, on
 * `feat/wav`, and forge's project is a clone of it with a GitHub origin of its own. The desktop reaches forge over the
 * socket as a recorded desktop, and moves threads through Watcher's view of its machines.
 */
async function machines() {
  await remote.host.close()
  // Forge's Codex reports each turn, running and then completed, as a real adapter does; these fakes send no history events.
  remote.native = new E2EAgentHost('queued-steering')
  remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: remote.native }, sottoVersion: OWL })
  remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port
  const pairing = await SocketHostService.pair(remote.url, remote.host.pairing.issuePairingCode().code, 'Synthetic desktop')
  await writeFile(join(remote.root, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
  const socket = new SocketHostService({ url: remote.url, token: pairing.token, watcherEnabled: true }); remote.clients.push(socket)
  const hello = await socket.connect()
  await socket.command({ type: 'connect', provider: 'codex' })

  const workspace = await workspaceFixture(undefined, { history: true })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: true } })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  const local = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  // This computer's copy, on a branch with a commit of its own, and forge's clone of it.
  git(local.path, 'init', '-q')
  git(local.path, 'config', 'user.name', 'Sotto test'); git(local.path, 'config', 'user.email', 'test@example.invalid')
  await commitFile(local.path, 'README.md', '# Project\n', 'Start the project')
  const forgePath = join(remote.root, 'forge-sotto')
  git(remote.root, 'clone', '-q', local.path, forgePath)
  git(forgePath, 'remote', 'set-url', 'origin', 'https://github.com/millZach/Sotto')
  git(local.path, 'remote', 'add', 'origin', 'git@github.com:millZach/Sotto.git')
  git(local.path, 'switch', '-q', '-c', 'feat/wav')
  const commit = await commitFile(local.path, 'wav.txt', 'length marker\n', 'Write the length marker per chunk')
  await socket.command({ type: 'create-project', provider: 'codex', title: 'Sotto', path: forgePath, useExisting: true })
  const forgeProject = socket.shell().host.projects.find(item => item.path === forgePath)!

  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true })
  const hostId = pairing.hostId
  router.add({ hostId, name: 'forge', kind: 'remote', service: socket, detail: (id: string) => socket.readThreadDetail(id), preview: () => null })
  const moving: { watcher?: WatcherService } = {}
  const branchMoves = new DesktopBranchMoves({ bundles: new BranchBundles({ stagingDirectory: join(f.root, 'branch-moves'), recordsPath: join(f.root, 'branch-moves.json') }),
    folders: foldersOfSnapshot(() => f.control.watcherSnapshot()), host: id => moving.watcher?.branchMoveHost(id), hostName: id => moving.watcher?.machineName(id) ?? 'That machine' })
  const facts = new HostFactsSource({ sleep: async () => undefined })
  const watcher = moving.watcher = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true, crossMachine: true,
    machineFacts: () => hostMachineReport(facts, () => ({ threads: f.control.watcherSnapshot().threads, ...f.control.watcherSendRecords() }), true),
    workerMachine: () => 'this-computer', projectOrigins: () => readProjectOrigins(f.control.shell().host.projects), branchMoves })
  watcher.useRemoteHosts(router.watcherHosts())
  await watcher.recover()
  // This computer takes a host's thread as the desktop's runtime does: it makes the moved thread itself (#1178 part 3).
  const movesHere = new HostThreadMoves(f.root, { control: f.control, workspace: workspace.host, mayAnswer: () => true, file: 'thread-moves-here.json' })
  const thisComputer = desktopWindowClient()
  const moves = new ThreadMoveService(f.root, { control: f.control, workspace: workspace.host, branches: branchMoves, watch: watcher, retryMs: 200,
    here: { supportsThreadMove: true, threadMove: request => movesHere.handle(request, thisComputer) } })
  await moves.load()
  moves.useTargets(moveTargetsOf(router.watcherHosts(), watcher, listener => router.subscribeChanges(listener)))
  cleanups.push(async () => {
    moves.close(); movesHere.close(); watcher.close(); router.dispose()
    f.control.dispose(); await f.control.closed(); await workspace.stop(); await workspace.remove()
  })

  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const native = (threadId: string): AgentThread => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters.codex.state.threads.find(item => item.id === binding.sessionId)!
  }
  const endTurn = async (threadId: string, reply: string): Promise<void> => {
    const thread = native(threadId)
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(message => message.role === 'user')!.id, status: 'completed' }
    thread.status = 'idle'
    workspace.adapters.codex.emit()
    await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  /** A thread on This computer's Codex project that answered once, at rest on `feat/wav`. */
  const source = async (title = 'WAV preview stall', options: { readonly answered?: boolean } = {}): Promise<string> => {
    const threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: local.id, title, titleSource: 'user', modelId: model.id, workingCopy: 'shared' })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'The WAV preview stalls after two seconds. Find out why.' })).error).toBeNull()
    if (options.answered !== false) await endTurn(threadId, 'The length marker was written once, before any audio arrived.')
    return threadId
  }
  const key = (threadId: string): string => hostEntityKey(f.control.hostId(), threadId)
  const prepare = (threadIds: readonly string[]): Extract<ThreadMovePrepare, { status: 'ok' }> => {
    const prepared = moves.prepare({ threadIds: threadIds.map(key), hostId })
    if (prepared.status !== 'ok') throw new Error(prepared.message)
    return prepared
  }
  const move = async (threadIds: readonly string[]): Promise<Extract<ThreadMoveStart, { status: 'ok' }>> => {
    const started = await moves.move({ confirmationId: prepare(threadIds).confirmationId, threadIds: threadIds.map(key), allowNarrower: [] })
    if (started.status !== 'ok') throw new Error(started.message)
    return started
  }
  const record = (moveId: string): MoveRecord | undefined => moves.list().find(item => item.id === moveId)
  const hostThread = (threadId: string | undefined): AgentThread | undefined => socket.shell().host.threads.find(item => item.id === threadId)
  return { ...f, workspace, socket, hello, hostId, local, forgePath, forgeProject, commit, moves, watcher, router, source, endTurn, prepare, move, record, hostThread, key }
}

describe('moving a thread from This computer to a paired host (#1178)', () => {
  it('moves it end to end: branch, new thread, first prompt at once, then the source settled and linked once that turn ends', async () => {
    const m = await machines()
    expect(m.hello.features).toContain('thread-move')
    const sourceId = await m.source()
    const prepared = m.prepare([sourceId])
    expect(prepared).toMatchObject({ machine: 'forge', threads: [{ threadId: m.key(sourceId), outcome: 'moves' }] })
    const [started] = (await m.move([sourceId])).moves
    expect(started).toMatchObject({ threadId: m.key(sourceId), outcome: 'moving' })
    const moveId = started!.moveId!
    // While it moves, the source refuses sends and wake-ups in the fence's words.
    const fence = THREAD_MOVE_WORDS.fence('forge')
    expect((await m.control.commandShell({ type: 'manual-send', threadId: sourceId, draftId: randomUUID(), text: 'One more thing.' })).error).toBe(fence)
    await expect(m.control.deliverWakeUp(sourceId, { source: 'delegation', items: [] } as never, { tool: false })).rejects.toThrow(fence)

    await vi.waitFor(() => expect(m.record(moveId)?.state).toBe('thread-started'), { timeout: 30_000 })
    const moved = m.record(moveId)!
    expect(moved).toMatchObject({ projectId: m.forgeProject.id, branch: { name: 'feat/wav', commit: m.commit } })
    // The branch landed in forge's copy under the move's own ref, and forge's checkout stayed where it was.
    expect(git(m.forgePath, 'rev-parse', `refs/sotto/incoming/${moveId}/feat/wav`)).toBe(m.commit)
    expect(git(m.forgePath, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    // Forge made the thread in a new worktree from that ref, linked back to the source, and its first prompt went at once.
    await vi.waitFor(() => expect(m.hostThread(moved.threadId)?.worktree).toMatchObject({ mode: 'independent', branch: 'feat/wav', baseCommit: m.commit }), { timeout: 30_000 })
    const there = m.hostThread(moved.threadId)!
    expect(there).toMatchObject({ title: 'WAV preview stall', projectId: m.forgeProject.id, continuedFrom: { threadId: sourceId, provider: 'codex', host: m.control.hostId() } })
    // What forge's provider was sent, whole.
    const prompt = (await remote.native.snapshot()).threads.find(item => item.title === 'WAV preview stall')!.messages.find(message => message.role === 'user')!.text
    expect(prompt.startsWith(HANDOVER_LEAD)).toBe(true)
    expect(prompt).toContain('The WAV preview stalls after two seconds.')
    expect(prompt).toContain(MOVE_HANDOVER_CLOSE)
    expect(prompt).toContain(`- Branch: feat/wav, at commit ${m.commit}.`)
    expect(prompt).toContain('This thread continues “WAV preview stall”, which ran on This computer until the user moved it here, to forge.')
    // The same move asked again answers the same thread, and makes no second one.
    const again = await m.socket.threadMove({ action: 'start', moveId, projectId: m.forgeProject.id, title: 'WAV preview stall', titleSource: 'user', modelId: there.modelId,
      from: { threadId: sourceId, provider: 'codex', hostId: m.control.hostId()! }, prompt: 'Another prompt', handover: { prefixLength: 1, prefixDigest: 'a'.repeat(64),
        counts: { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false } } })
    expect(again).toMatchObject({ type: 'started', moveId, threadId: there.id, sent: true })
    expect(m.socket.shell().host.threads.filter(thread => thread.title === 'WAV preview stall')).toHaveLength(1)
    // The source waits, fenced and unsettled, until the first turn there ends.
    expect(m.control.watcherSnapshot().threads.find(thread => thread.id === sourceId)?.workspaceSettledAt ?? null).toBeNull()
    const nativeId = (await remote.native.snapshot()).threads.find(item => item.title === 'WAV preview stall')!.id
    remote.native.event({ type: 'ready', threadId: nativeId, text: 'Picked it up from the handover.' })
    await vi.waitFor(() => expect(m.record(moveId)?.state).toBe('source-settled'), { timeout: 30_000 })
    const settled = m.control.watcherSnapshot().threads.find(thread => thread.id === sourceId)!
    expect(settled.workspaceSettledAt).toEqual(expect.any(String))
    expect(settled.continuedIn).toEqual([{ threadId: there.id, provider: 'codex', at: expect.any(String), host: m.hostId }])
    expect(m.moves.keepsWorktree(sourceId)).toBe(true)
    // The fence is lifted once the settled state is saved: a refused send changes nothing, so it is asked until one goes.
    await vi.waitFor(async () => expect((await m.control.commandShell({ type: 'manual-send', threadId: sourceId, draftId: randomUUID(), text: 'Back here.' })).error).not.toBe(fence))
  }, 120_000)

  it('keeps a thread with a turn running, and a delegated thread, here and says why', async () => {
    const m = await machines()
    const running = await m.source('Still working', { answered: false })
    const parent = await m.source('Parent')
    const child = await m.source('Child')
    await m.workspace.host.setDelegatedBy(child, parent)
    expect(m.prepare([running, child]).threads).toEqual([
      { threadId: m.key(running), outcome: 'stays', words: THREAD_MOVE_WORDS.running },
      { threadId: m.key(child), outcome: 'stays', words: THREAD_MOVE_WORDS.delegated },
    ])
    const started = await m.move([running])
    expect(started.moves).toEqual([{ threadId: m.key(running), outcome: 'stays', words: THREAD_MOVE_WORDS.running }])
    expect(m.moves.list()).toEqual([])
  }, 120_000)

  it('gives back a thread with uncommitted work, in the branch’s own words, and starts nothing on forge', async () => {
    const m = await machines()
    const sourceId = await m.source()
    await writeFile(join(m.local.path, 'scratch.txt'), 'not committed\n')
    const threadsBefore = m.socket.shell().host.threads.length
    const moveId = (await m.move([sourceId])).moves[0]!.moveId!
    // The record becomes visible before its save finishes and lifts the send fence.
    await vi.waitFor(() => {
      expect(m.record(moveId)?.state).toBe('given-back')
      expect(m.control.moveFenceOf(sourceId)).toBeUndefined()
    }, { timeout: 30_000 })
    expect(m.record(moveId)!.givenBack).toBe(THREAD_MOVE_WORDS.givenBack(branchMoveWords.uncommitted))
    expect(git(m.forgePath, 'for-each-ref', 'refs/sotto')).toBe('')
    expect(m.socket.shell().host.threads).toHaveLength(threadsBefore)
    // The source takes sends again.
    expect((await m.control.commandShell({ type: 'manual-send', threadId: sourceId, draftId: randomUUID(), text: 'Commit it first.' })).error).toBeNull()
  }, 120_000)
})

describe('a paired host’s own thread as a move’s source (#1178 part 3)', () => {
  // The fixture host reads its threads' history from provider events, which these fakes do not send, so none of its threads
  // has a confirmed send or a handover to give, and none can be held: holding, the handover, settling and letting go are
  // covered over stand-ins (tests/unit/main/threadMovesHost.test.ts, tests/unit/main/threadMoves.test.ts). This is what the
  // real socket and the host's real coordinator answer.
  it('is offered to a recorded desktop, refuses a thread that cannot move in its own words, and fences nothing', async () => {
    const m = await machines()
    expect(m.hello.features).toContain('thread-move-source')
    expect(m.socket.supportsThreadMoveSource).toBe(true)
    const forgeThread = randomUUID()
    const forgeModel = m.socket.shell().host.models.find(item => item.providerId === 'codex')!
    expect((await m.socket.command({ type: 'create-thread', threadId: forgeThread, projectId: m.forgeProject.id, title: 'Tray icon at night', titleSource: 'user', modelId: forgeModel.id, workingCopy: 'shared' })).error).toBeNull()
    await m.socket.command({ type: 'manual-send', threadId: forgeThread, draftId: randomUUID(), text: 'The tray icon goes dark at night. Find out why.' })
    await vi.waitFor(() => expect(m.hostThread(forgeThread)?.status).toBe('running'), { timeout: 30_000 })
    expect(await m.socket.threadMove({ action: 'hold', moveId: randomUUID(), threadId: forgeThread, machine: 'This computer' }))
      .toEqual({ type: 'refused', reason: 'not-movable', message: THREAD_MOVE_WORDS.running })
    const nativeId = (await remote.native.snapshot()).threads.find(item => item.title === 'Tray icon at night')!.id
    remote.native.event({ type: 'ready', threadId: nativeId, text: 'The night palette reused the light icon.' })
    await vi.waitFor(() => expect(m.hostThread(forgeThread)?.status).toBe('idle'), { timeout: 30_000 })
    // A send forge has not confirmed holds the thread there too.
    expect(await m.socket.threadMove({ action: 'hold', moveId: randomUUID(), threadId: forgeThread, machine: 'This computer' }))
      .toEqual({ type: 'refused', reason: 'not-movable', message: THREAD_MOVE_WORDS.unresolved })
    // Nothing was fenced: the thread takes sends as before.
    expect((await m.socket.command({ type: 'manual-send', threadId: forgeThread, draftId: randomUUID(), text: 'One more thing.' })).error).not.toBe(THREAD_MOVE_WORDS.fence('This computer'))
    // A step for a move forge does not hold changes nothing.
    const link = { threadId: randomUUID(), provider: 'codex' as const, hostId: m.control.hostId()!, at: new Date().toISOString() }
    expect(await m.socket.threadMove({ action: 'settle', moveId: randomUUID(), link })).toMatchObject({ type: 'refused', reason: 'unknown-move' })
    expect(m.hostThread(forgeThread)?.workspaceSettledAt ?? null).toBeNull()
    // The desktop's preview reads forge's thread as forge holds it, and says why it stays.
    const prepared = m.moves.prepare({ threadIds: [hostEntityKey(m.hostId, forgeThread)], hostId: m.control.hostId() })
    expect(prepared).toMatchObject({ status: 'ok', machine: 'This computer', threads: [{ outcome: 'stays' }] })
  }, 120_000)
})

describe('the thread-move host feature (#1178, ADR-0072)', () => {
  it('is listed only where the host’s own Owl answer turns on Work across machines', async () => {
    for (const [sottoVersion, offered] of [[OWL, true], ['0.1.37', false]] as const) {
      const directory = join(remote.root, 'host-' + String(offered)); await mkdir(directory, { recursive: true })
      const host = await startFixtureHeadlessHost({ dataDirectory: directory, port: 0, sottoVersion })
      try { expect(host.descriptor!.features.includes('thread-move')).toBe(offered) } finally { await host.close() }
    }
  })
  it('is not offered to a client the launch script did not record as a desktop, which is refused the request', async () => {
    await remote.host.close()
    remote.host = await startFixtureHeadlessHost({ dataDirectory: remote.root, port: 0, providers: { codex: remote.native }, sottoVersion: OWL })
    remote.url = 'http://127.0.0.1:' + remote.host.descriptor!.port
    const pairing = await SocketHostService.pair(remote.url, remote.host.pairing.issuePairingCode().code, 'Not a desktop')
    const client = new SocketHostService({ url: remote.url, token: pairing.token, watcherEnabled: true }); remote.clients.push(client)
    expect((await client.connect()).features).not.toContain('thread-move')
    expect(client.supportsThreadMove).toBe(false)
    const request = { action: 'start', moveId: randomUUID(), projectId: 'project', title: 'Moved', modelId: 'model',
      from: { threadId: 'source', provider: 'codex', hostId: randomUUID() }, prompt: 'Prompt', handover: { prefixLength: 6, prefixDigest: 'a'.repeat(64),
        counts: { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false } } } as const
    // This client asks nothing of a host that did not offer it, and the host refuses a peer that asks anyway.
    await expect(client.threadMove(request)).rejects.toMatchObject({ code: 'version_mismatch' })
    const peer = await rawPeer(remote.host.descriptor!.port, remote.host.pairing.signSession(pairing.clientId, Date.now()))
    cleanups.push(async () => peer.frames.close())
    await peer.call('hello', { op: 'hello' })
    expect(await peer.call('move', { op: 'thread-move', request })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  })
})
