import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { serialize } from 'node:v8'
import type { BrowserWindow } from 'electron'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import { LocalHostService } from '../../src/main/agents/hostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentStateBroadcast, AgentThreadsBroadcast } from '../../src/shared/agents'
import { records, stack } from './windowThreadShellPipeline'

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

/** The same synthetic Node chain, running on Electron's actual main thread and window transport. */
export async function measureElectronStreaming(window: BrowserWindow, streamCount: number, enabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-window-electron-stream-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-window-electron-stream-')) throw new Error('Unexpected fixture directory')
  for (const provider of ['claude', 'codex']) await mkdir(join(root, provider), { recursive: true })
  const seed = await stack(root, true, streamCount)
  try { for (const adapter of Object.values(seed.adapters)) adapter.publish(false); await pause(600) } finally { await seed.stop() }
  const current = await stack(root, false, streamCount)
  const { registry, adapters, workspace, control } = current
  const ids = Array.from({ length: streamCount }, (_, i) => registry.bySession('claude', `stream-${i}`)!.threadId)
  const service = new LocalHostService({ control, events: workspace })
  const router = new DesktopHostRouter(() => emptyDesktopState(control.hostId()))
  router.add({ hostId: control.hostId()!, name: 'This computer', kind: 'local', service,
    detail: id => control.threadDetail(id), preview: request => control.attachmentPreview(request), subscribeDetail: listener => control.subscribeThreadDetail(listener) })
  const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: enabled })
  const counts = { states: 0, details: 0, changedBodies: 0, senderThreadCpuUs: 0 }
  let last: AgentStateBroadcast | undefined
  const statePublisher = coalesceAgentStatePublishes(state => {
    const cpu = process.threadCpuUsage()
    broadcaster.send(state, payload => {
      last = payload
      counts.states++
      counts.changedBodies += Array.isArray(payload.host.threads) ? payload.host.threads.length : payload.host.threads.changed.length
      window.webContents.send('shell', payload)
      return true
    })
    const used = process.threadCpuUsage(cpu)
    counts.senderThreadCpuUs += used.user + used.system
  })
  const detailPublisher = coalesceAgentThreadDetailPublishes(detail => { counts.details++; window.webContents.send('detail', detail) }, { beforeOpening: () => statePublisher.flush() })
  const offState = router.subscribe(state => statePublisher.publish(state))
  const offDetail = router.subscribeThreadDetail(detail => detailPublisher.publish(detail))
  let gcMs = 0
  const gc = new PerformanceObserver(list => { for (const entry of list.getEntries()) gcMs += entry.duration })
  gc.observe({ entryTypes: ['gc'] })
  try {
    await control.command({ type: 'observe-threads', threadIds: ids })
    for (const id of ids) control.threadDetail(id)
    const fixture = router.shell()
    const shape = { threads: fixture.host.threads.length, projects: fixture.host.projects.length, models: fixture.host.models.length,
      threadBytes: Buffer.byteLength(JSON.stringify(fixture.host.threads)), worktreeBytes: Buffer.byteLength(JSON.stringify(fixture.host.threads.map(thread => thread.worktree))), usageBytes: Buffer.byteLength(JSON.stringify(fixture.host.threads.map(thread => thread.usage))) }
    const rows: Record<string, number>[] = []
    const adapter = adapters.claude, streams = adapter.state.threads.filter(thread => thread.id.startsWith('stream-'))
    for (let round = 0; round < 3; round++) {
      await pause(400)
      const at = new Date().toISOString(), reply = `reply-${round}`
      for (const thread of streams) { adapter.log.add(thread.id, { id: `prompt-${round}`, role: 'user', text: `Prompt ${round}`, createdAt: at }); thread.status = 'running' }
      adapter.publish(false)
      for (const thread of streams) adapter.log.add(thread.id, { id: reply, role: 'assistant', text: 'First', createdAt: at })
      adapter.publish(true)
      await pause(200)
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
      gcMs = 0
      await window.webContents.executeJavaScript('window.bench.startCpu()')
      const threadCpu = process.threadCpuUsage(), cpu = process.cpuUsage(), elu = performance.eventLoopUtilization(), start = performance.now()
      for (let chunk = 0; chunk < 180; chunk++) {
        for (const thread of streams) {
          adapter.log.appendText(thread.id, reply, ` word${chunk}`)
          if (chunk % 25 === 0) thread.activities = [...(thread.activities ?? []), ...records(`${thread.id}-${round}-${chunk}`, 1, 400)]
        }
        adapter.publish(true)
        await pause(2)
      }
      await pause(150)
      const usedThread = process.threadCpuUsage(threadCpu), usedProcess = process.cpuUsage(cpu), usedElu = performance.eventLoopUtilization(elu), wallMs = performance.now() - start
      const renderer = await window.webContents.executeJavaScript('window.bench.endCpu()') as { cpuMs: number }
      const chunks = 180 * streamCount, mainThreadMs = (usedThread.user + usedThread.system) / 1000, mainProcessMs = (usedProcess.user + usedProcess.system) / 1000
      rows.push({ chunks, wallMs, mainThreadCpuMsPerChunk: mainThreadMs / chunks, mainProcessCpuMsPerChunk: mainProcessMs / chunks,
        rendererCpuMsPerChunk: renderer.cpuMs / chunks, totalProcessCpuMsPerChunk: (mainProcessMs + renderer.cpuMs) / chunks,
        mainThreadCpuMsPerWindow: mainThreadMs / Math.max(1, counts.states), senderThreadCpuMsPerWindow: counts.senderThreadCpuUs / 1000 / Math.max(1, counts.states),
        eventLoopUtilization: usedElu.utilization, mainGcMs: gcMs, statesPerSecond: counts.states / wallMs * 1000, ...counts })
      for (const thread of streams) thread.status = 'idle'
      adapter.publish(false)
    }
    statePublisher.flush()
    await pause(100)
    const expected = router.shell()
    const renderer = await window.webContents.executeJavaScript('window.lastState')
    // Compare shell facts separately from the histories the page spliced back from the detail channel.
    const actual = renderer as typeof expected
    for (const thread of actual.host.threads) { thread.messages = []; if (thread.activities !== undefined) thread.activities = [] }
    const { isDeepStrictEqual } = await import('node:util')
    if (!isDeepStrictEqual(actual, expected)) throw new Error('Electron reconstructed shell differs from the coordinator')
    return { enabled, streamCount, shape, rows, finalPayloadBytes: last ? serialize(last).length : 0,
      finalChangedBodies: last && !Array.isArray(last.host.threads) ? (last.host.threads as AgentThreadsBroadcast).changed.length : expected.host.threads.length,
      node: process.version, electron: process.versions.electron }
  } finally {
    offState(); offDetail(); statePublisher.dispose(); detailPublisher.dispose(); router.dispose(); gc.disconnect()
    await current.stop()
    await rm(root, { recursive: true, force: true })
  }
}
