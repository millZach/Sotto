// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService } from '../../../src/main/agents/watcher'
import { WatcherToolServer } from '../../../src/main/agents/watcherTools'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import type { WatcherHostProjection, WatcherRemoteHosts } from '../../../src/shared/watcherHost'
import { watcherToolSchemas } from '../../../src/shared/watcher'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { watcherRecordFixture } from '../../fixtures/watcher'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(transientReadyWaitMs = 1_000) {
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({
    directory: workspace.root,
    host: workspace.host,
    credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => false, watcherEnabled: true },
  })
  const watcher = new WatcherService({
    directory: f.root,
    host: workspace.host,
    control: f.control,
    historyEnabled: () => false,
    transientReadyWaitMs,
  })
  const tools = new WatcherToolServer(watcher)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => {
    watcher.close()
    await tools.close()
    await f.dispose()
    await workspace.stop()
    await workspace.remove()
  })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await watcher.recover()

  const model = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.ready) ?? f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const opened = await watcher.open({ provider: 'codex', modelId: model.id })
  expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'ok' })
  const watcherId = watcher.state().current!.target.threadId
  await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Coordinate workers' })
  const requestId = watcher.state().requests.at(-1)!.id
  const localHostId = f.control.hostId()!
  const remoteHostId = randomUUID()
  const baseSnapshot = f.control.watcherSnapshot()
  const baseThread = baseSnapshot.threads[0]!
  const remoteWorkerId = 'remote-worker'
  let remoteConnected = false
  let remoteReconnecting = true
  let remoteReconnectingSince: number | undefined

  const remoteSnapshot = (): AgentHostSnapshot => ({
    ...baseSnapshot,
    hostId: remoteHostId,
    connected: remoteConnected,
    threads: [{ ...baseThread, id: remoteWorkerId, hostId: remoteHostId, status: 'idle', clientConnected: remoteConnected, ...(remoteReconnecting ? { clientReconnecting: true } : {}) }],
  })

  const record = watcherRecordFixture()
  const projection = (): WatcherHostProjection => ({
    hostId: remoteHostId,
    master: f.control.watcherRecords.copy().current!,
    revision: 'rev-1',
    observedAt: new Date().toISOString(),
    requests: [],
    operations: [],
    evidence: [],
  })

  const listeners = new Set<(hostId?: string, force?: boolean) => void>()
  const hostsList = (): ReturnType<WatcherRemoteHosts['hosts']> => [{
    hostId: remoteHostId,
    connected: remoteConnected,
    ...(remoteReconnecting ? { reconnecting: true, ...(remoteReconnectingSince !== undefined ? { reconnectingSince: remoteReconnectingSince } : {}) } : {}),
    reads: true,
    control: true,
    standingWatch: true,
    newOwner: true,
    permissionCeiling: 'approval-required',
  }]

  const readMock = vi.fn<WatcherRemoteHosts['read']>(async () => structuredClone(projection()))

  const controlMock = vi.fn<WatcherRemoteHosts['control']>(async (_hostId, request) => {
    const operation = request.operation
    return {
      status: 'ok',
      receipt: {
        operationId: operation.id,
        requestId: operation.requestId,
        target: operation.target,
        deliveryState: 'accepted',
        receiptId: operation.receiptId,
        cardId: operation.cardId,
      },
      limits: { promptCount: 1, promptLimit: 4 },
      delivery: 'now',
    }
  })

  const addProjectMock = vi.fn<NonNullable<WatcherRemoteHosts['addProject']>>(async (_hostId, command) => [
    ...baseSnapshot.projects,
    { id: 'remote-proj-1', hostId: remoteHostId, title: command.title, path: command.path ?? '/remote/repo' },
  ])

  const remote: WatcherRemoteHosts = {
    hosts: hostsList,
    snapshot: id => (id === remoteHostId ? remoteSnapshot() : undefined),
    read: readMock,
    control: controlMock,
    addProject: addProjectMock,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  watcher.useRemoteHosts(remote)
  // Seed remote target into active request participants so send_to_thread skips start_thread prerequisite if desired,
  // or keep it realistic: register participation via watcherRecords matching how a previously started thread is targeted.
  await f.control.watcherRecords.update(next => {
    const activeRequest = next.requests.find(item => item.id === requestId)!
    activeRequest.participants.push({
      target: { hostId: remoteHostId, threadId: remoteWorkerId },
      state: 'participating',
      generation: 0,
      promptCount: 0,
      requestId,
      startedBy: 'user',
    })
  })

  const setRemoteState = (connected: boolean, reconnecting: boolean, reconnectingSince?: number) => {
    remoteConnected = connected
    remoteReconnecting = reconnecting
    remoteReconnectingSince = reconnectingSince
    for (const listener of listeners) listener(remoteHostId, true)
  }

  return {
    f,
    watcher,
    watcherId,
    requestId,
    localHostId,
    remoteHostId,
    remoteWorkerId,
    projection,
    readMock,
    controlMock,
    addProjectMock,
    setRemoteState,
    unusedRecord: record,
  }
}

describe('WatcherService transient reconnect readiness wait on send_to_thread', () => {
  it('waits out a remote host reconnecting transition and sends once connected', async () => {
    const s = await setup(1_000)
    setTimeout(() => s.setRemoteState(true, false), 35)
    const result = watcherToolSchemas.send_to_thread.output.parse(await s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      target: { hostId: s.remoteHostId, threadId: s.remoteWorkerId },
      text: 'Proceed after reconnect',
      delivery: 'now',
    }))
    expect(result).toMatchObject({ status: 'ok', delivery: 'now' })
    expect(s.controlMock).toHaveBeenCalledTimes(1)
  })

  it('refuses immediately with HOST_DISCONNECTED when a remote host is disconnected and not reconnecting', async () => {
    const s = await setup(2_500)
    s.setRemoteState(false, false)
    const start = Date.now()
    const result = watcherToolSchemas.send_to_thread.output.parse(await s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      target: { hostId: s.remoteHostId, threadId: s.remoteWorkerId },
      text: 'Should refuse immediately',
      delivery: 'now',
    }))
    expect(result).toMatchObject({ status: 'refused', code: 'HOST_DISCONNECTED' })
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('wakes early when a remote host reconnect attempt fails and turns off reconnecting', async () => {
    const s = await setup(2_500)
    setTimeout(() => s.setRemoteState(false, false), 30)
    const start = Date.now()
    const result = watcherToolSchemas.send_to_thread.output.parse(await s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      target: { hostId: s.remoteHostId, threadId: s.remoteWorkerId },
      text: 'Should stop waiting when reconnect ends',
      delivery: 'now',
    }))
    expect(result).toMatchObject({ status: 'refused', code: 'HOST_DISCONNECTED' })
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('waits out a local provider connecting state before refusing HOST_DISCONNECTED, while failing immediately if disconnected', async () => {
    const s = await setup(1_000)
    // Start a real local worker thread in a non-reserved project directory, then simulate its provider transitioning connecting -> connected.
    const model = s.f.control.shell().host.models.find(item => item.providerId === 'codex')!
    const projectPath = join(s.f.root, 'local-worker-project')
    await mkdir(projectPath, { recursive: true })
    const created = await s.f.control.commandShell({ type: 'create-project', provider: 'codex', title: 'Local project', path: projectPath, useExisting: true })
    const project = created.host.projects.find(item => item.path === projectPath)!
    const localWorkerId = randomUUID()
    await s.f.control.commandShell({
      type: 'create-thread',
      threadId: localWorkerId,
      projectId: project.id,
      modelId: model.id,
      title: 'Local worker',
      workingCopy: 'shared',
    })
    const localTarget = { hostId: s.localHostId, threadId: localWorkerId }
    await s.f.control.watcherRecords.update(next => {
      next.requests.find(item => item.id === s.requestId)!.participants.push({
        target: localTarget,
        state: 'participating',
        generation: 0,
        promptCount: 0,
        requestId: s.requestId,
        startedBy: 'user',
      })
    })

    let providerConnection: 'connected' | 'connecting' | 'disconnected' = 'connecting'
    const realWatcherSnapshot = s.f.control.watcherSnapshot.bind(s.f.control)
    type ControlListener = Parameters<typeof s.f.control.subscribe>[0]
    const subs = new Set<ControlListener>()
    const realSubscribe = s.f.control.subscribe.bind(s.f.control)
    const unsubReal = realSubscribe(state => { for (const fn of subs) fn(state) })
    cleanups.push(async () => unsubReal())
    vi.spyOn(s.f.control, 'subscribe').mockImplementation(listener => {
      subs.add(listener)
      return () => { subs.delete(listener) }
    })
    vi.spyOn(s.f.control, 'watcherSnapshot').mockImplementation(() => {
      const snap = realWatcherSnapshot()
      if (providerConnection === 'connected') return snap
      return {
        ...snap,
        providers: snap.providers?.map(provider => provider.id === 'codex' ? { ...provider, connection: providerConnection } : provider),
      }
    })

    setTimeout(() => {
      providerConnection = 'connected'
      const currentShell = s.f.control.shell()
      for (const fn of subs) fn(currentShell)
    }, 35)
    const ok = watcherToolSchemas.send_to_thread.output.parse(await s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      target: localTarget,
      text: 'Send once local provider reconnects',
      delivery: 'now',
    }))
    expect(ok).toMatchObject({ status: 'ok', delivery: 'now' })

    // Genuinely disconnected local provider fails fast without waiting out transientReadyWaitMs.
    providerConnection = 'disconnected'
    const start = Date.now()
    const refused = watcherToolSchemas.send_to_thread.output.parse(await s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      target: localTarget,
      text: 'Should fail fast when disconnected',
      delivery: 'now',
    }))
    expect(refused).toMatchObject({ status: 'refused', code: 'HOST_DISCONNECTED' })
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('waits out a remote host reconnecting transition on add_project, while failing immediately if disconnected', async () => {
    const s = await setup(1_000)
    setTimeout(() => s.setRemoteState(true, false), 35)
    const ok = watcherToolSchemas.add_project.output.parse(await s.watcher.invoke(s.watcherId, 'add_project', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      hostId: s.remoteHostId,
      path: '/remote/added-project',
    }))
    expect(ok).toMatchObject({ status: 'ok', project: { target: { hostId: s.remoteHostId, projectId: 'remote-proj-1' } } })
    expect(s.addProjectMock).toHaveBeenCalledTimes(1)

    s.setRemoteState(false, false)
    const start = Date.now()
    const refused = watcherToolSchemas.add_project.output.parse(await s.watcher.invoke(s.watcherId, 'add_project', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      hostId: s.remoteHostId,
      path: '/remote/other-project',
    }))
    expect(refused).toMatchObject({ status: 'refused', code: 'HOST_DISCONNECTED' })
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('refuses immediately with HOST_DISCONNECTED when reconnecting stays true past the initial drop window', async () => {
    const s = await setup(2_500)
    s.setRemoteState(false, true, Date.now() - 10_000)
    const start = Date.now()
    const refused = watcherToolSchemas.send_to_thread.output.parse(await s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      target: { hostId: s.remoteHostId, threadId: s.remoteWorkerId },
      text: 'Offline host should refuse immediately even while reconnecting remains true',
      delivery: 'now',
    }))
    expect(refused).toMatchObject({ status: 'refused', code: 'HOST_DISCONNECTED' })
    expect(Date.now() - start).toBeLessThan(200)
  })

  it('waits for remote reconnect before reconcileRemote on standing-watch executeRemote when the host re-drops', async () => {
    const s = await setup(1_000)
    const watchId = randomUUID()
    await s.f.control.watcherRecords.update(next => {
      next.watches = [{
        id: watchId,
        target: { hostId: s.remoteHostId, threadId: s.remoteWorkerId },
        createdAt: new Date().toISOString(),
        generation: 0,
        lastUserMessageId: null,
        pausedByUserMessageId: null,
      }]
    })
    s.setRemoteState(true, false)

    const events: string[] = []
    s.readMock.mockImplementation(async () => {
      events.push(events.includes('dropped') ? 'read-executeRemote' : 'read-initial')
      return structuredClone(s.projection())
    })
    const origUpdate = s.f.control.watcherRecords.update.bind(s.f.control.watcherRecords)
    vi.spyOn(s.f.control.watcherRecords, 'update').mockImplementationOnce(async fn => {
      const res = await origUpdate(fn)
      events.push('dropped')
      s.setRemoteState(false, true, Date.now())
      setTimeout(() => {
        events.push('reconnected')
        s.setRemoteState(true, false)
      }, 35)
      return res
    })
    s.controlMock.mockImplementation(async (_hostId, request) => {
      events.push('control')
      return {
        status: 'ok',
        receipt: {
          operationId: request.operation.id,
          requestId: request.operation.requestId,
          target: request.operation.target,
          deliveryState: 'accepted',
          receiptId: request.operation.receiptId,
          cardId: request.operation.cardId,
        },
        limits: { promptCount: 1, promptLimit: 4 },
        delivery: 'now',
      }
    })

    const result = watcherToolSchemas.send_to_thread.output.parse(await s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: watchId,
      retryKey: randomUUID(),
      target: { hostId: s.remoteHostId, threadId: s.remoteWorkerId },
      text: 'Continue under standing watch after re-drop',
      delivery: 'now',
    }))
    expect(result).toMatchObject({ status: 'ok', delivery: 'now' })
    expect(events.slice(0, 5)).toEqual(['read-initial', 'dropped', 'reconnected', 'read-executeRemote', 'control'])
  })

  it('settles in-flight readiness waiters immediately when watcher.close() runs', async () => {
    const s = await setup(5_000)
    s.setRemoteState(false, true, Date.now())
    const start = Date.now()
    const pending = s.watcher.invoke(s.watcherId, 'send_to_thread', {
      requestId: s.requestId,
      retryKey: randomUUID(),
      target: { hostId: s.remoteHostId, threadId: s.remoteWorkerId },
      text: 'Closing should settle wait promptly',
      delivery: 'now',
    })
    setTimeout(() => s.watcher.close(), 25)
    const settled = await pending
    expect(settled).toMatchObject({ status: 'refused' })
    expect(Date.now() - start).toBeLessThan(500)
  })
})
