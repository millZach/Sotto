import { describe, expect, it, vi } from 'vitest'

import {
  UPDATE_CHECK_INTERVAL_MS,
  UpdateService,
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
    quitAndInstall?: () => void
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
        overrides.quitAndInstall?.()
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
    ...overrides,
  })
  return { service, statuses }
}

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
      phase: { phase: 'available', version: '3.5.0' },
    })
    await expect(service.download()).resolves.toEqual({ ok: true })

    expect(statuses.map((status) => status.phase)).toEqual([
      { phase: 'checking' },
      { phase: 'available', version: '3.5.0' },
      { phase: 'downloading', version: '3.5.0', percent: 0 },
      { phase: 'downloading', version: '3.5.0', percent: 12 },
      { phase: 'downloading', version: '3.5.0', percent: 100 },
      { phase: 'downloaded', version: '3.5.0' },
    ])
    expect(service.status().currentVersion).toBe('3.4.0')
  })

  it('reports being current when the feed offers nothing newer', async () => {
    const updater = createFakeUpdater()
    const { service } = createService({ createUpdater: () => updater.adapter })

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      phase: { phase: 'up-to-date' },
    })
  })

  it('never contacts the feed automatically while the setting is off', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    const { service, statuses } = createService(
      { createUpdater: () => updater.adapter },
      { autoUpdateCheck: false },
    )

    service.start()
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
    expect(service.status().phase).toEqual({ phase: 'available', version: '3.5.0' })
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

  it('skips an automatic check inside the interval and allows one after it', async () => {
    const updater = createFakeUpdater()
    let clock = 1_000
    const { service } = createService({
      createUpdater: () => updater.adapter,
      now: () => clock,
    })

    await service.check('automatic')
    await service.check('automatic')
    expect(updater.calls.check).toBe(1)

    clock += UPDATE_CHECK_INTERVAL_MS - 1
    await service.check('automatic')
    expect(updater.calls.check).toBe(1)

    clock += 1
    await service.check('automatic')
    expect(updater.calls.check).toBe(2)
  })

  it('checks once on start and once per scheduled interval', async () => {
    const updater = createFakeUpdater()
    // A property, not a `let`: TypeScript would otherwise keep narrowing the
    // binding to `null` because the assignment happens inside a callback.
    const scheduled: { tick: (() => void) | null } = { tick: null }
    const cancel = vi.fn()
    let clock = 0
    const { service } = createService({
      createUpdater: () => updater.adapter,
      now: () => clock,
      scheduleInterval: (callback, intervalMs) => {
        expect(intervalMs).toBe(UPDATE_CHECK_INTERVAL_MS)
        scheduled.tick = callback
        return cancel
      },
    })

    service.start()
    await flush()
    expect(updater.calls.check).toBe(1)

    clock += UPDATE_CHECK_INTERVAL_MS
    scheduled.tick?.()
    await flush()
    expect(updater.calls.check).toBe(2)

    service.dispose()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('answers unsupported and builds no updater when the build has no feed', async () => {
    const { service, statuses } = createService()

    service.start()
    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      phase: { phase: 'unsupported' },
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
    })
  })

  it('turns an unreachable feed into a quiet failed phase', async () => {
    const updater = createFakeUpdater({
      check: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      phase: { phase: 'failed' },
    })
  })

  it('turns a reported error during a check into the same failed phase', async () => {
    const updater = createFakeUpdater({
      check: async (send) => {
        send({ type: 'checking' })
        send({ type: 'error' })
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      phase: { phase: 'failed' },
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

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      phase: { phase: 'up-to-date' },
    })
  })

  it('keeps the offer alive when a download fails', async () => {
    const updater = createFakeUpdater({
      check: offersUpdate,
      download: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const { service } = createService({ createUpdater: () => updater.adapter })

    await service.check('manual')
    await expect(service.download()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(service.status().phase).toEqual({ phase: 'available', version: '3.5.0' })
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
  })

  it('reports an installer that refuses to start rather than throwing', async () => {
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
  })

  it('leaves a staged download alone when another check comes due', async () => {
    const updater = createFakeUpdater({ check: offersUpdate })
    let clock = 0
    const { service } = createService({ createUpdater: () => updater.adapter, now: () => clock })

    await service.check('manual')
    await service.download()
    clock += UPDATE_CHECK_INTERVAL_MS * 4

    await service.check('automatic')
    await service.check('manual')

    expect(updater.calls.check).toBe(1)
    expect(service.status().phase).toEqual({ phase: 'downloaded', version: '3.5.0' })
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

    await expect(service.check('manual')).resolves.toEqual({
      currentVersion: '3.4.0',
      phase: { phase: 'available', version: '3.5.0' },
    })
  })
})
