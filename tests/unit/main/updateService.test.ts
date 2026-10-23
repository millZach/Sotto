// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  UpdateService,
  describeProblem,
  newVersionListener,
  waitingVersion,
  type UpdaterAdapter,
  type UpdaterEvent,
  type UpdateServiceDependencies,
} from '../../../src/main/updates/updateService'
import type { UpdateStatus } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { deferred } from '../../fixtures/deferred'
import { e2eUpdater } from '../../../src/main/updates/e2eUpdater'

/** Stable answers every Owl feature off. */
const STABLE_FEATURES = { watcher: false, muse: false, usage: false, 'resume-after-restart': false, 'update-all': false, 'streaming-publish-cost': false, 'thread-delegation': false, 'worker-roles': false, 'continue-on-provider': false, 'continue-agent-thread': false, opencode: false, 'dictation-hold-shortcuts': false, 'main-freeze': false, 'iphone-pull-request-view': false, 'iphone-agents-view': false, 'dictation-off': false, 'message-scrubber': false, 'menu-bar-owl': false, 'desktop-notifications': false, 'creature-toggle': false }

type Emit = (event: UpdaterEvent) => void

interface FakeUpdater {
  readonly adapter: UpdaterAdapter
  readonly emit: Emit
  readonly calls: { check: number; download: number; install: number }
}

function createFakeUpdater(
  overrides: {
    check?: (emit: Emit) => Promise<void>
    download?: (emit: Emit) => Promise<void>
    quitAndInstall?: (emit: Emit) => void
  } = {},
): FakeUpdater {
  let listener: ((event: UpdaterEvent) => void) | null = null
  const emit: Emit = (event) => listener?.(event)
  const calls = { check: 0, download: 0, install: 0 }
  const defaultCheck = async (send: Emit): Promise<void> => {
    send({ type: 'checking' })
    send({ type: 'not-available' })
  }
  const defaultDownload = async (send: Emit): Promise<void> => {
    send({ type: 'downloaded', version: '3.5.0' })
  }
  return {
    calls,
    emit,
    adapter: {
      subscribe(next): void {
        listener = next
      },
      async check(): Promise<void> {
        calls.check += 1
        await (overrides.check ?? defaultCheck)(emit)
      },
      async download(): Promise<void> {
        calls.download += 1
        await (overrides.download ?? defaultDownload)(emit)
      },
      quitAndInstall(): void {
        calls.install += 1
        overrides.quitAndInstall?.(emit)
      },
    },
  }
}

/** Drains the microtask queue an automatic check walks through. */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

const offersUpdate = async (send: Emit): Promise<void> => {
  send({ type: 'checking' })
  send({ type: 'available', version: '3.5.0' })
}

function createService(
  overrides: Partial<UpdateServiceDependencies> = {},
  settings: Partial<AppSettings> = {},
): { service: UpdateService; statuses: UpdateStatus[] } {
  const statuses: UpdateStatus[] = []
  const service = new UpdateService({
    currentVersion: '3.4.0',
    getSettings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    onStatusChanged: (status) => statuses.push(status),
    now: () => 1_000,
    ...overrides,
  })
  return { service, statuses }
}

const available = { phase: 'available', version: '3.5.0', problem: null } as const
const downloaded = { phase: 'downloaded', version: '3.5.0', problem: null } as const

describe('UpdateService', () => {
  it('reports the Owl track through existing status even without an updater', async () => {
    const { service } = createService({ currentVersion: '0.1.37-owl.20261011.1' })
    expect(service.status().releaseTrack).toBe('owl')
    expect((await service.check('manual')).releaseTrack).toBe('owl')
  })

  it('walks checking, available, progress, and downloaded in order', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      download: async (send) => {
        send({ type: 'progress', percent: 12.4 })
        send({ type: 'progress', percent: 99.6 })
        send({ type: 'downloaded', version: '3.5.0' })
      },
    })
    const { service, statuses } = createService({ createUpdater: () => updater.adapter })

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      releaseTrack: 'stable',
      owlFeatures: STABLE_FEATURES,
      watcherEnabled: false,
      phase: available,
      checkedAt: 1_000,
    })
    await expect(service.download()).resolves.toEqual({ ok: true })

    expect(statuses.map((status) => status.phase)).toEqual([
      { phase: 'checking' },
      available,
      { phase: 'downloading', version: '3.5.0', percent: 0 },
      { phase: 'downloading', version: '3.5.0', percent: 12 },
      { phase: 'downloading', version: '3.5.0', percent: 100 },
      downloaded,
    ])
    expect(service.status().currentVersion).toBe('3.4.0')
  })

  it('reports being current when the feed offers nothing newer, and when it was last asked', async () => {
    const updater = createFakeUpdater()
    let clock = 5_000
    const { service } = createService({ createUpdater: () => updater.adapter, now: () => clock })

    expect(service.status().checkedAt).toBeNull()
    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      releaseTrack: 'stable',
      owlFeatures: STABLE_FEATURES,
      watcherEnabled: false,
      phase: { phase: 'up-to-date' },
      checkedAt: 5_000,
    })
    clock = 9_000
    await service.check('manual')
    expect(service.status().checkedAt).toBe(9_000)
  })

  it('never contacts the feed automatically while the setting is off', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const scheduled: { startup: (() => void) | null; tick: (() => void) | null } = { startup: null, tick: null }
    const { service, statuses } = createService(
      {
        createUpdater: () => updater.adapter,
        scheduleTimeout: (callback) => { scheduled.startup = callback; return () => undefined },
        scheduleInterval: (callback) => { scheduled.tick = callback; return () => undefined },
      },
      { autoUpdateCheck: false },
    )

    service.start()
    scheduled.startup?.()
    scheduled.tick?.()
    await flush()

    expect(updater.calls.check).toBe(0)
    expect(statuses).toEqual([])
    expect(service.status().phase).toEqual({ phase: 'idle' })
    service.dispose()
  })

  it('still checks when the user asks explicitly with automatic checks off', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const { service } = createService(
      { createUpdater: () => updater.adapter },
      { autoUpdateCheck: false },
    )

    await service.check('manual')

    expect(updater.calls.check).toBe(1)
    expect(service.status().phase).toEqual(available)
  })

  it('treats unreadable settings as withheld consent', async () => {
    const updater = createFakeUpdater()
    const { service } = createService({
      createUpdater: () => updater.adapter,
      getSettings: () => {
        throw new Error('SETTINGS_UNAVAILABLE')
      },
    })

    await service.check('automatic')

    expect(updater.calls.check).toBe(0)
  })

  it.each(['automatic', 'manual'] as const)('keeps the previous offer when a %s check fails', async trigger => {
    let clock = 1
    const updater = createFakeUpdater({ check: async send => {
      if (updater.calls.check === 1) offersUpdate(send)
      else { send({ type: 'error', message: 'offline' }); throw new Error('offline') }
    } })
    const { service } = createService({ createUpdater: () => updater.adapter, now: () => clock })
    await service.check('manual')
    clock = 2
    await service.check(trigger)
    expect(updater.calls.check).toBe(2)
    expect(service.status().phase).toEqual({ ...available, problem: 'offline', failedStep: 'check' })
    expect(service.status().checkedAt).toBe(2)
  })

  it.each(['newer', 'none'] as const)('refreshes an existing offer when the feed returns %s', async result => {
    const updater = createFakeUpdater({ check: async send => {
      if (updater.calls.check === 1) offersUpdate(send)
      else if (result === 'newer') send({ type: 'available', version: '0.1.29' })
      else send({ type: 'not-available' })
    } })
    const { service } = createService({ createUpdater: () => updater.adapter })
    await service.check('manual')
    await service.check('automatic')
    expect(updater.calls.check).toBe(2)
    expect(service.status().phase).toEqual(result === 'newer'
      ? { phase: 'available', version: '0.1.29', problem: null } : { phase: 'up-to-date' })
  })

  it('checks once shortly after start and then once per interval, and cancels both on dispose', async () => {
    const updater = createFakeUpdater()
    // Properties, not `let`s: TypeScript would otherwise keep narrowing the
    // bindings to `null` because the assignments happen inside callbacks.
    const scheduled: { startup: (() => void) | null; tick: (() => void) | null } = { startup: null, tick: null }
    const cancelStartup = vi.fn()
    const cancelInterval = vi.fn()
    const { service } = createService({
      createUpdater: () => updater.adapter,
      scheduleTimeout: (callback, delayMs) => {
        expect(delayMs).toBe(UPDATE_STARTUP_DELAY_MS)
        scheduled.startup = callback
        return cancelStartup
      },
      scheduleInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(UPDATE_CHECK_INTERVAL_MS)
        scheduled.tick = callback
        return cancelInterval
      },
    })

    service.start()
    await flush()
    expect(updater.calls.check).toBe(0)

    scheduled.startup?.()
    await flush()
    expect(updater.calls.check).toBe(1)

    scheduled.tick?.()
    await flush()
    scheduled.tick?.()
    await flush()
    expect(updater.calls.check).toBe(3)

    service.start()
    service.dispose()
    expect(cancelStartup).toHaveBeenCalledOnce()
    expect(cancelInterval).toHaveBeenCalledOnce()
  })

  it('keeps the cadence T3 Code uses: a short startup delay and a few minutes between polls', () => {
    expect(UPDATE_STARTUP_DELAY_MS).toBe(15_000)
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(4 * 60 * 1_000)
  })

  it('answers unsupported and builds no updater when the build has no feed', async () => {
    const { service, statuses } = createService()

    service.start()
    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      releaseTrack: 'stable',
      owlFeatures: STABLE_FEATURES,
      watcherEnabled: false,
      phase: { phase: 'unsupported' },
      checkedAt: null,
    })
    await expect(service.download()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    expect(statuses).toHaveLength(1)
    service.dispose()
  })

  it('survives an updater that cannot be constructed at all', async () => {
    const { service } = createService({
      createUpdater: () => {
        throw new Error('UPDATER_UNAVAILABLE')
      },
    })

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      releaseTrack: 'stable',
      owlFeatures: STABLE_FEATURES,
      watcherEnabled: false,
      phase: { phase: 'unsupported' },
      checkedAt: null,
    })
  })

  it('turns an unreachable feed into a failed phase that carries the reason', async () => {
    const updater = createFakeUpdater({
      check: async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED\n  at Request.onerror')
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      releaseTrack: 'stable',
      owlFeatures: STABLE_FEATURES,
      watcherEnabled: false,
      phase: { phase: 'failed', problem: 'net::ERR_NAME_NOT_RESOLVED' },
      checkedAt: 1_000,
    })
  })

  it('turns a reported error during a check into the same failed phase', async () => {
    const updater = createFakeUpdater({
      check: async (send) => {
        send({ type: 'checking' })
        send({ type: 'error', message: 'HttpError: 503' })
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await expect(service.check('manual')).resolves.toMatchObject({
      phase: { phase: 'failed', problem: 'HttpError: 503' },
    })
  })

  it('ignores a malformed version rather than offering it', async () => {
    const updater = createFakeUpdater({
      check: async (send) => {
        send({ type: 'checking' })
        send({ type: 'available', version: 42 })
        send({ type: 'downloaded', version: '' })
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await expect(service.check('manual')).resolves.toMatchObject({ phase: { phase: 'up-to-date' } })
  })

  it('keeps the offer alive when a download fails and says why', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      download: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await expect(service.download()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(service.status().phase).toEqual({ phase: 'available', version: '3.5.0', problem: 'ECONNRESET', failedStep: 'download' })

    // A retry that lands clears the earlier problem.
    updater.adapter.download = async () => { updater.emit({ type: 'downloaded', version: '3.5.0' }) }
    await expect(service.download()).resolves.toEqual({ ok: true })
    expect(service.status().phase).toEqual(downloaded)
  })

  it('keeps the offer when the download is reported failed by event rather than rejection', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      download: async (send) => {
        send({ type: 'progress', percent: 30 })
        send({ type: 'error', message: 'sha512 checksum mismatch' })
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()
    expect(service.status().phase).toEqual({ phase: 'available', version: '3.5.0', problem: 'sha512 checksum mismatch', failedStep: 'download' })
  })

  it('refuses to download or install anything that was never offered', async () => {
    const updater = createFakeUpdater()
    const { service } = createService({ createUpdater: () => updater.adapter })

    await expect(service.download()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    await service.check('manual')
    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    expect(updater.calls.download).toBe(0)
    expect(updater.calls.install).toBe(0)
  })

  it('quits into the installer only once an update is on disk', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()

    expect(service.install()).toEqual({ ok: true })
    expect(updater.calls.install).toBe(1)
    expect(service.status().phase).toEqual(downloaded)
  })

  it('keeps the download and carries the reason when the installer throws', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      quitAndInstall: () => {
        throw new Error('INSTALLER_MISSING')
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()

    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0', problem: 'INSTALLER_MISSING' })
    // The same action is offered again, and a second attempt that starts clears the problem.
    updater.adapter.quitAndInstall = () => undefined
    expect(service.install()).toEqual({ ok: true })
    expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0', problem: 'INSTALLER_MISSING' })
  })

  it('treats an error event raised while starting the installer as a refused install', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      quitAndInstall: (send) => {
        send({ type: 'error', message: "No update filepath provided, can't quit and install" })
      },
    })
    const { service, statuses } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()
    statuses.length = 0

    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    expect(statuses.map((status) => status.phase)).toEqual([
      { phase: 'downloaded', version: '3.5.0', problem: "No update filepath provided, can't quit and install" },
    ])
  })

  it('still records a refusal that arrives after the installer call has returned', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const { service, statuses } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()
    statuses.length = 0

    // electron-updater reports a spawn failure only once the process it tried to start has failed.
    expect(service.install()).toEqual({ ok: true })
    updater.emit({ type: 'error', message: 'spawn ENOENT' })

    expect(statuses.map((status) => status.phase)).toEqual([
      { phase: 'downloaded', version: '3.5.0', problem: 'spawn ENOENT' },
    ])
    // The same action is offered again, and a fresh attempt starts from a clean slate.
    expect(service.install()).toEqual({ ok: true })
    expect(updater.calls.install).toBe(2)
  })

  it('refreshes a failed download offer on the next successful poll', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      download: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()
    await service.check('automatic')
    expect(updater.calls.check).toBe(2)
    expect(service.status().phase).toEqual(available)

    // A manual check is the user asking afresh, and it refreshes the offer.
    await service.check('manual')
    expect(updater.calls.check).toBe(3)
    expect(service.status().phase).toEqual(available)
  })

  it('falls back to its own sentence when a refused install gives no reason', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      quitAndInstall: (send) => { send({ type: 'error' }) },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()

    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0', problem: 'The installer could not be started.' })
  })

  describe('a restart', () => {
    async function stagedUpdate(overrides: Partial<UpdateServiceDependencies> = {}, installer?: (emit: Emit) => void) {
      const order: string[] = []
      const updater = createFakeUpdater({
        check: offersUpdate,
        quitAndInstall: (send) => { order.push('installer'); installer?.(send) },
      })
      const { service } = createService({
        createUpdater: () => updater.adapter,
        restartRefused: () => { order.push('restartRefused') },
        ...overrides,
      })
      await service.check('manual')
      await service.download()
      return { order, service, updater }
    }

    it('is called off when the installer throws', async () => {
      const { order, service } = await stagedUpdate({}, () => { throw new Error('INSTALLER_MISSING') })

      expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })

      expect(order).toEqual(['installer', 'restartRefused'])
      expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0', problem: 'INSTALLER_MISSING' })
    })

    it('is called off once when an error event and a throw both refuse it', async () => {
      const { order, service } = await stagedUpdate({}, (send) => {
        send({ type: 'error', message: 'first' })
        throw new Error('second')
      })

      expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })

      expect(order).toEqual(['installer', 'restartRefused'])
    })

    it('is called off when the refusal arrives after the installer call has returned', async () => {
      const { order, service, updater } = await stagedUpdate()

      // On a Mac the call returns while Squirrel fetches the update, and its refusal can come after every window has closed.
      expect(service.install()).toEqual({ ok: true })
      expect(order).toEqual(['installer'])
      updater.emit({ type: 'error', message: 'No update available, can\'t quit and install' })

      expect(order).toEqual(['installer', 'restartRefused'])
      expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0', problem: 'No update available, can\'t quit and install' })
      // An error that arrives once nothing is under way is not a refusal.
      updater.emit({ type: 'error', message: 'unrelated' })
      expect(order).toEqual(['installer', 'restartRefused'])
    })

    it('is still recorded as refused when the hook that puts Sotto back fails', async () => {
      const failing = vi.fn(() => { throw new Error('hook failed') })
      const { order, service } = await stagedUpdate({ restartRefused: failing }, () => { throw new Error('INSTALLER_MISSING') })

      expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })

      expect(order).toEqual(['installer'])
      expect(failing).toHaveBeenCalledOnce()
      expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0', problem: 'INSTALLER_MISSING' })
    })

    it('starts the installer once while it is under way, and again after a refusal', async () => {
      const { order, service, updater } = await stagedUpdate()

      expect(service.install()).toEqual({ ok: true })
      // A second press while the installer is still fetching would make its second fetch fail, and that failure would
      // read as a refusal of the restart that is still going ahead.
      expect(service.install()).toEqual({ ok: true })
      expect(updater.calls.install).toBe(1)

      updater.emit({ type: 'error', message: 'The installer refused.' })
      expect(order).toEqual(['installer', 'restartRefused'])
      expect(service.install()).toEqual({ ok: true })
      expect(updater.calls.install).toBe(2)
    })

    it('says it is restarting from the hand-off until a refusal, and not otherwise', async () => {
      const { service, updater } = await stagedUpdate()
      expect(service.restarting()).toBe(false)

      expect(service.install()).toEqual({ ok: true })
      expect(service.restarting()).toBe(true)

      updater.emit({ type: 'error', message: 'The installer refused.' })
      expect(service.restarting()).toBe(false)
    })

    it('does not say it is restarting when the installer throws or the restart is held', async () => {
      const { service } = await stagedUpdate({}, () => { throw new Error('INSTALLER_MISSING') })
      expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
      expect(service.restarting()).toBe(false)

      const { service: held } = await stagedUpdate({ restartHold: () => 'A host update is under way.' })
      expect(held.install()).toEqual({ ok: false, reason: 'unavailable' })
      expect(held.restarting()).toBe(false)
    })
  })

  it('leaves a staged download alone when another check comes due', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await service.download()

    await service.check('automatic')
    await service.check('manual')

    expect(updater.calls.check).toBe(1)
    expect(service.status().phase).toEqual(downloaded)
  })

  it('does not start a check while a download is in flight', async () => {

    const { promise: gate, resolve: finish } = deferred<void>()
    const updater = createFakeUpdater({
      check: offersUpdate,
      download: async (send) => {
        await gate
        send({ type: 'downloaded', version: '3.5.0' })
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    const download = service.download()
    await expect(service.check('manual')).resolves.toMatchObject({ phase: { phase: 'downloading' } })
    expect(updater.calls.check).toBe(1)
    finish()
    await download
  })

  it('collapses concurrent checks into one request', async () => {

    const { promise: gate, resolve: release } = deferred<void>()
    const updater = createFakeUpdater({
      check: async (send) => {
        send({ type: 'checking' })
        await gate
        send({ type: 'not-available' })
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    const first = service.check('manual')
    const second = service.check('manual')
    release()

    await expect(first).resolves.toEqual(await second)
    expect(updater.calls.check).toBe(1)
  })

  it('stops answering once disposed', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const { service } = createService({ createUpdater: () => updater.adapter })

    service.dispose()

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      releaseTrack: 'stable',
      owlFeatures: STABLE_FEATURES,
      watcherEnabled: false,
      phase: { phase: 'idle' },
      checkedAt: null,
    })
    await expect(service.download()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    expect(updater.calls.check).toBe(0)
  })

  it('keeps a failing status listener from breaking the lifecycle', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const { service } = createService({
      createUpdater: () => updater.adapter,
      onStatusChanged: () => {
        throw new Error('RENDERER_GONE')
      },
    })

    await expect(service.check('manual')).resolves.toMatchObject({ phase: available })
  })
})

describe('describeProblem', () => {
  it('keeps the first readable line and cuts anything longer than a tooltip can hold', () => {
    expect(describeProblem(new Error('  \nHttpError: 404 Not Found\nheaders: {}'))).toBe('HttpError: 404 Not Found')
    expect(describeProblem('plain words')).toBe('plain words')
    expect(describeProblem(new Error('x'.repeat(300)))).toHaveLength(240)
    expect(describeProblem(new Error('x'.repeat(300)))?.endsWith('…')).toBe(true)
  })

  it('answers null for anything that is not a sentence', () => {
    expect(describeProblem(undefined)).toBeNull()
    expect(describeProblem(42)).toBeNull()
    expect(describeProblem(new Error('   '))).toBeNull()
    expect(describeProblem({})).toBeNull()
  })
})

describe('a new version of Sotto has every machine check its clients afresh (ADR-0077)', () => {
  it('hears each version once, when it is first offered, and not for its download or the checks after it', () => {
    const found = vi.fn()
    const hear = newVersionListener(found)
    hear({ phase: 'checking' })
    hear({ phase: 'up-to-date' })
    expect(found).not.toHaveBeenCalled()
    hear({ phase: 'available', version: '0.1.38', problem: null })
    for (const percent of [10, 40, 90]) hear({ phase: 'downloading', version: '0.1.38', percent })
    hear({ phase: 'downloaded', version: '0.1.38', problem: null })
    hear({ phase: 'checking' })
    hear({ phase: 'available', version: '0.1.38', problem: 'offline', failedStep: 'download' })
    expect(found.mock.calls).toEqual([['0.1.38']])
    // A newer release found later is new again.
    hear({ phase: 'available', version: '0.1.39', problem: null })
    expect(found.mock.calls).toEqual([['0.1.38'], ['0.1.39']])
  })

  it('hears a download already under way when Sotto starts as a version found', () => {
    const found = vi.fn()
    newVersionListener(found)({ phase: 'downloading', version: '0.1.40', percent: 5 })
    expect(found).toHaveBeenCalledWith('0.1.40')
  })
})

describe('the version a host may run before Sotto restarts (ADR-0077 decision 6)', () => {
  it('follows an offer, its download and the downloaded update, and keeps it through the next check', () => {
    expect(waitingVersion({ phase: 'available', version: '0.1.38', problem: null }, undefined)).toBe('0.1.38')
    expect(waitingVersion({ phase: 'downloading', version: '0.1.38', percent: 40 }, undefined)).toBe('0.1.38')
    expect(waitingVersion({ phase: 'downloaded', version: '0.1.38', problem: null }, undefined)).toBe('0.1.38')
    expect(waitingVersion({ phase: 'checking' }, '0.1.38')).toBe('0.1.38')
    for (const phase of [{ phase: 'up-to-date' }, { phase: 'idle' }, { phase: 'unsupported' }, { phase: 'failed', problem: 'offline' }] as const) {
      expect(waitingVersion(phase, '0.1.38'), phase.phase).toBeUndefined()
    }
  })

  it('does not restart while a host update holds it, and says why (Sotto Bug Bot, review)', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    let hold: string | undefined = 'Sotto did not restart while it was updating the host on forge. Nothing was lost. Restart again once that update has finished.'
    const { service } = createService({ createUpdater: () => updater.adapter, restartHold: () => hold })
    await service.check('manual')
    await service.download()
    expect(service.install()).toEqual({ ok: false, reason: 'unavailable' })
    expect(updater.calls.install).toBe(0)
    // The download stays, and its problem says what happened and what to do.
    expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0', problem: hold })
    hold = undefined
    expect(service.install()).toEqual({ ok: true })
    expect(updater.calls.install).toBe(1)
  })

  it('is offered by a development end-to-end run that never installs', async () => {
    const events: UpdaterEvent[] = []
    const updater = e2eUpdater('0.1.38-owl.20261014.2', 0)
    updater.subscribe(event => events.push(event))
    await updater.check()
    await updater.download()
    expect(events.map(event => event.type)).toEqual(['checking', 'available', 'progress', 'progress', 'progress', 'downloaded'])
    expect(() => updater.quitAndInstall()).toThrow('A test run does not install updates.')
  })

  it('closes every window for a development run\'s restart and only then refuses it, as a Mac\'s installer can', async () => {
    const order: string[] = []
    const closed = deferred<void>()
    const updater = e2eUpdater('0.1.38-owl.20261014.2', 0, () => { order.push('close windows'); return closed.promise })
    updater.subscribe(event => order.push(event.type))

    expect(() => updater.quitAndInstall()).not.toThrow()
    expect(order).toEqual(['close windows'])

    closed.resolve()
    await flush()
    expect(order).toEqual(['close windows', 'error'])
  })
})
