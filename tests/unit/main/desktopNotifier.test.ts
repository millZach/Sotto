// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopNotifier, type DesktopNotifierOptions, type NotificationLike } from '../../../src/main/notifications/desktopNotifier'
import { ALERT_REFERENCES_MAX, type ThreadAlert } from '../../../src/shared/desktopNotifications'

type Event = 'show' | 'click' | 'close' | 'failed'

class FakeNotification implements NotificationLike {
  readonly listeners = new Map<Event, Array<() => void>>()
  constructor(readonly options: Record<string, unknown>, private readonly throwOnShow = false) {}
  show() { if (this.throwOnShow) throw new Error('show failed') }
  on(event: Event, listener: () => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]) }
  fire(event: Event) { for (const listener of this.listeners.get(event) ?? []) listener() }
}

function setup(overrides: Partial<DesktopNotifierOptions> & { throwOnShow?: boolean } = {}) {
  const created: FakeNotification[] = []
  const switches = { needsYou: true, finished: true }
  const options = {
    create: vi.fn((o: Record<string, unknown>) => { const n = new FakeNotification(o, overrides.throwOnShow); created.push(n); return n }),
    isSupported: vi.fn(() => true),
    switches: vi.fn(() => Promise.resolve({ ...switches })),
    open: vi.fn(),
    log: vi.fn(),
    ...overrides,
  }
  return { notifier: createDesktopNotifier(options), created, switches, options }
}

const alert = (patch: Partial<ThreadAlert> = {}): ThreadAlert => ({
  kind: 'finished', threadId: 'local:t1', title: 'Fix the build', providerId: 'codex', id: 'local:t1/finished/1', ...patch,
})

/** The alert without a provider, as from a thread whose provider is unknown. */
const anonymous = (patch: Partial<ThreadAlert> = {}): ThreadAlert => {
  const { providerId, ...rest } = alert(patch)
  void providerId
  return rest
}

afterEach(() => { vi.useRealTimers() })

describe('desktop notifier words', () => {
  it.each([
    [alert(), 'Codex finished.'],
    [alert({ computer: 'Forge' }), 'Codex finished on Forge.'],
    [anonymous(), 'The agent finished.'],
    [alert({ kind: 'needs-you', request: 'question', providerId: 'claude' }), 'Claude Code is asking a question.'],
    [alert({ kind: 'needs-you', request: 'question', computer: 'Forge' }), 'Codex is asking a question on Forge.'],
    [alert({ kind: 'needs-you', request: 'permission' }), 'Codex is asking for permission.'],
    [anonymous({ kind: 'needs-you', request: 'permission', computer: 'Forge' }), 'The agent is asking for permission on Forge.'],
  ])('says one plain sentence', async (input, body) => {
    const { notifier, created } = setup()
    await notifier.notify(input)
    expect(created[0]!.options).toEqual({ id: input.id, groupId: 'local:t1', title: 'Fix the build', body })
    expect(Object.keys(created[0]!.options).sort()).toEqual(['body', 'groupId', 'id', 'title'])
  })

  it('collapses, cuts and falls back the title', async () => {
    const { notifier, created } = setup()
    await notifier.notify(alert({ title: '  Fix\n\nthe   build\t ' }))
    await notifier.notify(alert({ title: 'x'.repeat(100) }))
    await notifier.notify(alert({ title: 'x'.repeat(80) }))
    await notifier.notify(alert({ title: ' \n ' }))
    expect(created.map(n => n.options.title)).toEqual(['Fix the build', `${'x'.repeat(79)}…`, 'x'.repeat(80), 'A thread'])
  })
})

describe('desktop notifier', () => {
  it('reads the switches at each alert', async () => {
    const { notifier, created, switches } = setup()
    switches.finished = false
    await notifier.notify(alert())
    expect(created).toHaveLength(0)
    await notifier.notify(alert({ kind: 'needs-you', request: 'question' }))
    expect(created).toHaveLength(1)
    switches.finished = true
    switches.needsYou = false
    await notifier.notify(alert({ kind: 'needs-you', request: 'question' }))
    await notifier.notify(alert())
    expect(created.map(n => n.options.body)).toEqual(['Codex is asking a question.', 'Codex finished.'])
  })

  it('creates nothing when unsupported or when the switches cannot be read', async () => {
    const unsupported = setup({ isSupported: () => false })
    await unsupported.notifier.notify(alert())
    expect(unsupported.created).toHaveLength(0)
    const unreadable = setup({ switches: () => Promise.reject(new Error('no settings')) })
    await expect(unreadable.notifier.notify(alert())).resolves.toBeUndefined()
    expect(unreadable.created).toHaveLength(0)
  })

  it('opens the thread once when pressed and swallows an open that throws', async () => {
    const { notifier, created, options } = setup({ open: vi.fn(() => { throw new Error('no window') }) })
    const threadId = 'host:11111111-1111-4111-8111-111111111111:thread-with-a-question'
    await notifier.notify(alert({ threadId }))
    expect(() => created[0]!.fire('click')).not.toThrow()
    expect(options.open).toHaveBeenCalledTimes(1)
    expect(options.open).toHaveBeenCalledWith(threadId)
  })

  it('logs a failure once per run, and a show that throws is a failure', async () => {
    const { notifier, created, options } = setup()
    await notifier.notify(alert())
    await notifier.notify(alert())
    created[0]!.fire('failed')
    created[1]!.fire('failed')
    expect(options.log).toHaveBeenCalledTimes(1)
    expect(options.log).toHaveBeenCalledWith('desktop-notification-failed')

    const throwing = setup({ throwOnShow: true, log: vi.fn(() => { throw new Error('log down') }) })
    await expect(throwing.notifier.notify(alert())).resolves.toBeUndefined()
    await throwing.notifier.notify(alert())
    expect(throwing.options.log).toHaveBeenCalledTimes(1)
  })

  it('keeps a reference until a notification is done with, dropping the oldest past the cap', async () => {
    // The set itself is private, so the test follows it through Set's own add and delete.
    const kept = new Set<unknown>()
    const add = vi.spyOn(Set.prototype, 'add')
    const remove = vi.spyOn(Set.prototype, 'delete')
    const follow = () => {
      kept.clear()
      const calls = [...add.mock.calls.map((c, i) => ({ order: add.mock.invocationCallOrder[i]!, add: true, value: c[0] })),
        ...remove.mock.calls.map((c, i) => ({ order: remove.mock.invocationCallOrder[i]!, add: false, value: c[0] }))]
      for (const call of calls.sort((a, b) => a.order - b.order)) {
        if (!(call.value instanceof FakeNotification)) continue
        if (call.add) kept.add(call.value)
        else kept.delete(call.value)
      }
      return kept
    }
    try {
      const { notifier, created } = setup()
      for (let index = 0; index < 4; index += 1) await notifier.notify(alert({ id: `a/${index}` }))
      created[0]!.fire('close')
      created[1]!.fire('click')
      created[2]!.fire('failed')
      expect([...follow()]).toEqual([created[3]])
      for (let index = 4; index < ALERT_REFERENCES_MAX + 6; index += 1) await notifier.notify(alert({ id: `a/${index}` }))
      const held = [...follow()]
      expect(held).toHaveLength(ALERT_REFERENCES_MAX)
      expect(held[0]).toBe(created[6])
      expect(held.at(-1)).toBe(created.at(-1))
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})

describe('desktop notifier test', () => {
  const timers = () => {
    const pending = new Map<number, () => void>()
    let next = 0
    return {
      pending,
      set: (fn: () => void, ms: number) => { expect(ms).toBe(5_000); next += 1; pending.set(next, fn); return next },
      clear: (handle: unknown) => { pending.delete(handle as number) },
      fire: () => { for (const [handle, fn] of [...pending]) { pending.delete(handle); fn() } },
    }
  }

  it('resolves shown on show, and numbers each test', async () => {
    const clock = timers()
    const { notifier, created } = setup({ timers: clock })
    const first = notifier.test()
    created[0]!.fire('show')
    created[0]!.fire('failed')
    await expect(first).resolves.toBe('shown')
    expect(clock.pending.size).toBe(0)
    const second = notifier.test()
    created[1]!.fire('show')
    await second
    expect(created.map(n => n.options)).toEqual([
      { id: 'test/1', groupId: 'test', title: 'Sotto', body: 'Notifications are on.' },
      { id: 'test/2', groupId: 'test', title: 'Sotto', body: 'Notifications are on.' },
    ])
  })

  it('resolves shown after 5 seconds with neither event', async () => {
    vi.useFakeTimers()
    const { notifier, created } = setup()
    const result = notifier.test()
    vi.advanceTimersByTime(4_999)
    let settled = false
    void result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(result).resolves.toBe('shown')
    created[0]!.fire('failed')
    await expect(result).resolves.toBe('shown')
  })

  it('resolves failed only on failed or a show that throws', async () => {
    const clock = timers()
    const { notifier, created, options } = setup({ timers: clock })
    const result = notifier.test()
    created[0]!.fire('failed')
    created[0]!.fire('show')
    clock.fire()
    await expect(result).resolves.toBe('failed')
    expect(clock.pending.size).toBe(0)
    expect(options.log).not.toHaveBeenCalled()
    const throwing = setup({ throwOnShow: true, timers: timers() })
    await expect(throwing.notifier.test()).resolves.toBe('failed')
  })

  it('is unsupported when the system cannot show notifications', async () => {
    const { notifier, created } = setup({ isSupported: () => false })
    await expect(notifier.test()).resolves.toBe('unsupported')
    expect(created).toHaveLength(0)
  })
})

describe('desktop notifier dispose', () => {
  it('clears pending tests and makes later calls quiet', async () => {
    const pending = new Set<unknown>()
    const { notifier, created } = setup({
      timers: { set: () => { const handle = {}; pending.add(handle); return handle }, clear: handle => { pending.delete(handle) } },
    })
    const waiting = notifier.test()
    notifier.dispose()
    expect(pending.size).toBe(0)
    await expect(waiting).resolves.toBe('unsupported')
    await expect(notifier.test()).resolves.toBe('unsupported')
    await expect(notifier.notify(alert())).resolves.toBeUndefined()
    expect(created).toHaveLength(1)
  })

  it('drops an alert whose switches arrive after dispose', async () => {
    let answer: (value: { needsYou: boolean; finished: boolean }) => void = () => {}
    const { notifier, created } = setup({ switches: () => new Promise(resolve => { answer = resolve }) })
    const notified = notifier.notify(alert())
    notifier.dispose()
    answer({ needsYou: true, finished: true })
    await notified
    expect(created).toHaveLength(0)
  })

  it('never rejects and never opens a thread once disposed, whatever the system does', async () => {
    const broken = setup({ isSupported: vi.fn(() => { throw new Error('no answer') }) })
    await expect(broken.notifier.notify(alert())).resolves.toBeUndefined()
    await expect(broken.notifier.test()).resolves.toBe('unsupported')
    expect(broken.options.log).toHaveBeenCalledTimes(1)
    expect(broken.created).toHaveLength(0)

    const { notifier, created, options } = setup()
    await notifier.notify(alert())
    notifier.dispose()
    created[0]!.fire('click')
    expect(options.open).not.toHaveBeenCalled()
  })
})
