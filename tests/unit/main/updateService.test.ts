import { describe, expect, it, vi } from 'vitest'

import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  UpdateService,
  describeProblem,
  type UpdaterAdapter,
  type UpdaterEvent,
  type UpdateServiceDependencies,
} from '../../../src/main/updates/updateService'
import type { UpdateStatus } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

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
    expect(service.status().phase).toEqual({ phase: 'available', version: '3.5.0', problem: 'ECONNRESET' })

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
    expect(service.status().phase).toEqual({ phase: 'available', version: '3.5.0', problem: 'sha512 checksum mismatch' })
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

  it('keeps a failed download and its reason across the automatic poll, until the user acts', async () => {
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
    expect(updater.calls.check).toBe(1)
    expect(service.status().phase).toEqual({ phase: 'available', version: '3.5.0', problem: 'ECONNRESET' })

    // A manual check is the user asking afresh, and it refreshes the offer.
    await service.check('manual')
    expect(updater.calls.check).toBe(2)
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
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
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
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
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
