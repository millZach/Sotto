// @vitest-environment node
// Regression tests for ADR-0216 Slice 3 cross-machine coordination bugs (L1-L8) and edge cases (N1-N6).
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentHostSnapshot, AgentMessage, AgentRuntimeMode, AgentState, AgentThread } from '../../../src/shared/agents'
import { EMPTY_AGENT_HOST } from '../../../src/shared/agents'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import {
  COORDINATION_PROMPTS_PER_TARGET, COORDINATION_RATE_LIMIT, coordinateReadThreadInputSchema, coordinateSendInputSchema,
  type CoordinationExchangeView, type CoordinationNews,
} from '../../../src/shared/threadCoordination'
import type { CoordinationRelayAsk, CoordinationRelayedReply, CoordinationRemoteAsk } from '../../../src/shared/threadCoordinationRelay'
import {
  ThreadCoordinationService, type CoordinationControlHooks, type CoordinationCoordinator, type CoordinationHost,
  type CoordinationRelayAdapter,
} from '../../../src/main/agents/threadCoordination'
import {
  DesktopCoordinationRelay, HostCoordinationRelay, type CoordinationRelayConnection, type CoordinationRelayHostSource,
} from '../../../src/main/agents/threadCoordinationRelay'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function makeThread(id: string, overrides: Partial<AgentThread> = {}): AgentThread {
  const createdAt = overrides.updatedAt ?? '2026-11-23T10:00:00.000Z'
  return {
    id,
    projectId: 'proj-1',
    title: `Thread ${id}`,
    modelId: 'claude:sonnet',
    providerId: 'claude',
    runtimeMode: 'auto-accept-edits',
    status: 'idle',
    updatedAt: createdAt,
    messages: [
      { id: `${id}-u1`, role: 'user', text: 'Initial user prompt', createdAt },
      { id: `${id}-a1`, role: 'assistant', text: 'Initial assistant reply', createdAt },
    ],
    requests: [],
    ...overrides,
  }
}

async function createServiceHarness(options: {
  readonly hostId?: string
  readonly threads?: AgentThread[]
  readonly historyEnabled?: boolean
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sotto-coord-relay-unit-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  const hostId = options.hostId ?? randomUUID()
  const threads = options.threads ?? [makeThread('t-caller')]
  const snapshot: AgentHostSnapshot = {
    ...structuredClone(EMPTY_AGENT_HOST),
    hostId,
    connected: true,
    providers: [{
      id: 'claude',
      name: 'Claude Code',
      version: '1.0',
      connection: 'connected',
      capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true },
    }],
    projects: [{ id: 'proj-1', title: 'Sotto', path: '/repo/sotto', providerId: 'claude' }],
    models: [{ id: 'claude:sonnet', provider: 'Claude Code', providerId: 'claude', name: 'Sonnet', ready: true, runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] }],
    threads,
  }
  let hooks: CoordinationControlHooks | undefined
  const wakeUps: Array<{ threadId: string; news: CoordinationNews; text: string | undefined }> = []
  const commands: AgentCommand[] = []

  const control: CoordinationCoordinator = {
    hostId: () => hostId,
    watcherSnapshot: () => snapshot,
    useCoordination: h => { hooks = h; return () => { hooks = undefined } },
    commandFromCoordination: async (command, guard) => {
      guard()
      commands.push(command)
      const target = snapshot.threads.find(item => item.id === command.threadId)!
      const draftId = command.draftId ?? randomUUID()
      const messageId = hooks?.messageIdFor(draftId) ?? randomUUID()
      const stamp = new Date().toISOString()
      target.messages.push({ id: messageId, role: 'user', text: command.text, createdAt: stamp })
      target.status = 'running'
      target.updatedAt = stamp
      return {
        host: snapshot,
        activeProjectId: null,
        activeThreadId: null,
        configuration: {} as AgentState['configuration'],
        commandReceipts: [{ commandId: draftId, draftId, threadId: command.threadId, status: 'accepted' }],
        error: null,
      } as unknown as AgentState
    },
    hasUserDraft: () => false,
    refreshCoordinationObservation: () => undefined,
    deliverWakeUp: async (threadId, news) => {
      wakeUps.push({ threadId, news, text: hooks?.newsText(threadId, [news]) })
    },
  }
  const host: CoordinationHost = {
    threadMessage: (threadId, messageId) => snapshot.threads.find(item => item.id === threadId)?.messages.find(item => item.id === messageId),
    threadMessages: threadId => snapshot.threads.find(item => item.id === threadId)?.messages ?? [],
  }
  const service = new ThreadCoordinationService({
    directory: dir,
    control,
    host,
    historyEnabled: () => options.historyEnabled ?? true,
  })
  cleanups.push(() => { service.close() })
  await service.recover()

  const finishTurn = (threadId: string, replyText: string): AgentMessage => {
    const target = snapshot.threads.find(item => item.id === threadId)!
    const lastUser = [...target.messages].reverse().find(m => m.role === 'user')!
    const stamp = new Date().toISOString()
    const reply: AgentMessage = { id: randomUUID(), role: 'assistant', text: replyText, createdAt: stamp }
    target.messages.push(reply)
    target.lastTurn = { id: lastUser.id, status: 'completed' }
    target.status = 'idle'
    target.updatedAt = stamp
    hooks?.observe(snapshot)
    return reply
  }

  return { dir, hostId, snapshot, service, control, host, wakeUps, commands, finishTurn, hooks: () => hooks }
}

describe('cross-machine coordination relay regressions (L1-L8, N1-N6)', () => {
  it('L1: keeps mirror charged & uncertain on relay timeout/drop after forwarding, then resolves via late news or read_exchange', async () => {
    const sender = await createServiceHarness()
    const target = await createServiceHarness({ threads: [makeThread('t-target')] })
    const remoteHostId = target.hostId

    let deliveredExchangeId = ''
    const relay: CoordinationRelayAdapter = {
      localMachineName: () => 'MacBook',
      ask: async ask => {
        if (ask.type === 'send') {
          // Target actually receives and delivers the message, then relay times out on the way back.
          await target.service.sendToThreadForRemote('desktop-1', ask.caller, ask.exchangeId, ask.input)
          deliveredExchangeId = ask.exchangeId
          return { status: 'refused', code: 'HOST_UNAVAILABLE', uncertain: true, message: 'Timed out.' }
        }
        if (ask.type === 'read-exchange') {
          return await target.service.readExchangeForRemote('desktop-1', ask.caller.hostId, ask.caller.threadId, ask.exchangeId)
        }
        return { status: 'refused', code: 'HOST_UNAVAILABLE', message: 'unexpected' }
      },
    }
    sender.service.useRelay(relay)

    const sendRes = await sender.service.sendToThread('t-caller', {
      threadId: 't-target',
      hostId: remoteHostId,
      message: 'Check staging health.',
    })
    // Must return an uncertain receipt carrying exchangeId (never "Nothing was sent" or deleted mirror).
    expect(sendRes).toMatchObject({
      status: 'ok',
      exchangeId: deliveredExchangeId,
      deliveryState: 'uncertain',
      outcome: 'unknown',
    })
    expect(String(sendRes.note)).toContain('read_exchange')
    expect((await sender.service.readExchange('t-caller', {}) as { limits: { recentSentInWindow: number } }).limits.recentSentInWindow).toBe(1)

    // Calling read_exchange queries the target host and promotes the uncertain mirror to working!
    const polled = await sender.service.readExchange('t-caller', { exchangeId: deliveredExchangeId })
    expect(polled).toMatchObject({ status: 'ok', exchangeId: deliveredExchangeId, deliveryState: 'accepted', outcome: 'working' })

    // Target finishes and late outcome news arrives -> sender wakes with the reply!
    const reply = target.finishTurn('t-target', 'Staging is green.')
    await sender.service.applyRelayedNews(
      't-caller',
      { source: 'coordination', items: [{ exchangeId: deliveredExchangeId, threadId: 't-target', outcome: 'answered' }] },
      [{ exchangeId: deliveredExchangeId, messageId: reply.id, text: 'Staging is green.', truncated: false }],
      undefined,
      remoteHostId,
    )
    expect(sender.wakeUps).toHaveLength(1)
    expect(sender.wakeUps[0]?.text).toContain('Staging is green.')
  })

  it('L2: retry_key retry across timeout/different desktop adopts target exchangeId without duplicate delivery', async () => {
    const sender = await createServiceHarness({ historyEnabled: false })
    const target = await createServiceHarness({ threads: [makeThread('t-target')] })
    const retryKey = randomUUID()
    let sendCount = 0
    let firstExchangeId = ''

    const relay: CoordinationRelayAdapter = {
      localMachineName: () => 'MacBook',
      ask: async ask => {
        if (ask.type === 'send') {
          sendCount++
          // Simulate retrying through a different desktop clientId on the second call!
          const desktopClient = sendCount === 1 ? 'desktop-A' : 'desktop-B'
          const res = await target.service.sendToThreadForRemote(desktopClient, ask.caller, ask.exchangeId, ask.input)
          if (sendCount === 1) {
            firstExchangeId = ask.exchangeId
            // Simulate sender losing its local mirror (e.g. history-off restart) by returning a pre-forward-like error?
            // No, test the exact re-key path: target returns original exchangeId when caller calls with a fresh exchangeId!
            return res
          }
          return res
        }
        if (ask.type === 'read-exchange') {
          return await target.service.readExchangeForRemote('desktop-B', ask.caller.hostId, ask.caller.threadId, ask.exchangeId)
        }
        return { status: 'refused', code: 'HOST_UNAVAILABLE', message: 'unexpected' }
      },
    }
    sender.service.useRelay(relay)

    // First send delivers on target with firstExchangeId.
    const first = await sender.service.sendToThread('t-caller', {
      threadId: 't-target',
      hostId: target.hostId,
      message: 'Run migrations.',
      retry_key: retryKey,
    })
    expect(first).toMatchObject({ status: 'ok', exchangeId: firstExchangeId })
    expect(target.commands).toHaveLength(1)

    // Second service instance (simulating sender restart with history off, so sender generates a FRESH exchangeId on retry_key retry).
    const sender2 = await createServiceHarness({ hostId: sender.hostId, historyEnabled: false })
    sender2.service.useRelay(relay)
    const second = await sender2.service.sendToThread('t-caller', {
      threadId: 't-target',
      hostId: target.hostId,
      message: 'Run migrations.',
      retry_key: retryKey,
    })
    // Target deduplicated across desktop-A -> desktop-B (only 1 command delivered) and returned firstExchangeId;
    // sender2's mirror MUST adopt firstExchangeId so late news & read_exchange match!
    expect(target.commands).toHaveLength(1)
    expect(second).toMatchObject({ status: 'ok', exchangeId: firstExchangeId })

    const reply = target.finishTurn('t-target', 'Migrations applied.')
    await sender2.service.applyRelayedNews(
      't-caller',
      { source: 'coordination', items: [{ exchangeId: firstExchangeId, threadId: 't-target', outcome: 'answered' }] },
      [{ exchangeId: firstExchangeId, messageId: reply.id, text: 'Migrations applied.', truncated: false }],
      undefined,
      target.hostId,
    )
    expect(sender2.wakeUps).toHaveLength(1)
    expect(sender2.wakeUps[0]?.text).toContain('Migrations applied.')
    const read = await sender2.service.readExchange('t-caller', { exchangeId: firstExchangeId })
    expect(read).toMatchObject({ status: 'ok', exchangeId: firstExchangeId, outcome: 'answered', reply: { text: 'Migrations applied.' } })
  })

  it('L3: enforces PROMPT_LIMIT and RATE_LIMIT across parallel remote sends without clobbering rate timestamps', async () => {
    const sender = await createServiceHarness()
    const targetHostId = randomUUID()
    let relayCalls = 0
    const pendingResolvers: Array<() => void> = []

    sender.service.useRelay({
      localMachineName: () => 'MacBook',
      ask: async ask => {
        relayCalls++
        await new Promise<void>(resolve => { pendingResolvers.push(resolve) })
        return {
          status: 'ok',
          exchangeId: ask.type === 'send' ? ask.exchangeId : randomUUID(),
          delivery: 'queued',
          deliveryState: 'queued',
          outcome: 'working',
        }
      },
    })

    // Fire 8 parallel remote sends to the SAME target: only PROMPT_LIMIT (4) may cross the relay!
    const sameTargetPromises = Array.from({ length: 8 }, (_, i) =>
      sender.service.sendToThread('t-caller', { threadId: 't-same', hostId: targetHostId, message: `Parallel ${i}` }),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(relayCalls).toBe(COORDINATION_PROMPTS_PER_TARGET)
    for (const release of pendingResolvers.splice(0)) release()
    const sameTargetResults = await Promise.all(sameTargetPromises)
    expect(sameTargetResults.filter(r => r.status === 'ok')).toHaveLength(COORDINATION_PROMPTS_PER_TARGET)
    expect(sameTargetResults.filter(r => r.code === 'PROMPT_LIMIT')).toHaveLength(8 - COORDINATION_PROMPTS_PER_TARGET)

    // Now fire 5 more parallel remote sends to DIFFERENT targets: only 2 more fit inside RATE_LIMIT (6 total), 3 get RATE_LIMIT!
    const diffTargetPromises = Array.from({ length: 5 }, (_, i) =>
      sender.service.sendToThread('t-caller', { threadId: `t-other-${i}`, hostId: targetHostId, message: `Other ${i}` }),
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(relayCalls).toBe(COORDINATION_RATE_LIMIT)
    for (const release of pendingResolvers.splice(0)) release()
    const diffTargetResults = await Promise.all(diffTargetPromises)
    expect(diffTargetResults.filter(r => r.status === 'ok')).toHaveLength(COORDINATION_RATE_LIMIT - COORDINATION_PROMPTS_PER_TARGET)
    expect(diffTargetResults.filter(r => r.code === 'RATE_LIMIT')).toHaveLength(5 - (COORDINATION_RATE_LIMIT - COORDINATION_PROMPTS_PER_TARGET))

    // All 6 timestamps must be preserved (no overwrite by stale snapshot).
    const summary = await sender.service.readExchange('t-caller', {}) as { limits: { recentSentInWindow: number } }
    expect(summary.limits.recentSentInWindow).toBe(COORDINATION_RATE_LIMIT)
  })

  it('L4: strips host-claimed runtimeMode when the authenticated host snapshot thread lacks runtimeMode', async () => {
    const desktop = await createServiceHarness({ threads: [makeThread('t-desktop', { runtimeMode: 'full-access' })] })
    const relay = new DesktopCoordinationRelay({
      service: desktop.service,
      localHostId: () => desktop.hostId,
      localMachineName: () => 'MacBook',
    })
    cleanups.push(() => { relay.close() })

    const remoteHostId = randomUUID()
    const answers: Array<{ askId: string; answer: unknown }> = []
    let triggerAsk: ((askId: string, ask: CoordinationRelayAsk) => void) | undefined
    const threadWithoutMode = makeThread('t-remote-nomode')
    delete (threadWithoutMode as { runtimeMode?: AgentRuntimeMode }).runtimeMode

    const conn: CoordinationRelayConnection = {
      kind: 'remote',
      hostId: remoteHostId,
      name: 'UntrustedHost',
      available: () => true,
      service: {
        supportsCoordinationRelay: true,
        view: () => ({ host: { ...structuredClone(EMPTY_AGENT_HOST), hostId: remoteHostId, threads: [threadWithoutMode] } }) as AgentState,
        subscribeCoordinationRelay: listener => { triggerAsk = listener; return () => { triggerAsk = undefined } },
        answerCoordinationRelay: async (askId, answer) => { answers.push({ askId, answer }) },
      },
    }
    const source: CoordinationRelayHostSource = {
      subscribeConnected: () => () => undefined,
      remoteConnections: () => [conn],
    }
    relay.useHosts(source)

    // Malicious/stale host claims runtimeMode:'full-access' even though its snapshot thread has NO runtimeMode!
    const askId = randomUUID()
    triggerAsk!(askId, {
      type: 'send',
      targetHostId: desktop.hostId,
      exchangeId: randomUUID(),
      caller: {
        threadId: 't-remote-nomode',
        hostId: remoteHostId,
        title: 'Spoofed',
        projectId: 'proj-1',
        runtimeMode: 'full-access',
      },
      input: { threadId: 't-desktop', message: 'Attempt privilege escalation' },
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(answers).toHaveLength(1)
    expect(answers[0]?.answer).toMatchObject({ status: 'refused', code: 'PERMISSION_NOT_COMPARABLE' })
    expect(desktop.commands).toHaveLength(0)
  })

  it('L5: list_threads(hostId:"all") pages past 50 threads per machine and sums true per-host totals', async () => {
    const desktop = await createServiceHarness({ threads: [makeThread('t-local-caller')] })
    const relay = new DesktopCoordinationRelay({
      service: desktop.service,
      localHostId: () => desktop.hostId,
      localMachineName: () => 'MacBook',
    })
    cleanups.push(() => { relay.close() })

    const remoteHostId = randomUUID()
    const remoteThreads = Array.from({ length: 65 }, (_, i) => ({
      threadId: `remote-${String(i).padStart(3, '0')}`,
      title: `Remote ${i}`,
      updatedAt: new Date(Date.UTC(2026, 10, 23, 10, 0, 65 - i)).toISOString(),
      canMessage: true,
    }))

    const conn: CoordinationRelayConnection = {
      kind: 'remote',
      hostId: remoteHostId,
      name: 'BigHost',
      available: () => true,
      service: {
        supportsCoordinationRelay: true,
        coordinationRemoteAsk: async (ask: CoordinationRemoteAsk) => {
          if (ask.type !== 'list') return { status: 'refused', code: 'INVALID_INPUT', message: 'bad' }
          const cursor = ask.input.cursor ?? 0
          const limit = ask.input.limit ?? 20
          const page = remoteThreads.slice(cursor, cursor + limit)
          return {
            status: 'ok',
            hostId: remoteHostId,
            scope: 'all',
            total: remoteThreads.length,
            nextCursor: cursor + page.length < remoteThreads.length ? cursor + page.length : null,
            threads: page,
          }
        },
      },
    }
    relay.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => [conn] })

    const page1 = await desktop.service.listThreads('t-local-caller', { hostId: 'all', cursor: 0, limit: 50 })
    expect(page1).toMatchObject({ status: 'ok', total: 65, nextCursor: 50 })
    expect((page1.threads as unknown[]).length).toBe(50)

    const page2 = await desktop.service.listThreads('t-local-caller', { hostId: 'all', cursor: 50, limit: 50 })
    expect(page2).toMatchObject({ status: 'ok', total: 65, nextCursor: null })
    expect((page2.threads as unknown[]).length).toBe(15)
    const ids = [...(page1.threads as Array<{ threadId: string }>), ...(page2.threads as Array<{ threadId: string }>)].map(t => t.threadId)
    expect(new Set(ids).size).toBe(65)
  })

  it('L6 & N2: documents host:<hostId>:<threadId>, accepts both qualified formats, and rejects hostId:"local" mismatch', async () => {
    expect(coordinateReadThreadInputSchema.shape.threadId.description).toContain('host:<hostId>:<threadId>')
    expect(coordinateSendInputSchema.shape.threadId.description).toContain('host:<hostId>:<threadId>')

    const sender = await createServiceHarness()
    const remoteHostId = randomUUID()
    const seenAsks: CoordinationRelayAsk[] = []
    sender.service.useRelay({
      localMachineName: () => 'MacBook',
      ask: async ask => {
        seenAsks.push(ask)
        return { status: 'ok', thread: { threadId: 't-remote', title: 'Remote' }, messages: [] }
      },
    })

    // Canonical host:<uuid>:<id>
    const r1 = await sender.service.readThread('t-caller', { threadId: hostEntityKey(remoteHostId, 't-remote') })
    expect(r1.status).toBe('ok')
    // Bare <uuid>:<id>
    const r2 = await sender.service.readThread('t-caller', { threadId: `${remoteHostId}:t-remote` })
    expect(r2.status).toBe('ok')
    expect(seenAsks).toHaveLength(2)
    expect(seenAsks.every(a => a.targetHostId === remoteHostId && a.type === 'read' && a.input.threadId === 't-remote')).toBe(true)

    // N2: hostId:"local" with a remote host-qualified id must refuse with INVALID_INPUT rather than looking up locally!
    const mismatch = await sender.service.readThread('t-caller', { threadId: hostEntityKey(remoteHostId, 't-remote'), hostId: 'local' })
    expect(mismatch).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  })

  it('L8: queues host->desktop->host outcome news when origin host is offline and replays on reconnect, plus host replay on desktopConnected', async () => {
    const desktop = await createServiceHarness()
    const relay = new DesktopCoordinationRelay({
      service: desktop.service,
      localHostId: () => desktop.hostId,
      localMachineName: () => 'MacBook',
    })
    cleanups.push(() => { relay.close() })

    const hostAId = randomUUID()
    const hostBId = randomUUID()
    let hostAOnline = false
    let notifySubA: ((state: AgentState) => void) | undefined
    const receivedByA: Array<{ threadId: string; news: CoordinationNews; replies?: readonly CoordinationRelayedReply[] }> = []
    let emitNewsFromB: ((payload: { callerThreadId: string; callerHostId: string; news: CoordinationNews; replies?: readonly CoordinationRelayedReply[]; exchange?: CoordinationExchangeView }) => void) | undefined

    const connA: CoordinationRelayConnection = {
      kind: 'remote',
      hostId: hostAId,
      name: 'Forge-A',
      available: () => hostAOnline,
      service: {
        supportsCoordinationRelay: true,
        subscribe: listener => { notifySubA = listener; return () => { notifySubA = undefined } },
        coordinationRelayNews: async (threadId, news, replies) => {
          if (!hostAOnline) throw new Error('offline')
          receivedByA.push({ threadId, news, ...(replies ? { replies } : {}) })
        },
      },
    }
    const connB: CoordinationRelayConnection = {
      kind: 'remote',
      hostId: hostBId,
      name: 'Forge-B',
      available: () => true,
      service: {
        supportsCoordinationRelay: true,
        subscribeCoordinationRemoteNews: listener => { emitNewsFromB = listener; return () => { emitNewsFromB = undefined } },
      },
    }
    relay.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => [connA, connB] })

    // Host B emits outcome news while Host A is offline.
    const exchangeId = randomUUID()
    emitNewsFromB!({
      callerThreadId: 't-a',
      callerHostId: hostAId,
      news: { source: 'coordination', items: [{ exchangeId, threadId: 't-b', outcome: 'answered' }] },
      replies: [{ exchangeId, messageId: 'm-1', text: 'Done while A was away.', truncated: false }],
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(receivedByA).toHaveLength(0)

    // Host A comes back online and emits a socket state update -> queued news flushes immediately!
    hostAOnline = true
    notifySubA?.({} as AgentState)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(receivedByA).toHaveLength(1)
    expect(receivedByA[0]?.replies?.[0]?.text).toBe('Done while A was away.')

    // Also test HostCoordinationRelay.desktopConnected replaying untold remote news after desktop was offline when turn finished!
    const targetHost = await createServiceHarness({ threads: [makeThread('t-target')] })
    const hostRelay = new HostCoordinationRelay({ recorded: () => true, mayAnswer: () => true, localMachineName: () => 'Forge-B' })
    hostRelay.useService(targetHost.service)
    cleanups.push(() => { hostRelay.close() })

    const ex2 = randomUUID()
    await targetHost.service.sendToThreadForRemote('desktop-1', {
      threadId: 't-caller',
      hostId: desktop.hostId,
      title: 'Desktop',
      projectId: 'proj-1',
      runtimeMode: 'auto-accept-edits',
    }, ex2, { threadId: 't-target', message: 'Finish while desktop is offline.' })
    // No desktop connected when target finishes!
    targetHost.finishTurn('t-target', 'Finished offline.')
    await new Promise(resolve => setTimeout(resolve, 20))

    // Desktop reconnects -> HostCoordinationRelay.desktopConnected replays the untold news!
    const pushedNews: Array<{ callerThreadId: string; news: CoordinationNews }> = []
    hostRelay.desktopConnected({
      clientId: 'desktop-1',
      pushAsk: () => true,
      pushRemoteNews: payload => { pushedNews.push({ callerThreadId: payload.callerThreadId, news: payload.news }); return true },
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(pushedNews).toHaveLength(1)
    expect(pushedNews[0]?.news.items[0]?.exchangeId).toBe(ex2)
  })

  it('N1, N3, N4, N5, N6: checks peerHostId on news, headless hostId:"all" fallback, restart without double wake, live host rename, and own-host canMessage', async () => {
    // N1: mismatched sourceHostId or unknown exchangeId never caches reply or mutates mirror.
    const sender = await createServiceHarness()
    const realTargetHost = randomUUID()
    const wrongHost = randomUUID()
    let exId = ''
    sender.service.useRelay({
      localMachineName: () => 'MacBook',
      ask: async ask => {
        exId = ask.type === 'send' ? ask.exchangeId : ''
        return { status: 'ok', exchangeId: exId, delivery: 'started', deliveryState: 'accepted', outcome: 'working' }
      },
    })
    await sender.service.sendToThread('t-caller', { threadId: 't-peer', hostId: realTargetHost, message: 'Hello peer' })
    await sender.service.applyRelayedNews(
      't-caller',
      { source: 'coordination', items: [{ exchangeId: exId, threadId: 't-peer', outcome: 'answered' }] },
      [{ exchangeId: exId, messageId: 'm-spoof', text: 'Spoofed reply', truncated: false }],
      undefined,
      wrongHost,
    )
    expect(sender.wakeUps).toHaveLength(0)
    expect(sender.service.reply('t-caller', exId)).toBeUndefined()

    // N4: restarting sender with an accepted working remote mirror keeps it working without premature 'unknown' wake-up.
    await sender.service.drained()
    const restarted = new ThreadCoordinationService({
      directory: sender.dir,
      control: sender.control,
      host: sender.host,
      historyEnabled: () => true,
    })
    cleanups.push(() => { restarted.close() })
    await restarted.recover()
    expect(sender.wakeUps).toHaveLength(0)
    // Real outcome arriving after restart wakes the sender exactly ONCE!
    await restarted.applyRelayedNews(
      't-caller',
      { source: 'coordination', items: [{ exchangeId: exId, threadId: 't-peer', outcome: 'answered' }] },
      [{ exchangeId: exId, messageId: 'm-real', text: 'Real post-restart reply', truncated: false }],
      undefined,
      realTargetHost,
    )
    expect(sender.wakeUps).toHaveLength(1)
    expect(sender.wakeUps[0]?.text).toContain('Real post-restart reply')

    // N4 part 2: provisional in-flight remote mirror is NOT written to disk even when another concurrent exchange persists!
    const diskHarness = await createServiceHarness({ threads: [makeThread('t-caller'), makeThread('t-local-peer')] })
    let releaseSlowAsk: (() => void) | undefined
    diskHarness.service.useRelay({
      localMachineName: () => 'MacBook',
      ask: async () => await new Promise(resolve => {
        releaseSlowAsk = () => resolve({ status: 'refused', code: 'PERMISSION_TOO_WIDE', message: 'refused' })
      }),
    })
    const inFlight = diskHarness.service.sendToThread('t-caller', { threadId: 't-peer', hostId: realTargetHost, message: 'Slow ask' })
    await new Promise(resolve => setTimeout(resolve, 10))
    // Force a real persist while the remote ask is still in flight.
    const localSend = await diskHarness.service.sendToThread('t-caller', { threadId: 't-local-peer', message: 'Concurrent local send' })
    expect(localSend.status).toBe('ok')
    await diskHarness.service.drained()
    const onDisk = JSON.parse(await readFile(join(diskHarness.dir, 'thread-coordination.json'), 'utf8')) as { exchanges: Array<{ remoteMirror?: boolean; id: string }> }
    expect(onDisk.exchanges).toHaveLength(1)
    expect(onDisk.exchanges[0]?.id).toBe(localSend.exchangeId)
    expect(onDisk.exchanges.some(e => e.remoteMirror === true)).toBe(false)
    releaseSlowAsk!()
    await inFlight

    // N3: headless host with NO desktop connected still lists its own threads under hostId:"all".
    const headless = await createServiceHarness({ threads: [makeThread('t-a'), makeThread('t-b', { title: 'Sibling on headless' })] })
    const disconnectedHostRelay = new HostCoordinationRelay({ recorded: () => true, mayAnswer: () => true, localMachineName: () => 'HeadlessBox' })
    disconnectedHostRelay.useService(headless.service)
    cleanups.push(() => { disconnectedHostRelay.close() })
    const allOffline = await headless.service.listThreads('t-a', { hostId: 'all' })
    expect(allOffline.status).toBe('ok')
    expect(allOffline.hostId).toBe('all')
    expect((allOffline.threads as Array<{ threadId: string; machine: string }>)).toEqual([
      expect.objectContaining({ threadId: 't-b', machine: 'HeadlessBox' }),
    ])
    expect(allOffline.unavailableHosts).toBeDefined()

    // N6: hostId:"all" asking about a host's own threads through a desktop without remote-answer grant still evaluates canMessage locally!
    const restrictedHost = await createServiceHarness({
      threads: [
        makeThread('t-caller-auto', { runtimeMode: 'auto' }),
        makeThread('t-sibling-auto', { runtimeMode: 'auto' }),
      ],
    })
    const restrictedRelay = new HostCoordinationRelay({ recorded: () => true, mayAnswer: () => false, localMachineName: () => 'Forge' })
    restrictedRelay.useService(restrictedHost.service)
    cleanups.push(() => { restrictedRelay.close() })
    const listSelf = await restrictedRelay.handleRemoteAsk('desktop-no-answers', {
      type: 'list',
      caller: { threadId: 't-caller-auto', hostId: restrictedHost.hostId, title: 'Caller', projectId: 'proj-1', runtimeMode: 'auto' },
      input: { hostId: 'all' },
    })
    expect(listSelf.status).toBe('ok')
    expect((listSelf.threads as Array<{ threadId: string; canMessage: boolean }>)[0]).toMatchObject({ threadId: 't-sibling-auto', canMessage: true })

    // N5: host rename updates machineName dynamically without re-following service.
    const renameDesktop = await createServiceHarness({ threads: [makeThread('t-d')] })
    const renameRelay = new DesktopCoordinationRelay({
      service: renameDesktop.service,
      localHostId: () => renameDesktop.hostId,
      localMachineName: () => 'MacBook',
    })
    cleanups.push(() => { renameRelay.close() })
    const renamedHostId = randomUUID()
    let emitRenamedNews: ((payload: { callerThreadId: string; callerHostId: string; news: CoordinationNews; exchange?: CoordinationExchangeView }) => void) | undefined
    const sharedService = {
      supportsCoordinationRelay: true,
      subscribeCoordinationRemoteNews: (listener: typeof emitRenamedNews) => { emitRenamedNews = listener; return () => { emitRenamedNews = undefined } },
    }
    let currentConn: CoordinationRelayConnection = { kind: 'remote', hostId: renamedHostId, name: 'OldName', available: () => true, service: sharedService }
    const connectedListeners = new Set<(c: CoordinationRelayConnection) => void>()
    renameRelay.useHosts({
      subscribeConnected: l => { connectedListeners.add(l); return () => connectedListeners.delete(l) },
      remoteConnections: () => [currentConn],
    })
    const applySpy = vi.spyOn(renameDesktop.service, 'applyRelayedNews')
    // Swap connection wrapper with renamed host name (same underlying service, as DesktopHostRouter does).
    currentConn = { kind: 'remote', hostId: renamedHostId, name: 'NewName', available: () => true, service: sharedService }
    for (const l of connectedListeners) l(currentConn)
    emitRenamedNews!({
      callerThreadId: 't-d',
      callerHostId: renameDesktop.hostId,
      news: { source: 'coordination', items: [{ exchangeId: randomUUID(), threadId: 't-r', outcome: 'answered' }] },
      exchange: {
        id: randomUUID(), direction: 'sent', peerThreadId: 't-r', peerTitle: 'R', peerProvider: 'codex',
        messageId: randomUUID(), delivery: 'started', deliveryState: 'accepted', outcome: 'answered',
        hopCount: 1, hopMax: 6, expectReply: true, hasReply: true,
        createdAt: '2026-11-23T10:00:00.000Z', updatedAt: '2026-11-23T10:00:00.000Z',
      },
    })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(applySpy).toHaveBeenCalledWith('t-d', expect.anything(), undefined, expect.objectContaining({ peerMachine: 'NewName', peerHostId: renamedHostId }), renamedHostId)
  })
})
