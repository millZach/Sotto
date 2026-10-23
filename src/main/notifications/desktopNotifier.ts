import { PROVIDER_LABELS } from '../../shared/agents'
import {
  ALERT_REFERENCES_MAX, ALERT_TITLE_MAX, type NotificationTestResult, type ThreadAlert,
} from '../../shared/desktopNotifications'

/** The part of Electron's `Notification` the notifier uses, so tests pass a fake. */
export interface NotificationLike {
  show(): void
  on(event: 'show' | 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): unknown
}

export interface DesktopNotifierOptions {
  readonly create: (options: { id: string; groupId: string; title: string; body: string }) => NotificationLike
  readonly isSupported: () => boolean
  readonly switches: () => Promise<{ readonly needsYou: boolean; readonly finished: boolean }>
  readonly open: (threadId: string) => void
  readonly log: (event: 'desktop-notification-failed') => void
  readonly timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
}

export interface DesktopNotifier {
  notify(alert: ThreadAlert): Promise<void>
  test(): Promise<NotificationTestResult>
  dispose(): void
}

/** How long a test waits for `show` before it counts as shown: macOS may be asking the user to allow notifications. */
const TEST_WAIT_MS = 5_000
const defaultTimers = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The notification's title: the thread's title on one line, at most `ALERT_TITLE_MAX` characters (ADR-0114). */
export function alertTitle(title: string): string {
  const characters = [...title.replace(/\s+/g, ' ').trim()]
  if (characters.length === 0) return 'A thread'
  return characters.length <= ALERT_TITLE_MAX ? characters.join('') : `${characters.slice(0, ALERT_TITLE_MAX - 1).join('').trimEnd()}…`
}

/** One plain sentence, as the iPhone's alert says it; never a question's, a reply's or a path's words (ADR-0114). */
export function alertBody(alert: ThreadAlert): string {
  const agent = alert.providerId ? PROVIDER_LABELS[alert.providerId] : 'The agent'
  const what = alert.kind === 'finished' ? 'finished'
    : alert.request === 'permission' ? 'is asking for permission' : 'is asking a question'
  return `${agent} ${what}${alert.computer ? ` on ${alert.computer}` : ''}.`
}

/**
 * Shows thread alerts as system notifications (ADR-0114). A notification only names the thread and opens it when
 * pressed; it never answers or approves anything (ADR-0004), so it has no actions and no reply, and the OS picks the sound.
 */
export function createDesktopNotifier(options: DesktopNotifierOptions): DesktopNotifier {
  const timers = options.timers ?? defaultTimers
  // Electron drops a notification's events once it is garbage collected, so keep it until it is done with.
  const references = new Set<NotificationLike>()
  const pendingTests = new Map<unknown, () => void>()
  let disposed = false
  let loggedFailure = false
  let tests = 0

  const keep = (notification: NotificationLike) => {
    references.add(notification)
    if (references.size > ALERT_REFERENCES_MAX) references.delete(references.values().next().value as NotificationLike)
  }
  const release = (notification: NotificationLike) => { references.delete(notification) }
  const failed = () => {
    if (loggedFailure) return
    loggedFailure = true
    try { options.log('desktop-notification-failed') } catch { /* a failure is quiet */ }
  }

  return {
    async notify(alert) {
      // Never rejects: a notification that cannot be made is no one's error to handle (ADR-0114).
      try {
        if (disposed || !options.isSupported()) return
        let switches: Awaited<ReturnType<DesktopNotifierOptions['switches']>>
        try { switches = await options.switches() } catch { return }
        if (disposed || !(alert.kind === 'finished' ? switches.finished : switches.needsYou)) return
        const notification = options.create({ id: alert.id, groupId: alert.threadId, title: alertTitle(alert.title), body: alertBody(alert) })
        keep(notification)
        notification.on('close', () => release(notification))
        notification.on('click', () => {
          release(notification)
          if (disposed) return
          try { options.open(alert.threadId) } catch { /* opening is best effort */ }
        })
        notification.on('failed', () => { release(notification); failed() })
        try { notification.show() } catch { release(notification); failed() }
      } catch { failed() }
    },
    test() {
      let supported = false
      try { supported = options.isSupported() } catch { /* a system that cannot say cannot show one */ }
      if (disposed || !supported) return Promise.resolve('unsupported')
      return new Promise<NotificationTestResult>(resolve => {
        let notification: NotificationLike | undefined
        let settled = false
        const settle = (result: NotificationTestResult) => {
          if (settled) return
          settled = true
          timers.clear(timer)
          pendingTests.delete(timer)
          if (notification) release(notification)
          resolve(result)
        }
        const timer = timers.set(() => settle('shown'), TEST_WAIT_MS)
        pendingTests.set(timer, () => settle('unsupported'))
        try {
          tests += 1
          notification = options.create({ id: `test/${tests}`, groupId: 'test', title: 'Sotto', body: 'Notifications are on.' })
          keep(notification)
          notification.on('show', () => settle('shown'))
          notification.on('failed', () => settle('failed'))
          notification.show()
        } catch { settle('failed') }
      })
    },
    dispose() {
      disposed = true
      for (const settle of [...pendingTests.values()]) settle()
      references.clear()
    },
  }
}
