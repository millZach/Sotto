// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/routerAndEngineIpc.perf.test.ts --maxWorkers=1 --disable-console-intercept=true
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { immutableActivities } from '../../src/main/agents/activitySnapshots'
import { DetailSends } from '../../src/main/agents/detailSends'
import { desktopWindowClient, type HostService } from '../../src/main/agents/hostService'
import {
  connectEngineClient,
  createEngineEndpoint,
  generateEngineToken,
  listenEngineServer,
} from '../../src/main/engine/transport'
import { DesktopHostRouter, type DesktopHostConnection } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import {
  AGENT_COMMAND,
  AGENT_GET,
  AGENT_THREAD_DETAIL_GET,
  type AgentCommand,
  type AgentMessage,
  type AgentState,
  type AgentThread,
  type AgentThreadDetail,
} from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { noteThreadsReplaced } from '../../src/shared/threadListPatches'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'

const PERF_ASSERT = process.env.SOTTO_PERF_ASSERT === '1'

const LOCAL_HOST = 'local-host'
const REMOTE_HOST = 'remote-host'
const LOCAL_THREADS = 1200
const REMOTE_THREADS = 240
const DETAIL_MESSAGES = 200
const DETAIL_ACTIVITIES = 1500

function makeHostState(hostId: string, count: number): AgentState {
  const projects = Array.from({ length: 12 }, (_, index) => ({
    id: `proj-${index}`,
    title: `Project ${index}`,
    path: `C:\\work\\project-${index}`,
  }))
  const threads: AgentThread[] = Array.from({ length: count }, (_, index) => ({
    id: `thread-${index}`,
    projectId: projects[index % projects.length]!.id,
    title: `Thread ${index} title for sidebar rendering`,
    modelId: 'codex:gpt-5.4',
    status: index % 17 === 0 ? 'running' : 'idle',
    updatedAt: `2026-11-22T${String(index % 24).padStart(2, '0')}:10:00.000Z`,
    messages: [],
    requests: [],
    summary: {
      messageCount: 24,
      activityCount: 60,
      lastMessageRole: 'assistant',
      lastMessagePreview: `Latest assistant reply preview for thread ${index}.`,
      lastMessageAt: `2026-11-22T${String(index % 24).padStart(2, '0')}:10:00.000Z`,
    },
  }))
  const base = emptyDesktopState(hostId)
  return {
    ...base,
    hostId,
    connection: 'connected',
    activeProjectId: projects[0]!.id,
    activeThreadId: threads[0]?.id ?? null,
    error: null,
    historyEnabled: true,
    configuration: {
      ...base.configuration,
      provider: 'codex',
      defaultModelId: 'codex:gpt-5.4',
      newThreadModelId: 'codex:gpt-5.4',
      projectsDirectory: 'C:\\work',
      enabledProviders: ['codex', 'claude'],
    },
    host: {
      ...base.host,
      hostId,
      name: hostId,
      connected: true,
      projects,
      models: [
        { id: 'codex:gpt-5.4', name: 'GPT-5.4', provider: 'Codex', ready: true },
        { id: 'claude:opus-4', name: 'Opus 4', provider: 'Claude', ready: true },
      ],
      threads,
    },
  }
}

function makeFakeHost(hostId: string, kind: 'local' | 'remote', count: number): DesktopHostConnection {
  let state = makeHostState(hostId, count)
  const listeners = new Set<(next: AgentState) => void>()

  const replyCloneWithPatch = (base: AgentState): AgentState => {
    // Mirrors AgentControl.shellOf('reply') / SocketHostService.view(): fresh top-level shell sharing threads.
    if (kind === 'local') {
      const nextHost = { ...base.host, threads: base.host.threads.slice() }
      noteThreadsReplaced(nextHost, base.host, [])
      return { ...base, host: nextHost, threadDraftPersistence: [] }
    }
    return { ...base }
  }

  const service: DesktopHostConnection['service'] = {
    shell: () => structuredClone(state),
    view: () => replyCloneWithPatch(state),
    replyView: () => replyCloneWithPatch(state),
    activeSelection: () => ({ activeThreadId: state.activeThreadId, activeProjectId: state.activeProjectId }),
    subscribe: (listener: (next: AgentState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    command: async (input: unknown) => {
      const command = input as AgentCommand
      if (command.type === 'select-thread') {
        const found = state.host.threads.find(item => item.id === command.threadId)
        const nextHost = { ...state.host, threads: state.host.threads.slice() }
        noteThreadsReplaced(nextHost, state.host, [])
        state = {
          ...state,
          activeThreadId: found?.id ?? null,
          activeProjectId: found?.projectId ?? null,
          error: null,
          host: nextHost,
          threadDraftPersistence: [],
        }
        if (kind === 'local') {
          for (const listener of listeners) listener(state)
        }
        return replyCloneWithPatch(state)
      }
      if (command.type === 'observe-threads') {
        return replyCloneWithPatch(state)
      }
      return replyCloneWithPatch(state)
    },
  } as unknown as HostService

  return {
    hostId,
    name: kind === 'local' ? 'This computer' : 'Forge',
    kind,
    service,
    detail: () => null,
    preview: () => null,
    ...(kind === 'remote' ? { observe: async () => undefined } : {}),
  }
}

function makeLargeDetail(threadId: string): { messages: AgentMessage[]; activities: readonly AgentActivity[]; detail: AgentThreadDetail } {
  const messages: AgentMessage[] = Array.from({ length: DETAIL_MESSAGES }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Message ${index} body text simulating realistic engineering discussion with file paths and explanation. `.repeat(4),
    createdAt: `2026-11-22T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
    ...(index % 25 === 0 ? {
      attachments: [{
        id: `att-${index}`,
        name: `shot-${index}.png`,
        mimeType: 'image/png',
        sizeBytes: 42_000,
      }],
    } : {}),
  }))
  const activities = immutableActivities(Array.from({ length: DETAIL_ACTIVITIES }, (_, index): AgentActivity => ({
    id: `act-${index}`,
    turnId: `msg-${index % DETAIL_MESSAGES}`,
    sequence: index,
    kind: index % 3 === 0 ? 'command' : 'tool',
    status: 'completed',
    title: `Step ${index}: inspect src/main/hosts/desktopHostRouter.ts`,
    output: `line ${index}: ok\n`.repeat(16),
    steps: [{ text: `Check ${index}`, status: 'completed' }],
  })))
  return {
    messages,
    activities,
    detail: {
      threadId,
      revision: 42,
      messages,
      activities: activities as AgentActivity[],
    },
  }
}

describe.skipIf(!PERF_BENCH && !PERF_ASSERT)('DesktopHostRouter build count, engine RPC transport and DetailSends at owner scale (#2733)', () => {
  it('measures sidebar thread-switch router builds, JSON-only engine RPC round-trips, and DetailSends.threadDetail', async () => {
    // 1. DesktopHostRouter: 1,200 local + 240 remote = 1,440 threads.
    const local = makeFakeHost(LOCAL_HOST, 'local', LOCAL_THREADS)
    const remote = makeFakeHost(REMOTE_HOST, 'remote', REMOTE_THREADS)
    const router = new DesktopHostRouter(() => makeHostState(LOCAL_HOST, 0))
    router.add(local)
    router.add(remote)
    let stateEmits = 0
    const offState = router.subscribe(() => { stateEmits++ })

    const buildSpy = vi.spyOn(router as unknown as { build: (...args: unknown[]) => unknown }, 'build')
    // Warm initial publication.
    await router.command({ type: 'select-thread', threadId: hostEntityKey(LOCAL_HOST, 'thread-0') }, desktopWindowClient())
    await router.command({ type: 'observe-threads', threadIds: [hostEntityKey(LOCAL_HOST, 'thread-0')] }, desktopWindowClient())

    const switchMs: number[] = []
    const switchBuilds: number[] = []
    const switchEmits: number[] = []
    for (let index = 1; index <= 20; index++) {
      const targetId = hostEntityKey(LOCAL_HOST, `thread-${index}`)
      buildSpy.mockClear()
      const emitsBefore = stateEmits
      const started = performance.now()
      await router.command({ type: 'select-thread', threadId: targetId }, desktopWindowClient())
      await router.command({ type: 'observe-threads', threadIds: [targetId] }, desktopWindowClient())
      switchMs.push(performance.now() - started)
      switchBuilds.push(buildSpy.mock.calls.length)
      switchEmits.push(stateEmits - emitsBefore)
    }
    const routerState = router.view()
    offState()
    router.dispose()

    // 2. EngineRpcConnection over real named pipe / UDS for AGENT_GET, AGENT_COMMAND, AGENT_THREAD_DETAIL_GET.
    const { messages, activities, detail } = makeLargeDetail('thread-1')
    const endpoint = createEngineEndpoint('sotto-perf-rpc')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)
    const rpcGetMs: number[] = []
    const rpcCommandMs: number[] = []
    const rpcDetailMs: number[] = []
    try {
      const [serverConn, clientConn] = await Promise.all([
        server.waitForClient(5_000),
        connectEngineClient(endpoint, token),
      ])
      const commandReceipt = { revision: 12, error: null, activeThreadId: hostEntityKey(LOCAL_HOST, 'thread-1'), activeProjectId: hostEntityKey(LOCAL_HOST, 'proj-1') }
      clientConn.onRequest((method, args) => {
        if (method === 'engine:invokeIpc') {
          const channel = args[0] as string
          if (channel === AGENT_GET) return routerState
          if (channel === AGENT_COMMAND) return commandReceipt
          if (channel === AGENT_THREAD_DETAIL_GET) return detail
        }
        throw new Error(`unexpected ${method}`)
      })
      // Warmup
      await serverConn.request('engine:invokeIpc', [AGENT_GET, 'main', []])
      await serverConn.request('engine:invokeIpc', [AGENT_COMMAND, 'main', [{ type: 'select-thread', threadId: hostEntityKey(LOCAL_HOST, 'thread-1') }]])
      await serverConn.request('engine:invokeIpc', [AGENT_THREAD_DETAIL_GET, 'main', [hostEntityKey(LOCAL_HOST, 'thread-1')]])

      for (let run = 0; run < 15; run++) {
        let t0 = performance.now()
        const got = await serverConn.request<AgentState>('engine:invokeIpc', [AGENT_GET, 'main', []])
        rpcGetMs.push(performance.now() - t0)
        expect(got.host.threads).toHaveLength(LOCAL_THREADS + REMOTE_THREADS)

        t0 = performance.now()
        await serverConn.request('engine:invokeIpc', [AGENT_COMMAND, 'main', [{ type: 'select-thread', threadId: hostEntityKey(LOCAL_HOST, `thread-${run}`) }]])
        rpcCommandMs.push(performance.now() - t0)

        t0 = performance.now()
        const gotDetail = await serverConn.request<AgentThreadDetail>('engine:invokeIpc', [AGENT_THREAD_DETAIL_GET, 'main', [hostEntityKey(LOCAL_HOST, 'thread-1')]])
        rpcDetailMs.push(performance.now() - t0)
        expect(gotDetail.activities).toHaveLength(DETAIL_ACTIVITIES)
      }
      clientConn.close()
      serverConn.close()
    } finally {
      await server.close()
    }

    // 3. DetailSends.threadDetail() at owner scale (200 messages + 1,500 certified activities, streamingPublishCost: true).
    const thread: AgentThread = {
      id: 'thread-1',
      projectId: 'proj-1',
      title: 'Large thread',
      modelId: 'codex:gpt-5.4',
      status: 'idle',
      messages,
      activities: activities as AgentActivity[],
      requests: [],
    }
    const detailState = makeHostState(LOCAL_HOST, 1)
    detailState.host.threads = [thread]
    const sends = new DetailSends({
      state: () => detailState,
      dependencies: { streamingPublishCost: true },
      threadById: id => id === thread.id ? thread : undefined,
      paneActivities: t => t.activities,
      presentedMessages: t => t.messages,
      revision: () => 42,
      certifiedActivitySignature: () => ({} as never),
      decorate: snapshot => {
        for (const t of snapshot.threads) for (const msg of t.messages) {
          for (const attachment of msg.attachments ?? []) delete attachment.preview
        }
      },
    })

    const origStructuredClone = globalThis.structuredClone
    let cloneCalls = 0
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
      cloneCalls++
      return origStructuredClone(value, options)
    }) as typeof structuredClone

    const detailMs: number[] = []
    const detailClones: number[] = []
    try {
      // Warmup
      sends.threadDetail('thread-1')
      for (let run = 0; run < 20; run++) {
        cloneCalls = 0
        const t0 = performance.now()
        const result = sends.threadDetail('thread-1')
        detailMs.push(performance.now() - t0)
        detailClones.push(cloneCalls)
        expect(result?.messages).toHaveLength(DETAIL_MESSAGES)
        expect(result?.activities).toHaveLength(DETAIL_ACTIVITIES)
      }
    } finally {
      globalThis.structuredClone = origStructuredClone
    }

    const summary = {
      threads: LOCAL_THREADS + REMOTE_THREADS,
      routerBuildsPerSwitch: median(switchBuilds),
      routerEmitsPerSwitch: median(switchEmits),
      routerSwitchMedianMs: round(median(switchMs), 3),
      rpcAgentGetMedianMs: round(median(rpcGetMs), 3),
      rpcAgentCommandMedianMs: round(median(rpcCommandMs), 3),
      rpcDetailGetMedianMs: round(median(rpcDetailMs), 3),
      detailSendsClonesPerRead: median(detailClones),
      detailSendsMedianMs: round(median(detailMs), 3),
    }
    console.log(`routerAndEngineIpc benchmark: ${JSON.stringify(summary)}`)

    if (PERF_ASSERT) {
      expect(summary.routerBuildsPerSwitch).toBeLessThanOrEqual(1)
      expect(summary.routerEmitsPerSwitch).toBeLessThanOrEqual(1)
      expect(summary.detailSendsClonesPerRead).toBe(0)
    }
  }, 60_000)
})
