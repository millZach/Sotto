import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { serialize } from 'node:v8'
import type { BrowserWindow } from 'electron'
import { WatcherService } from '../../src/main/agents/watcher'
import { createWatcherRoomDesktop } from '../../src/main/agents/watcherRoomDesktop'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import { LocalHostService } from '../../src/main/agents/hostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { watcherRoomStateSchema, type WatcherRoomState } from '../../src/shared/watcherRoom'
import { stack, STREAMING_CHUNKS, STREAMING_CHUNK_GAP_MS, STREAMING_ROUNDS, records } from './windowThreadShellPipeline'

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const copyCpu = (before: NodeJS.CpuUsage) => { const used = process.cpuUsage(before); return used.user + used.system }

/** Generated local Watcher pipeline; no user profile, provider account, socket or phone is opened. */
export async function measureWatcherRoom(window: BrowserWindow, streamCount: number, enabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-room-pipeline-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-watcher-room-pipeline-')) throw new Error('Unexpected owned fixture path')
  let stop: (() => Promise<void>) | undefined
  let watcher: WatcherService | undefined
  let unsubscribe: (() => void) | undefined
  let disposeDesktop: (() => void) | undefined
  let restoreClone: (() => void) | undefined
  try {
    for (const provider of ['claude', 'codex']) await mkdir(join(root, provider))
    const seeding = await stack(root, true, streamCount, true)
    try { for (const adapter of Object.values(seeding.adapters)) adapter.publish(false); await pause(600) }
    finally { await seeding.stop() }
    const f = await stack(root, false, streamCount, true); stop = f.stop
    const { adapters, control, workspace, registry } = f
    watcher = new WatcherService({ directory: root, control, host: workspace, historyEnabled: () => true, streamingPublishCost: true })
    const service = new LocalHostService({ control, events: workspace })
    const router = new DesktopHostRouter(() => emptyDesktopState(control.hostId()), { watcherEnabled: true, streamingPublishCost: true })
    router.add({ hostId: control.hostId()!, name: 'This computer', kind: 'local', service,
      detail: id => control.threadDetail(id), preview: request => control.attachmentPreview(request), subscribeDetail: listener => control.subscribeThreadDetail(listener) })
    watcher.useRemoteHosts(router.watcherHosts())
    const broadcaster = new AgentStateBroadcaster()
    const shellPublisher = coalesceAgentStatePublishes(state => broadcaster.send(state, payload => { window.webContents.send('shell', payload); return true }))
    const detailPublisher = coalesceAgentThreadDetailPublishes(detail => window.webContents.send('detail', detail), { beforeOpening: () => shellPublisher.flush() })
    const offShell = router.subscribe(state => shellPublisher.publish(state)), offDetail = router.subscribeThreadDetail(detail => detailPublisher.publish(detail))
    disposeDesktop = () => { offShell(); offDetail(); shellPublisher.dispose(); detailPublisher.dispose(); router.dispose() }
    const ids = Array.from({ length: streamCount }, (_, i) => registry.bySession('claude', `stream-${i}`)!.threadId)
    const at = '2026-10-14T00:00:00.000Z', requestId = randomUUID()
    // An unavailable retained master gives the real room participants, display proofs and receipts,
    // but cannot start an automatic model turn. Observation and held news remain real.
    await control.updateWatcher(record => {
      record.current = { target: { hostId: control.hostId()!, threadId: 'generated-master' },
        projectId: workspace.workspaceSnapshot().projects[0]!.id, provider: 'claude', creationOperationId: randomUUID(), createdAt: at }
      record.requests.push({ id: requestId, watcher: { hostId: control.hostId()!, threadId: 'generated-master' }, rootUserMessageId: 'generated-prompt',
        state: 'active', createdAt: at, closedAt: null, displayPrompt: { originalLength: 17, wireDigest: 'a'.repeat(64) },
        userFollowups: [{ draftId: randomUUID(), messageId: 'generated-followup', displayPrompt: { originalLength: 12, wireDigest: 'b'.repeat(64) } }],
        participants: ids.map(threadId => ({ target: { hostId: control.hostId()!, threadId }, requestId,
          startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1 })) })
      record.operations.push(...ids.map(threadId => ({ id: randomUUID(), requestId, retryKey: randomUUID(), digest: 'c'.repeat(64),
        action: 'send' as const, target: { hostId: control.hostId()!, threadId }, generation: 0, deliveryState: 'failed' as const,
        createdAt: at, updatedAt: at, receiptId: `receipt-${threadId}`, cardId: `card-${threadId}` })))
    })
    watcher.wakes.start()
    for (const threadId of ids) watcher.checkpointObserved({ threadId, checkpointId: `checkpoint-${threadId}`,
      observedAt: at, changedFiles: 3, availability: 'available' })
    const counts = { projections: 0, projectionShellReads: 0, localRecordCopies: 0, localRecordCpuUs: 0,
      captureCopies: 0, captureCpuUs: 0, captureWallMs: 0, oracleCopies: 0, oracleCpuUs: 0, oracleWallMs: 0,
      attemptedSends: 0, successfulSends: 0, wireBytes: 0 }
    let sourceRevision = 0
    const revisions = new WeakMap<object, number>()
    const clone = globalThis.structuredClone
    globalThis.structuredClone = function <Value>(value: Value, options?: unknown): Value {
      if (value !== null && typeof value === 'object' && 'watchedThreads' in value && 'observedAt' in value) {
        const cpu = process.cpuUsage(), started = performance.now(), copy = Reflect.apply(clone, globalThis, [value, options]) as Value
        counts.captureCopies++; counts.captureCpuUs += copyCpu(cpu); counts.captureWallMs += performance.now() - started
        const revision = revisions.get(value)
        if (revision !== undefined) revisions.set(copy as object, revision)
        return copy
      }
      return Reflect.apply(clone, globalThis, [value, options]) as Value
    }
    restoreClone = () => { globalThis.structuredClone = clone }
    const originalRecord = control.watcherRecord.bind(control)
    control.watcherRecord = () => { const cpu = process.cpuUsage(); const result = originalRecord(); counts.localRecordCopies++; counts.localRecordCpuUs += copyCpu(cpu); return result }
    const originalState = watcher.state.bind(watcher), originalShell = control.shell.bind(control)
    let projecting = false
    let latestProjected: WatcherRoomState | undefined
    control.shell = () => { if (projecting) counts.projectionShellReads++; return originalShell() }
    watcher.state = () => { counts.projections++; projecting = true; try { const state = originalState(); latestProjected = state; revisions.set(state, ++sourceRevision); return state } finally { projecting = false } }
    let sentRooms: WatcherRoomState[] = []
    const send = (state: WatcherRoomState) => {
      counts.attemptedSends++
      const revision = revisions.get(state)
      if (revision === undefined) throw new Error('Room send lost its source revision')
      window.webContents.send('room', state, revision); counts.successfulSends++; sentRooms.push(state)
    }
    // Earlier steps remain true in stack/router; only this desktop room seam varies off/on.
    const desktop = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: enabled, watcher,
      send: state => { send(state); return true } })!
    unsubscribe = () => desktop.dispose()
    await control.command({ type: 'observe-threads', threadIds: ids })
    for (const id of ids) control.threadDetail(id)
    const initial = watcher.state()
    if (!watcherRoomStateSchema.safeParse(initial).success || initial.watchedThreads.length !== streamCount
      || watcher.watchedThreadIds().length !== streamCount || control.watcherObservationsEnabled() !== true) throw new Error('Watcher fixture was not enabled')
    const fixture = control.shell()
    const connectedProviders = fixture.host.providers?.filter(provider => provider.connection === 'connected').map(provider => provider.id).sort()
    if (JSON.stringify(connectedProviders) !== JSON.stringify(['claude', 'codex'])) throw new Error('Unexpected enabled benchmark provider')
    const rows: Record<string, number>[] = []
    const adapter = adapters.claude, streaming = adapter.state.threads.filter(thread => thread.id.startsWith('stream-'))
    for (let round = 0; round < STREAMING_ROUNDS; round++) {
      await pause(400)
      const reply = `reply-${round}`
      await control.updateWatcher(record => { for (const operation of record.operations) operation.messageId = `prompt-${round}` })
      for (const thread of streaming) {
        adapter.log.add(thread.id, { id: `prompt-${round}`, role: 'user', text: 'Generated prompt', createdAt: at })
        adapter.log.add(thread.id, { id: reply, role: 'assistant', text: 'First', createdAt: at }); thread.status = 'running'
      }
      adapter.publish(false); await pause(200)
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
      sentRooms = []
      await window.webContents.executeJavaScript('window.bench.startCpu()')
      const cpu = process.cpuUsage(), mainThreadCpu = process.threadCpuUsage(), started = performance.now()
      for (let chunk = 0; chunk < STREAMING_CHUNKS; chunk++) {
        for (const thread of streaming) {
          adapter.log.appendText(thread.id, reply, ` word${chunk}`)
          if (chunk % 25 === 0) thread.activities = [...thread.activities ?? [], ...records(`${thread.id}-${round}-${chunk}`, 1, 400)]
        }
        adapter.publish(true); await pause(STREAMING_CHUNK_GAP_MS)
      }
      for (const thread of streaming) thread.status = 'idle'
      adapter.publish(false)
      await pause(150) // includes the final quiet trailing publication
      // A timer delay alone is not a delivery assertion. Wait for the normal room callback,
      // retaining the same CPU starts if a newer projection appears during the roundtrip.
      const completionDeadline = performance.now() + 10_000
      let completionAttempts = 0
      let result: { revision: number; cpuMs: number; room: WatcherRoomState }
      let candidate: { revision: number; expected: WatcherRoomState }
      do {
        if (!latestProjected) throw new Error('Room source was not projected')
        const oracleCpu = process.cpuUsage(), oracleStarted = performance.now()
        candidate = { revision: sourceRevision, expected: clone(latestProjected) }
        counts.oracleCopies++; counts.oracleCpuUs += copyCpu(oracleCpu); counts.oracleWallMs += performance.now() - oracleStarted
        const target = candidate.revision
        completionAttempts++
        const remaining = Math.ceil(completionDeadline - performance.now())
        if (remaining <= 0) throw new Error(`Room completion did not settle: source=${sourceRevision}, attempts=${completionAttempts}, projections=${counts.projections}, sends=${counts.successfulSends}`)
        try {
          result = await window.webContents.executeJavaScript(`window.completeRoom(${target},${remaining})`) as typeof result
        } catch {
          throw new Error(`Room completion failed: target=${target}, source=${sourceRevision}, attempts=${completionAttempts}, projections=${counts.projections}, sends=${counts.successfulSends}`)
        }
      } while (result.revision !== candidate.revision || sourceRevision !== candidate.revision)
      const mainProcessCpuMs = copyCpu(cpu) / 1000, usedThread = process.threadCpuUsage(mainThreadCpu)
      const mainCpuMs = (usedThread.user + usedThread.system) / 1000
      const wallMs = performance.now() - started
      // Payload accounting and equality run after both CPU reads. Keeping the latest projected room
      // independently catches a dropped trailing event rather than only checking last-send transport.
      counts.wireBytes = sentRooms.reduce((bytes, room) => bytes + serialize(room).length, 0)
      if (JSON.stringify(result.room) !== JSON.stringify(candidate.expected)) throw new Error('Latest projected room differs across actual IPC/contextBridge')
      if (counts.projectionShellReads !== 0) throw new Error('Room projection cloned a local shell')
      if (watcher.watchedThreadIds().length !== streamCount || result.room.watchedThreads.some(thread => thread.status !== 'idle')) throw new Error('Watcher fixture lost its participants or final quiet state')
      rows.push({ ...counts, completionAttempts, wallMs, mainCpuMs, mainProcessCpuMs, rendererCpuMs: result.cpuMs,
        mainCpuMsPerChunk: mainCpuMs / (STREAMING_CHUNKS * streamCount), totalCpuMsPerChunk: (mainProcessCpuMs + result.cpuMs) / (STREAMING_CHUNKS * streamCount) })
    }
    return { enabled, streamCount, chunks: STREAMING_CHUNKS, rounds: STREAMING_ROUNDS,
      shape: { threads: fixture.host.threads.length, projects: fixture.host.projects.length, models: fixture.host.models.length,
        watchedTargets: initial.watchedThreads.length, receipts: initial.receipts.length, remoteParticipants: 0, connectedProviders }, rows }
  } finally {
    unsubscribe?.(); restoreClone?.(); disposeDesktop?.(); watcher?.close(); await stop?.()
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}
