// @vitest-environment node
/**
 * Cross-host (`LOC <-> REM`) sidebar switch broadcast path at owner scale (#2733):
 * exercises `AgentStateBroadcaster` -> preload `createSottoBridge` / `hostClientBridge` -> renderer `wrapAgentBridge`
 * across alternating local and remote host selections where `configuration` changes while `clientScoped` stays
 * unchanged in `kept`.
 *
 * Before fixing `src/preload/hostClientBridge.ts`, `receive()` saw `'host' in value && 'configuration' in value` with
 * `clientScoped` omitted in `kept`, throwing "The host identity changed" on `LOC -> REM` and crashing inside
 * `clientAgentState()` on `REM -> LOC`. Each dropped broadcast broke the kept-parts base on the next broadcast and
 * forced a full `AGENT_GET` (`wholeReads.broadcastParts = 1`, often also `answerThreads = 1`).
 *
 * Run the repeatable owner-scale benchmark with:
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/crossHostSwitchBroadcast.perf.test.ts --maxWorkers=1 --disable-console-intercept=true
 *   sh:          SOTTO_PERF_BENCH=1 npx vitest run tests/perf/crossHostSwitchBroadcast.perf.test.ts --maxWorkers=1 --disable-console-intercept=true
 */
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../fixtures/preloadElectron')).preloadElectron())
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { createSottoBridge } from '../../src/preload'
import { onWholeRead, wrapAgentBridge, type WholeReadCause } from '../../src/renderer/src/agents/agentStateCatalogs'
import { AGENT_COMMAND, AGENT_GET, AGENT_STATE, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentModel, type AgentState, type AgentThread } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { agentThread, threadsStateFixture } from '../fixtures/agentState'
import { PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget } from '../fixtures/perfBudget'

const LOCAL_HOST = '11111111-1111-4111-8111-111111111111'
const REMOTE_HOST = '22222222-2222-4222-8222-222222222222'

const LOCAL_MODELS: AgentModel[] = Array.from({ length: 40 }, (_, i) => ({ id: `codex:local-model-${i}`, provider: 'codex', name: `Local ${i}`, ready: true }))
const REMOTE_MODELS: AgentModel[] = Array.from({ length: 40 }, (_, i) => ({ id: `codex:remote-model-${i}`, provider: 'codex', name: `Remote ${i}`, ready: true }))

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })

const settle = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)) }

function buildRoutedState(
  selectedHost: typeof LOCAL_HOST | typeof REMOTE_HOST,
  activeThreadId: string,
  threads: readonly AgentThread[],
  connections: NonNullable<AgentState['connections']>,
  configVersion = 0,
): AgentState {
  const isRemote = selectedHost === REMOTE_HOST
  const config = {
    ...defaultAgentConfiguration(),
    projectsDirectory: isRemote ? `/home/forge/projects-${configVersion}` : `C:\\Users\\owner\\projects-${configVersion}`,
  }
  const base = threadsStateFixture({
    cloneOverrides: false,
    configuration: config,
    host: {
      hostId: selectedHost,
      models: isRemote ? REMOTE_MODELS : LOCAL_MODELS,
      projects: [
        { id: hostEntityKey(LOCAL_HOST, 'proj-local'), title: 'Local Repo', path: 'C:\\repo' },
        { id: hostEntityKey(REMOTE_HOST, 'proj-remote'), title: 'Forge Repo', path: '/repo' },
      ],
      threads: [...threads],
      clientHosts: [
        { hostId: LOCAL_HOST, connected: true, models: LOCAL_MODELS, capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true } },
        { hostId: REMOTE_HOST, connected: true, models: REMOTE_MODELS, capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true } },
      ],
    },
    topLevel: {
      hostId: selectedHost,
      clientScoped: true,
      activeThreadId,
      activeProjectId: isRemote ? hostEntityKey(REMOTE_HOST, 'proj-remote') : hostEntityKey(LOCAL_HOST, 'proj-local'),
      connections,
      ...(isRemote
        ? { clientUpdates: undefined }
        : { clientUpdates: [{ id: 'codex', installed: '1.0.0', behind: false, channel: 'npm', canInstall: true, checkedAt: '2026-11-22T00:00:00.000Z', state: 'idle' as const }] }),
    },
  })
  return base
}

function makeThreads(localCount: number, remoteCount: number): AgentThread[] {
  const list: AgentThread[] = []
  for (let i = 0; i < localCount; i++) {
    list.push(agentThread({
      id: hostEntityKey(LOCAL_HOST, `local-${i}`),
      projectId: hostEntityKey(LOCAL_HOST, 'proj-local'),
      hostId: LOCAL_HOST,
      remoteHost: false,
      title: `Local thread ${i}`,
      modelId: LOCAL_MODELS[i % LOCAL_MODELS.length]!.id,
    }))
  }
  for (let i = 0; i < remoteCount; i++) {
    list.push(agentThread({
      id: hostEntityKey(REMOTE_HOST, `remote-${i}`),
      projectId: hostEntityKey(REMOTE_HOST, 'proj-remote'),
      hostId: REMOTE_HOST,
      remoteHost: true,
      title: `Remote thread ${i}`,
      modelId: REMOTE_MODELS[i % REMOTE_MODELS.length]!.id,
    }))
  }
  return list
}

function createCrossHostHarness(localCount: number, remoteCount: number) {
  const broadcaster = new AgentStateBroadcaster()
  const threads = makeThreads(localCount, remoteCount)
  const localThreadId = threads[0]!.id
  const remoteThreadId = threads[localCount]!.id
  let connections: NonNullable<AgentState['connections']> = [
    { hostId: LOCAL_HOST, name: 'This computer', kind: 'local', connected: true },
    { hostId: REMOTE_HOST, name: 'Forge', kind: 'remote', connected: true },
  ]
  let selectedHost: typeof LOCAL_HOST | typeof REMOTE_HOST = LOCAL_HOST
  let activeThreadId = localThreadId
  let configVersion = 0
  let current = buildRoutedState(selectedHost, activeThreadId, threads, connections, configVersion)

  const ipc = preloadElectron().ipcRenderer
  let stateListener: ((event: unknown, payload: unknown) => void) | null = null
  let preloadBroadcastErrors = 0
  let agentGetCalls = 0
  let wireBytes = 0

  const crossWire = <T>(value: T): T => {
    const json = JSON.stringify(value)
    wireBytes += Buffer.byteLength(json, 'utf8')
    return JSON.parse(json) as T
  }

  const publishCurrent = (): void => {
    broadcaster.send(current, payload => {
      const sent = crossWire(payload)
      try {
        stateListener?.({}, sent)
      } catch {
        // Electron's ipcRenderer catches/reports listener exceptions without delivering to downstream subscribers.
        preloadBroadcastErrors += 1
      }
      return true
    })
  }

  ipc.on.mockImplementation((channel: string, listener: (event: unknown, payload: unknown) => void) => {
    if (channel === AGENT_STATE) stateListener = listener
    return ipc
  })
  ipc.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === AGENT_GET) {
      agentGetCalls += 1
      return crossWire(broadcaster.readWhole(current))
    }
    if (channel === AGENT_COMMAND) {
      const cmd = args[0] as { type: string; threadId?: string }
      const opts = args[1] as { changedThreadRecords?: boolean } | undefined
      if (cmd.type === 'select-thread' && cmd.threadId) {
        selectedHost = cmd.threadId.startsWith(`host:${REMOTE_HOST}:`) ? REMOTE_HOST : LOCAL_HOST
        activeThreadId = cmd.threadId
        current = buildRoutedState(selectedHost, activeThreadId, threads, connections, configVersion)
        publishCurrent()
        broadcaster.replyBuilt(current)
      }
      const encoded = opts?.changedThreadRecords
        ? broadcaster.encodeChangedThreadRecordsReceipt(current)
        : broadcaster.encodeReceipt(current)
      return crossWire(encoded)
    }
    return undefined
  })

  const sotto = createSottoBridge(ipc, 'win32')
  const page = wrapAgentBridge(sotto.agents!)
  const causes: Record<WholeReadCause, number> = {
    broadcastParts: 0, broadcastThreads: 0, broadcastCatalog: 0, answerThreads: 0, answerCatalog: 0,
  }
  stops.push(onWholeRead(cause => { causes[cause] += 1 }))

  return {
    sotto,
    page,
    localThreadId,
    remoteThreadId,
    causes,
    get preloadBroadcastErrors() { return preloadBroadcastErrors },
    get agentGetCalls() { return agentGetCalls },
    get wireBytes() { return wireBytes },
    resetMetrics: () => {
      preloadBroadcastErrors = 0
      agentGetCalls = 0
      wireBytes = 0
      for (const key of Object.keys(causes) as WholeReadCause[]) causes[key] = 0
    },
    publishCurrent,
    bumpConfig: () => {
      configVersion += 1
      current = buildRoutedState(selectedHost, activeThreadId, threads, connections, configVersion)
      publishCurrent()
    },
    mutateThread: (index: number, title: string) => {
      threads[index] = { ...threads[index]!, title }
      current = buildRoutedState(selectedHost, activeThreadId, threads, connections, configVersion)
      publishCurrent()
    },
    setConnections: (next: NonNullable<AgentState['connections']>) => {
      connections = next
      current = buildRoutedState(selectedHost, activeThreadId, threads, connections, configVersion)
      publishCurrent()
    },
  }
}

describe('cross-host switch kept-parts broadcast delivery (#2733)', () => {
  it('delivers alternating LOC <-> REM switches and config updates with zero preload errors and zero whole-state fallback reads', async () => {
    const h = createCrossHostHarness(20, 10)
    const delivered: AgentState[] = []
    stops.push(h.page.onState(state => { delivered.push(state) }))

    await h.page.get()
    h.publishCurrent()
    await settle()
    h.resetMetrics()
    delivered.length = 0

    // 10 alternating LOC <-> REM switches. On each switch, a follow-up broadcast fires 20 ms later:
    // - when the switch broadcast succeeds, the reply resolves in <1 ms and the follow-up applies cleanly;
    // - when the switch broadcast drops in preload, the reply stalls waiting and the follow-up hits `broadcastParts`.
    for (let step = 0; step < 10; step++) {
      const target = step % 2 === 0 ? h.remoteThreadId : h.localThreadId
      const timer = setTimeout(() => { h.mutateThread(step % 2 === 0 ? 20 : 0, `Updated ${step}`) }, 20)
      try {
        const reply = await h.page.command({ type: 'select-thread', threadId: target })
        expect(reply.activeThreadId).toBe(target)
        await new Promise<void>(resolve => setTimeout(resolve, 30))
      } finally {
        clearTimeout(timer)
      }
      await settle()
    }

    // Also change configuration in-place on the same host (triggers `'configuration' in value` with `'clientScoped'` in `kept`).
    h.bumpConfig()
    h.mutateThread(0, 'After config change')
    await settle()

    expect(h.preloadBroadcastErrors).toBe(0)
    expect(h.agentGetCalls).toBe(0)
    expect(h.causes).toEqual({
      broadcastParts: 0, broadcastThreads: 0, broadcastCatalog: 0, answerThreads: 0, answerCatalog: 0,
    })
    // 10 switch broadcasts + 10 follow-up thread broadcasts + 1 config broadcast + 1 post-config broadcast = 22.
    expect(delivered).toHaveLength(22)
  })

  it.skipIf(!PERF_BENCH)('benchmarks 20 alternating LOC <-> REM switches at owner scale (1,440 threads) (SOTTO_PERF_BENCH=1)', async () => {
    const h = createCrossHostHarness(1_200, 240)
    let broadcastsDelivered = 0
    stops.push(h.page.onState(() => { broadcastsDelivered += 1 }))

    await h.page.get()
    h.publishCurrent()
    await settle()
    h.resetMetrics()
    broadcastsDelivered = 0

    const switches = 20
    const started = performance.now()
    for (let step = 0; step < switches; step++) {
      const target = step % 2 === 0 ? h.remoteThreadId : h.localThreadId
      await h.page.command({ type: 'select-thread', threadId: target })
      // Follow-up live update on the newly selected host (this is the broadcast that hit `broadcastParts` when the switch broadcast dropped).
      h.mutateThread(step % 2 === 0 ? 1_200 : 0, `Switch follow-up ${step}`)
      await settle()
    }
    const elapsedMs = performance.now() - started

    console.log(`cross-host switch broadcast bench (1440 threads, ${switches} LOC<->REM switches): ${JSON.stringify({
      threads: 1_440,
      switches,
      broadcastsSent: switches * 2,
      broadcastsDelivered,
      preloadBroadcastErrors: h.preloadBroadcastErrors,
      agentGetCalls: h.agentGetCalls,
      wholeReads: h.causes,
      wireKB: round(h.wireBytes / 1024, 1),
      elapsedMs: round(elapsedMs, 1),
      msPerSwitch: round(elapsedMs / switches, 2),
    })}`)

    expect(h.preloadBroadcastErrors).toBe(0)
    expect(h.agentGetCalls).toBe(0)
    expect(h.causes.broadcastParts).toBe(0)
    expectWithinBudget(elapsedMs, 2_000, '20 cross-host switches at owner scale')
  }, 60_000)
})
