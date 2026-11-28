// @vitest-environment node
// Cross-language remote-host Watcher integration tests (ADR-0073, ADR-0082, ADR-0214):
// runs the real compiled Rust `sotto-host` binary against TypeScript's `WatcherService`,
// `DesktopHostRouter`, and `SocketHostService` with `fakeCodexAppServer.mjs`.
// Enabled when `SOTTO_TEST_RUST_HOST=1`.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckQueue } from '../../src/main/agents/checkQueue'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { WatcherService } from '../../src/main/agents/watcher'
import { WATCHER_RECORD_FILE } from '../../src/main/agents/watcherRecordFile'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import type { HostOperation } from '../../src/shared/hostProtocol'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { drive, prepareFake } from '../referee/providers'
import { startHost } from '../referee/wire'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'
const SHORT_BATCH = { quietMs: 2_000, maxMs: 5_000 }

async function findRustHostBinary(): Promise<string> {
  const exe = process.platform === 'win32' ? 'sotto-host.exe' : 'sotto-host'
  const cargoTargetDir = process.env.CARGO_TARGET_DIR
  const candidates = [
    ...(cargoTargetDir ? [join(cargoTargetDir, 'debug', exe), join(cargoTargetDir, 'release', exe)] : []),
    resolve('target', 'debug', exe),
    resolve('target', 'release', exe),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try next build location.
    }
  }
  throw new Error(`Could not find compiled Rust ${exe}. Run cargo build -p sotto-host --bin sotto-host first.`)
}

async function issuePairingCode(port: number, adminToken: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/admin/pairing-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { code: string }
  return body.code
}

async function setAllowAnswers(port: number, adminToken: string, clientId: string, allowed: boolean): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/admin/${allowed ? 'allow-answers' : 'deny-answers'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId }),
  })
  expect(res.status).toBe(200)
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.restoreAllMocks()
  }
})

describe.skipIf(!RUN_RUST_HOST)('Rust sotto-host remote Watcher control & reads', () => {
  it('enforces paired-desktop-only origin and truthful feature advertisement on live Rust sotto-host', async () => {
    const binary = await findRustHostBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-watcher-auth-'))
    await prepareFake(dataDir, 'codex')
    const host = await startHost(
      [binary, '--data', '{data}', '--fake', '{provider}', '--fixtures-dir', resolve('tests/fixtures')],
      dataDir,
      'codex',
      30_000,
    )
    cleanups.push(async () => { await host.stop(); await rm(dataDir, { recursive: true, force: true }) })

    const descriptor = JSON.parse(await readFile(join(dataDir, 'host-listener.json'), 'utf8')) as {
      hostId: string
      port: number
      adminToken: string
    }
    const url = `http://127.0.0.1:${descriptor.port}`

    // 1. /v1/health advertises implemented features and never unimplemented ones.
    const health = await (await fetch(`${url}/v1/health`)).json() as { v: number; features: string[] }
    expect(health.v).toBe(1)
    for (const expected of [
      'watcher-control',
      'watcher-reads',
      'watcher-progress',
      'watcher-standing-watch',
      'watcher-work-settled',
      'watcher-outcomes',
      'watcher-new-owner',
      'watcher-check-queue',
      'watcher-check-stop',
      'watcher-muse',
      'watcher-cursor',
      'watcher-antigravity',
      'project-origins',
      'project-git-init',
    ]) {
      expect(health.features).toContain(expected)
    }
    for (const unimplemented of ['watcher-tell', 'watcher-ready', 'worker-swarms', 'branch-moves']) {
      expect(health.features).not.toContain(unimplemented)
    }

    // 2. Unrecorded paired client on the loopback listener still sees NO watcher-* features
    //    and is refused with `forbidden` if it attempts watcher-read (watcher-* always requires desktop-clients.json).
    //    Like Node's `socketServer.ts`, the loopback listener treats every client as a desktop for non-watcher desktop features such as `project-origins`.
    const generalCode = await issuePairingCode(descriptor.port, descriptor.adminToken)
    const generalPairing = await SocketHostService.pair(url, generalCode, 'Unrecorded Phone')
    const generalSocket = new SocketHostService({ url, token: generalPairing.token, watcherEnabled: true })
    cleanups.push(async () => { await generalSocket.close() })
    const generalHello = await generalSocket.connect()
    expect(generalHello.features.some(f => f.startsWith('watcher-'))).toBe(false)
    expect(generalSocket.supportsWatcherControl).toBe(false)
    expect(generalSocket.supportsWatcherReads).toBe(false)

    const rawGeneral = generalSocket as unknown as { call(op: HostOperation): Promise<unknown> }
    const forgedMaster = {
      target: { hostId: randomUUID(), threadId: 'forged' },
      projectId: 'forged',
      provider: 'codex' as const,
      creationOperationId: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    await expect(rawGeneral.call({ op: 'watcher-read', request: { master: forgedMaster } })).rejects.toMatchObject({ code: 'forbidden' })

    // 3. Recorded desktop client in desktop-clients.json gets all Watcher features.
    const desktopCode = await issuePairingCode(descriptor.port, descriptor.adminToken)
    const desktopPairing = await SocketHostService.pair(url, desktopCode, 'Recorded Desktop')
    await writeFile(join(dataDir, DESKTOP_CLIENTS_FILE), JSON.stringify([desktopPairing.clientId]), 'utf8')
    const desktopSocket = new SocketHostService({
      url,
      token: desktopPairing.token,
      watcherEnabled: true,
      crossMachineEnabled: true,
    })
    cleanups.push(async () => { await desktopSocket.close() })
    const desktopHello = await desktopSocket.connect()
    expect(desktopHello.features).toContain('watcher-control')
    expect(desktopHello.features).toContain('watcher-reads')
    expect(desktopHello.features).toContain('watcher-outcomes')
    expect(desktopHello.features).toContain('project-origins')
    expect(desktopSocket.supportsWatcherControl).toBe(true)
    expect(desktopSocket.supportsWatcherReads).toBe(true)
    expect(desktopSocket.supportsWatcherProgress).toBe(true)
    expect(desktopSocket.supportsWatcherStandingWatch).toBe(true)
    expect(desktopSocket.supportsWatcherWorkSettled).toBe(true)
    expect(desktopSocket.supportsWatcherOutcomes).toBe(true)
    expect(desktopSocket.supportsWatcherNewOwner).toBe(true)
    expect(desktopSocket.supportsWatcherCheckQueue).toBe(true)
    expect(desktopSocket.supportsWatcherCheckStop).toBe(true)
    expect(desktopSocket.supportsWatcherMuse).toBe(true)
    expect(desktopSocket.supportsWatcherCursor).toBe(true)
    expect(desktopSocket.supportsWatcherAntigravity).toBe(true)

    // 4. Stable desktop (`watcherEnabled: false`) negotiates no Watcher automation.
    const stableSocket = new SocketHostService({ url, token: desktopPairing.token, watcherEnabled: false })
    cleanups.push(async () => { await stableSocket.close() })
    await stableSocket.connect()
    expect(stableSocket.supportsWatcherControl).toBe(false)
    expect(stableSocket.supportsWatcherReads).toBe(false)
    await expect(stableSocket.watcherRead({ master: forgedMaster })).rejects.toMatchObject({ code: 'invalid_request' })
  }, 60_000)

  it('runs desktop Watcher list, read, watch, park, start, send, stop, settle, unsettle, outcomes, and project-origins against Rust sotto-host', async () => {
    const binary = await findRustHostBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-watcher-e2e-'))
    await prepareFake(dataDir, 'codex')
    const host = await startHost(
      [binary, '--data', '{data}', '--fake', '{provider}', '--fixtures-dir', resolve('tests/fixtures')],
      dataDir,
      'codex',
      30_000,
    )
    cleanups.push(async () => { await host.stop(); await rm(dataDir, { recursive: true, force: true }) })

    const descriptor = JSON.parse(await readFile(join(dataDir, 'host-listener.json'), 'utf8')) as {
      hostId: string
      port: number
      adminToken: string
    }
    const url = `http://127.0.0.1:${descriptor.port}`

    // Pair & record desktop.
    const pairCode = await issuePairingCode(descriptor.port, descriptor.adminToken)
    const pairing = await SocketHostService.pair(url, pairCode, 'Master Desktop')
    await writeFile(join(dataDir, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]), 'utf8')
    const socket = new SocketHostService({
      url,
      token: pairing.token,
      watcherEnabled: true,
      crossMachineEnabled: true,
    })
    cleanups.push(async () => { await socket.close() })
    await socket.connect()
    await socket.command({ type: 'connect', provider: 'codex' })
    await expect.poll(() => socket.shell().host.models.some(m => m.providerId === 'codex' && m.ready), { timeout: 15_000 }).toBe(true)

    // Create a real Git repo project with a GitHub origin on the remote Rust host.
    const repoDir = join(dataDir, 'worker-repo')
    await mkdir(repoDir, { recursive: true })
    await initializeGitRepository(repoDir)
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:millZach/Sotto.git'], { cwd: repoDir })
    await socket.command({
      type: 'create-project',
      provider: 'codex',
      title: 'Rust Remote Repo',
      path: repoDir,
      useExisting: true,
    })
    const remoteProject = socket.shell().host.projects.find(p => p.path === repoDir)!
    const remoteModel = socket.shell().host.models.find(m => m.providerId === 'codex' && m.ready)!
    expect(remoteProject).toBeDefined()
    expect(remoteModel).toBeDefined()

    // Spin up real TS desktop WatcherService + DesktopHostRouter connected to the Rust host!
    const workspace = await workspaceFixture(undefined, { history: false })
    const f = await agentControlFixture({
      directory: workspace.root,
      host: workspace.host,
      credentialOptions: { mode: 'unavailable' },
      control: { historyEnabled: () => false, watcherEnabled: true },
    })
    const watcher = new WatcherService({
      ordinaryBatch: SHORT_BATCH,
      directory: f.root,
      host: workspace.host,
      control: f.control,
      historyEnabled: () => false,
      crossMachine: true,
      workerMachine: () => 'watcher',
      checks: new CheckQueue('This computer'),
    })
    const tools = new WatcherToolServer(watcher, { machines: true })
    workspace.host.useWatcherTools(tools)
    const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true })
    router.add({
      hostId: pairing.hostId,
      name: 'Forge Rust Host',
      kind: 'remote',
      service: socket,
      clientId: pairing.clientId,
      detail: id => socket.readThreadDetail(id),
      preview: () => null,
    })
    watcher.useRemoteHosts(router.watcherHosts())
    cleanups.push(async () => {
      watcher.close()
      await (watcher as unknown as { reconciling?: Promise<void> }).reconciling?.catch(() => undefined)
      router.dispose()
      await tools.close()
      f.control.dispose()
      await f.control.closed()
      await workspace.stop()
      await workspace.remove()
    })

    await f.control.start()
    await f.control.commandShell({ type: 'connect', provider: 'codex' })
    await watcher.recover()
    const localModel = f.control.shell().host.models.find(m => m.providerId === 'codex')!
    expect(await watcher.open({ provider: 'codex', modelId: localModel.id })).toMatchObject({ status: 'ok' })
    const watcherThreadId = watcher.state().current!.target.threadId
    await f.control.commandShell({
      type: 'manual-send',
      threadId: watcherThreadId,
      draftId: randomUUID(),
      text: 'Drive the Rust remote host',
    })
    const requestId = watcher.state().requests.at(-1)!.id
    const call = async <N extends WatcherToolName>(name: N, input: unknown): Promise<WatcherToolOutput<N>> => {
      return watcherToolSchemas[name].output.parse(await watcher.invoke(watcherThreadId, name, input)) as WatcherToolOutput<N>
    }

    // Verify router reports all expected Watcher capabilities for the Rust host.
    expect(router.watcherHosts().hosts()).toEqual([
      expect.objectContaining({
        hostId: pairing.hostId,
        control: true,
        reads: true,
        standingWatch: true,
        workSettled: true,
        outcomes: true,
        origins: true,
        gitInit: true,
        checks: true,
        checkStop: true,
        newOwner: true,
        muse: true,
        cursor: true,
        antigravity: true,
        permissionCeiling: 'approval-required',
      }),
    ])

    // 1. project-origins + list_projects + list_working_copies
    const origins = await router.watcherHosts().projectOrigins!(pairing.hostId)
    expect(origins).toEqual({
      projects: [{ projectId: remoteProject.id, repository: { host: 'github.com', owner: 'millZach', name: 'Sotto' } }],
    })
    const listedProjects = await call('list_projects', { hostId: pairing.hostId })
    expect(listedProjects).toMatchObject({
      status: 'ok',
      projects: [expect.objectContaining({
        target: { hostId: pairing.hostId, projectId: remoteProject.id },
        controlAvailable: true,
        readsAvailable: true,
      })],
    })
    const copies = await call('list_working_copies', {
      project: { hostId: pairing.hostId, projectId: remoteProject.id },
    })
    expect(copies).toMatchObject({
      status: 'ok',
      choices: expect.arrayContaining([
        expect.objectContaining({ kind: 'shared' }),
        expect.objectContaining({ kind: 'new-worktree' }),
      ]),
    })

    // 2. Permission ceiling: without allow-answers, full-access is refused; after allow-answers, it succeeds.
    await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
    const startInput = () => ({
      requestId,
      retryKey: randomUUID(),
      project: { hostId: pairing.hostId, projectId: remoteProject.id },
      modelId: remoteModel.id,
      permission: { kind: 'runtime' as const, mode: 'full-access' as const },
      workingCopy: { kind: 'shared' as const },
      sharedReason: 'Synthetic test reason for shared checkout.',
      title: 'Rust Worker One',
      firstPrompt: 'rust_host_private_prompt_abc123',
    })
    expect(await call('start_thread', startInput())).toMatchObject({
      status: 'refused',
      code: 'PERMISSION_TOO_WIDE',
    })

    await setAllowAnswers(descriptor.port, descriptor.adminToken, pairing.clientId, true)
    await expect.poll(() => router.watcherHosts().hosts()[0]?.permissionCeiling, { timeout: 10_000 }).toBe('full-access')

    // 3. Start thread on Rust host: verify host-v1 limits shim, selection preservation, retry idempotency, and privacy on disk.
    const selectedBefore = router.shell().activeThreadId
    const rawSpy = vi.spyOn(socket as unknown as { call(op: { op: string }): Promise<unknown> }, 'call')
    const input = startInput()
    const started = await call('start_thread', input)
    expect(started).toMatchObject({ status: 'ok', limits: { promptCount: 1, promptLimit: 4 } })
    const controlIdx = rawSpy.mock.calls.findIndex(([req]) => req.op === 'watcher-control')
    expect(controlIdx).toBeGreaterThanOrEqual(0)
    const wireReply = await rawSpy.mock.results[controlIdx]!.value as { limits: Record<string, unknown> }
    rawSpy.mockRestore()
    expect(wireReply.limits).toMatchObject({ inFlight: 0, inFlightLimit: 8, promptCount: 1 })
    expect(wireReply).not.toHaveProperty('warning')
    if (started.status !== 'ok' || !('target' in started)) throw new Error('start_thread failed')

    // Selection was not changed on the desktop or host.
    expect(router.shell().activeThreadId).toBe(selectedBefore)
    // Idempotent retry returns the same receipt.
    expect(await call('start_thread', input)).toMatchObject({
      status: 'ok',
      receipt: { operationId: started.receipt.operationId },
    })
    // Host record persisted remoteOrigin and ZERO prompt text.
    const savedRecord = await readFile(join(dataDir, WATCHER_RECORD_FILE), 'utf8')
    expect(savedRecord).toContain('remoteOrigin')
    expect(savedRecord).not.toContain('rust_host_private_prompt_abc123')

    // 4. list_threads & read_thread (including HISTORY_RESET)
    const listedThreads = await call('list_threads', { hostId: pairing.hostId })
    expect(listedThreads).toMatchObject({
      status: 'ok',
      rows: expect.arrayContaining([expect.objectContaining({ target: started.target, title: 'Rust Worker One' })]),
    })
    const read = await call('read_thread', { target: started.target })
    expect(read).toMatchObject({
      status: 'ok',
      messages: [expect.objectContaining({ role: 'user', text: 'rust_host_private_prompt_abc123', position: 0 })],
    })
    expect(await call('read_thread', {
      target: started.target,
      position: { historyEpoch: 'wrong-epoch', afterPosition: -1 },
    })).toMatchObject({ status: 'refused', code: 'HISTORY_RESET' })

    // 5. Complete the fake Codex turn on the Rust host and verify `watcher-outcomes` (`read_operation`).
    await expect.poll(
      () => socket.shell().host.threads.find(t => t.id === started.target.threadId)?.status,
      { timeout: 10_000 },
    ).toBe('running')
    await drive(dataDir, 'codex', { type: 'complete', thread: started.target.threadId, text: 'Rust host turn answer' })
    await expect.poll(
      () => socket.shell().host.threads.find(t => t.id === started.target.threadId)?.status,
      { timeout: 10_000 },
    ).toBe('idle')

    const opRead = await call('read_operation', { operationId: started.receipt.operationId })
    expect(opRead).toMatchObject({
      status: 'ok',
      outcome: 'answered',
      reply: { from: 'worker', text: 'Rust host turn answer' },
    })

    // 6. Standing watches: park_thread, unwatch_thread, and re-watch via watcher.watchThread
    const parked = await tools.call(watcherThreadId, 'park_thread', { target: started.target, parked: true })
    expect(parked.structuredContent).toMatchObject({ status: 'ok', parked: true })
    const unwatched = await call('unwatch_thread', { target: started.target })
    expect(unwatched).toMatchObject({ status: 'ok', watched: false })
    const rewatched = await watcher.watchThread({ target: started.target })
    expect(rewatched).toMatchObject({ status: 'ok' })
    const watchRequestId = watcher.state().standingWatches!.find(w => w.target.threadId === started.target.threadId)!.id

    // 7. send_to_thread (`now` + `queue`), stop_thread, settle_thread (under the new standing watch!),
    //    and restore-thread (`unsettle`)
    const second = await call('send_to_thread', {
      requestId: watchRequestId,
      retryKey: randomUUID(),
      target: started.target,
      text: 'Second prompt to Rust host',
      delivery: 'now',
    })
    expect(second).toMatchObject({ status: 'ok', limits: { promptCount: 2 } })
    await expect.poll(
      () => socket.shell().host.threads.find(t => t.id === started.target.threadId)?.status,
      { timeout: 10_000 },
    ).toBe('running')

    // Queue a third prompt while running (`delivery: 'queue'`).
    const queued = await call('send_to_thread', {
      requestId: watchRequestId,
      retryKey: randomUUID(),
      target: started.target,
      text: 'Queued follow-up to Rust host',
      delivery: 'queue',
    })
    expect(queued).toMatchObject({ status: 'ok', delivery: 'queue', limits: { promptCount: 3 } })

    const stopped = await call('stop_thread', {
      requestId: watchRequestId,
      retryKey: randomUUID(),
      target: started.target,
    })
    expect(stopped).toMatchObject({ status: 'ok', stopRequested: true })
    await expect.poll(
      () => socket.shell().host.threads.find(t => t.id === started.target.threadId)?.status,
      { timeout: 10_000 },
    ).toBe('idle')

    const settled = await call('settle_thread', {
      requestId: watchRequestId,
      retryKey: randomUUID(),
      target: started.target,
    })
    expect(settled).toMatchObject({ status: 'ok', state: { settled: true } })
    await expect.poll(
      () => Boolean(socket.shell().host.threads.find(t => t.id === started.target.threadId)?.workspaceSettledAt),
      { timeout: 10_000 },
    ).toBe(true)

    // Restore (`unsettle`) through the Rust host.
    await socket.command({ type: 'restore-thread', threadId: started.target.threadId })
    await expect.poll(
      () => socket.shell().host.threads.find(t => t.id === started.target.threadId)?.workspaceSettledAt,
      { timeout: 10_000 },
    ).toBeUndefined()

    // 8. Check queue (`watcher-check-queue` + `watcher-check-stop`): second check waits behind first,
    //    and stop_thread cancels it cleanly.
    const checkOne = await call('start_thread', {
      requestId,
      retryKey: randomUUID(),
      project: { hostId: pairing.hostId, projectId: remoteProject.id },
      modelId: remoteModel.id,
      permission: { kind: 'runtime' as const, mode: 'full-access' as const },
      workingCopy: { kind: 'shared' as const },
      sharedReason: 'Synthetic test reason for check 1.',
      title: 'Rust Check One',
      firstPrompt: 'Run check one',
      testRun: true,
    })
    expect(checkOne, JSON.stringify(checkOne)).toMatchObject({ status: 'ok' })
    const checkTwo = await call('start_thread', {
      requestId,
      retryKey: randomUUID(),
      project: { hostId: pairing.hostId, projectId: remoteProject.id },
      modelId: remoteModel.id,
      permission: { kind: 'runtime' as const, mode: 'full-access' as const },
      workingCopy: { kind: 'shared' as const },
      sharedReason: 'Synthetic test reason for check 2.',
      title: 'Rust Check Two',
      firstPrompt: 'Run check two',
      testRun: true,
    })
    expect(checkTwo, JSON.stringify(checkTwo)).toMatchObject({ status: 'ok', check: { ahead: 1 } })
    if (checkTwo.status !== 'ok' || !('target' in checkTwo)) throw new Error('checkTwo failed')
    const stoppedCheckTwo = await call('stop_thread', {
      requestId,
      retryKey: randomUUID(),
      target: checkTwo.target,
    })
    expect(stoppedCheckTwo, JSON.stringify(stoppedCheckTwo)).toMatchObject({ status: 'ok', stopRequested: true })
  }, 90_000)
})
