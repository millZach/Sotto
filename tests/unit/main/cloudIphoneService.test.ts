// @vitest-environment node
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudIphoneService, type CloudIphoneDependencies } from '../../../src/main/tools/cloudIphone/service'
import { CloudUsageLedger } from '../../../src/main/tools/cloudIphone/usageLedger'
import type { CloudDeviceProvider, CloudInteraction } from '../../../src/main/tools/cloudIphone/runCloudClient'

import { FilesService } from '../../../src/main/files/service'
import { CLOUD_IPHONE_MAX_BUILD_BYTES, CLOUD_IPHONE_REQUEST_MS, type CloudEvent } from '../../../src/shared/cloudIphone'
import { testCredentials } from '../../fixtures/testCredentials'
import { deferred } from '../../fixtures/deferred'

// The service mounts a viewer view only when asked; these tests never call mount.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  WebContentsView: vi.fn(),
  session: { fromPartition: vi.fn() },
  nativeImage: {
    createFromBuffer: () => ({
      getSize: () => ({ width: 1, height: 1 }),
      resize: () => ({ toDataURL: () => 'data:image/png;base64,resized' }),
      toDataURL: () => 'data:image/png;base64,plain',
    }),
  },
}))

/** A deterministic, manually-advanced clock and timer scheduler: no real waiting, no vitest fake-timer interplay with async provider mocks. */
class FakeClock {
  private current = 1_700_000_000_000
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  private nextId = 1
  now = (): number => this.current
  setTimer = (callback: () => void, ms: number): number => {
    const id = this.nextId++
    this.timers.set(id, { at: this.current + Math.max(0, ms), callback })
    return id
  }
  clearTimer = (id: unknown): void => { this.timers.delete(id as number) }
  /** Advances in steps to the next due timer, so a timer that reschedules itself at 0 cannot hang this call. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (let guard = 0; guard < 10_000; guard++) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.current = due[1].at
      due[1].callback()
      await Promise.resolve(); await Promise.resolve()
    }
    this.current = target
  }
}

interface FakeProvider extends CloudDeviceProvider { calls: Record<string, unknown[][]> }
function fakeProvider(): FakeProvider {
  const calls: Record<string, unknown[][]> = {}
  const record = (name: string, args: unknown[]): void => { calls[name] = [...(calls[name] ?? []), args] }
  return {
    calls,
    checkKey: vi.fn(async () => { record('checkKey', []) }),
    upload: vi.fn(async (path: string) => { record('upload', [path]); return 'asset-1' }),
    deleteAsset: vi.fn(async (id: string) => { record('deleteAsset', [id]) }),
    start: vi.fn(async (options: { assetId: string; displayName: string }) => { record('start', [options]); return { id: 'runcloud-session-1', viewerUrl: 'https://viewer.run.cloud/secret-token', device: 'iPhone 16' } }),
    get: vi.fn(async () => ({ status: 'active' })),
    release: vi.fn(async (id: string) => { record('release', [id]) }),
    interact: vi.fn(async (id: string, action: CloudInteraction) => { record('interact', [id, action]) }),
    openUrl: vi.fn(async (id: string, url: string) => { record('openUrl', [id, url]) }),
    screenshot: vi.fn(async () => Buffer.from([1, 2, 3])),
    accessibility: vi.fn(async () => ({ screen: { width: 400, height: 800 }, roots: [{ role: 'Button', label: 'Go', value: null, identifier: 'go', bounds: { x: 0, y: 0, width: 10, height: 10 }, states: { enabled: true, focused: false }, children: [] }] })),
    keepAlive: vi.fn(async () => undefined),
  }
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function setup(options: { capMinutes?: number; idleMinutes?: number; onProvider?: (provider: FakeProvider) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-iphone-service-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const credentials = await testCredentials(root, { mode: 'plain' })

  const ledger = new CloudUsageLedger(root)
  await ledger.load()
  const unavailableThreads = new Set<string>()
  const files = new FilesService({ resolveBinding: threadId => unavailableThreads.has(threadId) ? null : ({ threadId, projectId: 'project', workingDirectory: root }), copyPath: vi.fn(), reveal: vi.fn() })
  const events: CloudEvent[] = []
  const clock = new FakeClock()
  let settingsState = { monthlyMinutes: options.capMinutes ?? 750, idleMinutes: options.idleMinutes ?? 5 }
  const providers: FakeProvider[] = []
  const dependencies: CloudIphoneDependencies = {
    files, credentials, ledger,
    settings: () => settingsState,
    threadTitle: () => 'Test thread',
    getWindow: () => null,
    emit: event => { events.push(event) },
    provider: () => { const provider = fakeProvider(); options.onProvider?.(provider); providers.push(provider); return provider },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  }
  const service = new CloudIphoneService(dependencies)
  cleanup.push(() => service.dispose())
  return {
    service, root, files, credentials, ledger, events, clock, providers, unavailableThreads,
    setCap: (minutes: number) => { settingsState = { ...settingsState, monthlyMinutes: minutes } },
  }
}

async function makeBuild(root: string, name = 'build.zip', bytes = 'a simulator build'): Promise<string> {
  await writeFile(join(root, name), bytes)
  return name
}
async function workspaceIdOf(files: FilesService, threadId = 'thread-1'): Promise<string> {
  const resolved = await files.resolveWorkspace(threadId)
  if (!resolved.ok) throw new Error('workspace unavailable')
  return resolved.value.workspaceId
}
async function openSession(service: CloudIphoneService, files: FilesService, root: string, overrides: Partial<{ buildPath: string; description: string; threadId: string }> = {}) {
  const buildPath = overrides.buildPath ?? await makeBuild(root)
  const threadId = overrides.threadId ?? 'thread-1', workspaceId = await workspaceIdOf(files, threadId)
  const opened = await service.agentOpen({ threadId, workspaceId, buildPath, description: overrides.description ?? 'Check the signed build' })
  if (!opened.ok) throw new Error(`agentOpen failed: ${opened.error.message}`)
  return { threadId, workspaceId, session: opened.value }
}
/**
 * Waits for the session to reach `active`. `startSession` now re-reads the build from real disk right before
 * upload (finding 7), so this needs real wall-clock room for that I/O, not just the fake clock's microtasks.
 */
async function waitActive(service: CloudIphoneService, clock: FakeClock, threadId: string): Promise<void> {
  await vi.waitFor(async () => {
    await clock.advance(0)
    const current = await service.sessions({ threadId })
    if (!current.ok || current.value[0]?.status !== 'active') throw new Error(`Session never became active: ${current.ok ? current.value[0]?.status : current.error.message}`)
  })
}

describe('CloudIphoneService', () => {
  it('refuses to ask when no key is saved, and uploads nothing', async () => {
    const { service, files, root } = await setup()
    const { session } = await openSession(service, files, root)
    expect(session.status).toBe('refused')
    expect(session.problem).toMatch(/Add a run\.cloud key/u)
    expect(session.buildBytes).toBe(0)
  })

  it('refuses at the cap before anything is uploaded, naming the cap', async () => {
    const { service, files, root, credentials, ledger, clock } = await setup({ capMinutes: 10 })
    await credentials.set('runcloud', 'rc_live_key')
    await ledger.start('past-session', 'thread-x', 'Other thread', clock.now() - 20 * 60_000)
    await ledger.end('past-session', clock.now(), 20)
    const { session } = await openSession(service, files, root)
    expect(session.status).toBe('refused')
    expect(session.problem).toMatch(/10/u)
    expect(session.problem).toMatch(/Nothing was uploaded/u)
  })

  it('rejects a build path that is missing, a directory, the wrong extension, or too large', async () => {
    const { service, files, root, credentials } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const threadId = 'thread-1', workspaceId = await workspaceIdOf(files)

    const missing = await service.agentOpen({ threadId, workspaceId, buildPath: 'does-not-exist.zip', description: 'd' })
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error.code).toBe('blocked')

    await mkdir(join(root, 'adir.zip'))
    const directory = await service.agentOpen({ threadId, workspaceId, buildPath: 'adir.zip', description: 'd' })
    expect(directory.ok).toBe(false)

    await writeFile(join(root, 'wrong.txt'), 'not a build')
    const wrongExtension = await service.agentOpen({ threadId, workspaceId, buildPath: 'wrong.txt', description: 'd' })
    expect(wrongExtension.ok).toBe(false)

    const handle = await open(join(root, 'huge.zip'), 'w')
    await handle.truncate(CLOUD_IPHONE_MAX_BUILD_BYTES + 1)
    await handle.close()
    const tooLarge = await service.agentOpen({ threadId, workspaceId, buildPath: 'huge.zip', description: 'd' })
    expect(tooLarge.ok).toBe(false)
  })

  it('rejects a build path that escapes the thread’s folder, even when the outside file exists', async () => {
    const { service, files, root, credentials } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    // A real file one level above the thread's own working folder: inside the containment check's reach, not before it.
    const escapePath = join(root, '..', 'outside.zip')
    await writeFile(escapePath, 'x')
    cleanup.push(() => rm(escapePath, { force: true }))
    const result = await service.agentOpen({ threadId: 'thread-1', workspaceId: await workspaceIdOf(files), buildPath: '../outside.zip', description: 'd' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/outside/u)
  })

  it('lapses an unanswered request into denied after the request window', async () => {
    const { service, files, root, credentials, clock, events } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { session } = await openSession(service, files, root)
    expect(session.status).toBe('asking')
    await clock.advance(CLOUD_IPHONE_REQUEST_MS + 1_000)
    const sessions = await service.sessions({ threadId: 'thread-1' })
    expect(sessions.ok && sessions.value[0]?.status).toBe('denied')
    expect(sessions.ok && sessions.value[0]?.problem).toMatch(/lapsed/u)
    expect(events.some(event => event.type === 'session' && event.session.status === 'denied')).toBe(true)
  })

  it('answering deny uploads nothing', async () => {
    const { service, files, root, credentials, providers } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    const answered = await service.answer({ threadId, workspaceId, sessionId: session.id, allow: false })
    expect(answered.ok && answered.value.status).toBe('denied')
    expect(providers).toHaveLength(0)
  })

  it('answering allow goes starting then active, uploads once, starts once, and records the ledger', async () => {
    const { service, files, root, credentials, providers, ledger, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    const answered = await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    expect(answered.ok && answered.value.status).toBe('starting')
    await waitActive(service, clock, threadId)
    const provider = providers[0]!
    expect(provider.upload).toHaveBeenCalledTimes(1)
    expect(provider.start).toHaveBeenCalledTimes(1)
    const current = await service.sessions({ threadId })
    expect(current.ok && current.value[0]?.device).toBe('iPhone 16')
    expect(ledger.monthMinutes(clock.now())).toBeGreaterThanOrEqual(0)
  })

  it('allows only one live session per thread', async () => {
    const { service, files, root, credentials } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    await openSession(service, files, root)
    const second = await service.agentOpen({ threadId: 'thread-1', workspaceId: await workspaceIdOf(files), buildPath: await makeBuild(root, 'second.zip'), description: 'd' })
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error.code).toBe('busy')
  })

  it('converts iOS-point actions to run.cloud fractions using the accessibility snapshot size, and never logs typed text', async () => {
    const { service, files, root, credentials, providers, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    const provider = providers[0]!

    const tap = await service.agentAction({ threadId, workspaceId, action: { type: 'tap', x: 200, y: 400 } })
    expect(tap.ok).toBe(true)
    expect(provider.interact).toHaveBeenCalledWith('runcloud-session-1', { kind: 'tap', x: 0.5, y: 0.5 })

    const typed = await service.agentAction({ threadId, workspaceId, action: { type: 'type', text: 'hunter2-secret' } })
    expect(typed.ok).toBe(true)
    const serialized = JSON.stringify(typed)
    expect(serialized).not.toContain('hunter2-secret')
    expect(serialized).toContain('Entered text.')
  })

  it('returns a screenshot as a PNG data URL', async () => {
    const { service, files, root, credentials, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    const shot = await service.agentAction({ threadId, workspaceId, action: { type: 'screenshot' } })
    expect(shot.ok).toBe(true)
    expect(shot.ok && shot.value.image).toMatch(/^data:image\/png;base64,/u)
  })

  it('ends an idle session after the idle minutes and resets the timer on an action', async () => {
    const { service, files, root, credentials, clock } = await setup({ idleMinutes: 5 })
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    await clock.advance(4 * 60_000)
    await service.agentAction({ threadId, workspaceId, action: { type: 'inspect' } })
    await clock.advance(4 * 60_000)
    let current = await service.sessions({ threadId })
    expect(current.ok && current.value[0]?.status).toBe('active')
    await clock.advance(2 * 60_000)
    // The idle timeout's own release, asset deletion and ledger write are real async work the fake clock does not await.
    await vi.waitFor(async () => {
      const polled = await service.sessions({ threadId })
      expect(polled.ok && polled.value[0]?.status).toBe('ended')
    })
    current = await service.sessions({ threadId })
    expect(current.ok && current.value[0]?.endReason).toBe('idle')
  })

  it('ends a session when the month cap runs out', async () => {
    const { service, files, root, credentials, clock } = await setup({ capMinutes: 2 })
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    await clock.advance(3 * 60_000)
    await vi.waitFor(async () => {
      const polled = await service.sessions({ threadId })
      expect(polled.ok && polled.value[0]?.status).toBe('ended')
    })
    const current = await service.sessions({ threadId })
    expect(current.ok && current.value[0]?.endReason).toBe('cap')
  })

  it('finish releases the simulator and deletes the asset', async () => {
    const { service, files, root, credentials, providers, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    const provider = providers[0]!
    const finished = await service.agentFinish({ threadId, workspaceId, status: 'completed', summary: 'All good', unchecked: ['push notifications'] })
    expect(finished.ok && finished.value.status).toBe('ended')
    expect(finished.ok && finished.value.endReason).toBe('finished')
    expect(provider.release).toHaveBeenCalledWith('runcloud-session-1')
    expect(provider.deleteAsset).toHaveBeenCalledWith('asset-1')
  })

  it('the user’s end also releases and deletes', async () => {
    const { service, files, root, credentials, providers, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    const provider = providers[0]!
    const ended = await service.end({ threadId, workspaceId, sessionId: session.id })
    expect(ended.ok && ended.value.status).toBe('ended')
    expect(ended.ok && ended.value.endReason).toBe('user')
    expect(provider.release).toHaveBeenCalled()
    expect(provider.deleteAsset).toHaveBeenCalled()
  })

  it('an End while the build uploads leaves nothing running or billed', async () => {

    const { promise: uploading, resolve: finishUpload } = deferred<string>()
    const { service, files, root, credentials, providers } = await setup({ onProvider: provider => { vi.mocked(provider.upload).mockImplementation(() => uploading) } })
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await vi.waitFor(() => expect(providers[0]?.upload).toHaveBeenCalled())
    const ended = await service.end({ threadId, workspaceId, sessionId: session.id })
    expect(ended.ok && ended.value.status).toBe('ended')
    finishUpload('asset-late')
    const provider = providers[0]!
    await vi.waitFor(() => expect(provider.deleteAsset).toHaveBeenCalledWith('asset-late'))
    expect(provider.start).not.toHaveBeenCalled()
    const after = await service.sessions({ threadId })
    expect(after.ok && after.value[0]!.status).toBe('ended')
  })

  it('notices when run.cloud ends a session itself', async () => {
    const { service, files, root, credentials, providers, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    vi.mocked(providers[0]!.get).mockResolvedValue({ status: 'released' })
    await clock.advance(60_000)
    await vi.waitFor(async () => {
      const after = await service.sessions({ threadId })
      expect(after.ok && after.value[0]).toMatchObject({ status: 'ended', endReason: 'lost' })
    })
  })

  it('dispose releases every live session', async () => {
    const { service, files, root, credentials, providers, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    await service.dispose()
    expect(providers[0]!.release).toHaveBeenCalled()
  })

  it('never puts the key or the viewer URL in any emitted event, error or step', async () => {
    const key = 'rc_live_super_secret_key'
    const { service, files, root, credentials, events, clock } = await setup()
    await credentials.set('runcloud', key)
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    await service.agentAction({ threadId, workspaceId, action: { type: 'tap', x: 1, y: 1 } })
    const finished = await service.agentFinish({ threadId, workspaceId, status: 'completed', summary: 'Done', unchecked: [] })
    const serialized = JSON.stringify([events, finished])
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain('viewer.run.cloud')
    expect(serialized).not.toContain('secret-token')
  })

  it('a release failure during teardown is queued and retried on the next tick, and the problem says it keeps trying', async () => {
    const { service, files, root, credentials, providers, ledger, clock } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    const provider = providers[0]!
    vi.mocked(provider.release).mockRejectedValueOnce(new Error('run.cloud is unavailable'))
    const ended = await service.end({ threadId, workspaceId, sessionId: session.id })
    expect(ended.ok && ended.value.status).toBe('ended')
    expect(ended.ok && ended.value.problem).toMatch(/could not release the simulator yet/u)
    expect(ledger.pendingCleanup()).toContainEqual(expect.objectContaining({ kind: 'session', handle: 'runcloud-session-1' }))
    // The next shared tick retries it through `resumeCleanup`, clearing the pending entry once it succeeds.
    // `resumeCleanup` makes its own provider from the saved key, as `setKey` does, so the retry lands on a
    // fresh instance rather than the one `startSession` used.
    await clock.advance(60_000)
    await vi.waitFor(() => expect(ledger.pendingCleanup()).toHaveLength(0))
    expect(providers.length).toBeGreaterThanOrEqual(2)
    expect(providers[providers.length - 1]!.release).toHaveBeenCalledWith('runcloud-session-1')
  })

  it('says the upload could not be deleted yet, rather than claiming success, when the simulator fails to start and deletion also fails', async () => {
    const { service, files, root, credentials } = await setup({ onProvider: provider => {
      vi.mocked(provider.start).mockRejectedValue(new Error('run.cloud could not start the simulator.'))
      vi.mocked(provider.deleteAsset).mockRejectedValue(new Error('run.cloud is unavailable'))
    } })
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await vi.waitFor(async () => {
      const current = await service.sessions({ threadId })
      expect(current.ok && current.value[0]?.status).toBe('failed')
    })
    const current = await service.sessions({ threadId })
    expect(current.ok && current.value[0]?.problem).toMatch(/could not delete the upload yet/u)
    expect(current.ok && current.value[0]?.problem).not.toMatch(/uploaded and then deleted/u)
  })

  it('releases a simulator that finished starting after an End raced a still-pending teardown delete', async () => {

    const { promise: starting, resolve: resolveStart } = deferred<{ id: string; viewerUrl: string; device: string }>()

    const { promise: deleting, resolve: resolveDelete } = deferred<void>()
    const { service, files, root, credentials, providers } = await setup({ onProvider: provider => {
      vi.mocked(provider.start).mockImplementation(() => starting)
      vi.mocked(provider.deleteAsset).mockImplementation(() => deleting)
    } })
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await vi.waitFor(() => expect(providers[0]?.start).toHaveBeenCalled())
    // The build finished uploading (the asset is already known); starting the simulator and the end's own
    // teardown deletion of that asset are both in flight at once.
    const ending = service.end({ threadId, workspaceId, sessionId: session.id })
    await vi.waitFor(() => expect(providers[0]?.deleteAsset).toHaveBeenCalled())
    resolveStart({ id: 'runcloud-late', viewerUrl: 'https://viewer.run.cloud/late', device: 'iPhone 16' })
    resolveDelete()
    const ended = await ending
    expect(ended.ok && ended.value.status).toBe('ended')
    await vi.waitFor(() => expect(providers[0]!.release).toHaveBeenCalledWith('runcloud-late'))
    const after = await service.sessions({ threadId })
    expect(after.ok && after.value[0]!.status).toBe('ended')
  })

  it('dispose awaits an in-flight start and releases what it made rather than leaving it running', async () => {

    const { promise: starting, resolve: resolveStart } = deferred<{ id: string; viewerUrl: string; device: string }>()
    const { service, files, root, credentials, providers } = await setup({ onProvider: provider => { vi.mocked(provider.start).mockImplementation(() => starting) } })
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await vi.waitFor(() => expect(providers[0]?.start).toHaveBeenCalled())
    const disposing = service.dispose()
    resolveStart({ id: 'late-session', viewerUrl: 'https://viewer.run.cloud/late', device: 'iPhone 16' })
    await disposing
    expect(providers[0]!.release).toHaveBeenCalledWith('late-session')
  })

  it('a shared tick ends every active session across threads once the cap is reached, and a lowered cap mid-session is enforced', async () => {
    const { service, files, root, credentials, clock, setCap } = await setup({ capMinutes: 10 })
    await credentials.set('runcloud', 'rc_live_key')
    const first = await openSession(service, files, root, { threadId: 'thread-1', buildPath: await makeBuild(root, 'a.zip') })
    const second = await openSession(service, files, root, { threadId: 'thread-2', buildPath: await makeBuild(root, 'b.zip') })
    await service.answer({ threadId: first.threadId, workspaceId: first.workspaceId, sessionId: first.session.id, allow: true })
    await service.answer({ threadId: second.threadId, workspaceId: second.workspaceId, sessionId: second.session.id, allow: true })
    await waitActive(service, clock, first.threadId)
    await waitActive(service, clock, second.threadId)
    setCap(1) // Lowered below what the two sessions already use together.
    await clock.advance(60_000)
    await vi.waitFor(async () => {
      const a = await service.sessions({ threadId: first.threadId })
      const b = await service.sessions({ threadId: second.threadId })
      expect(a.ok && a.value[0]?.status).toBe('ended')
      expect(b.ok && b.value[0]?.status).toBe('ended')
    })
    const a = await service.sessions({ threadId: first.threadId })
    const b = await service.sessions({ threadId: second.threadId })
    expect(a.ok && a.value[0]?.endReason).toBe('cap')
    expect(b.ok && b.value[0]?.endReason).toBe('cap')
  })

  it('revalidates the build immediately before upload and refuses, uploading nothing, if it changed since asking', async () => {
    const { service, files, root, credentials, providers } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const buildPath = await makeBuild(root)
    const { threadId, workspaceId, session } = await openSession(service, files, root, { buildPath })
    await writeFile(join(root, buildPath), 'a different, much larger simulator build payload than before')
    const answered = await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    expect(answered.ok && answered.value.status).toBe('starting')
    await vi.waitFor(async () => {
      const current = await service.sessions({ threadId })
      expect(current.ok && current.value[0]?.status).toBe('failed')
    })
    const current = await service.sessions({ threadId })
    expect(current.ok && current.value[0]?.problem).toMatch(/changed since you were asked/u)
    expect(providers).toHaveLength(0)
  })

  it('ends a session whose thread becomes unavailable, checked on the shared minute tick', async () => {
    const { service, files, root, credentials, clock, unavailableThreads } = await setup()
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    unavailableThreads.add(threadId)
    await clock.advance(60_000)
    await vi.waitFor(async () => {
      const after = await service.sessions({ threadId })
      expect(after.ok && after.value[0]).toMatchObject({ status: 'ended', endReason: 'thread' })
    })
  })

  it('refuses to mount a viewer address that is not https and not a loopback test address', async () => {
    const { service, files, root, credentials, clock } = await setup({ onProvider: provider => {
      vi.mocked(provider.start).mockResolvedValue({ id: 'runcloud-session-1', viewerUrl: 'http://evil.example/viewer/1', device: 'iPhone 16' })
    } })
    await credentials.set('runcloud', 'rc_live_key')
    const { threadId, workspaceId, session } = await openSession(service, files, root)
    await service.answer({ threadId, workspaceId, sessionId: session.id, allow: true })
    await waitActive(service, clock, threadId)
    const mounted = await service.mount({ threadId, workspaceId, sessionId: session.id, bounds: { x: 0, y: 0, width: 300, height: 600 } })
    expect(mounted.ok).toBe(false)
    expect(!mounted.ok && mounted.error.message).toMatch(/secure/u)
  })
})
