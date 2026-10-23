import type { NotificationLike } from '../notifications/desktopNotifier'

type Listener = (...args: unknown[]) => void
interface ShownNotification {
  readonly options: { readonly id: string; readonly groupId: string; readonly title: string; readonly body: string }
  /** What the user's press on it does. */
  press(): void
}

/**
 * The notification an end-to-end run shows instead of the system's (ADR-0112): nothing reaches the operating system, so
 * no test run pops a banner or asks macOS for permission. Each one shown is kept on `globalThis.sottoNotifications`, for a
 * spec to read with `app.evaluate` and to press.
 */
export function fakeNotification(options: ShownNotification['options']): NotificationLike {
  const listeners = new Map<string, Listener[]>()
  const emit = (event: string): void => { for (const listener of listeners.get(event) ?? []) listener() }
  return {
    show: () => {
      const seen = globalThis as { sottoNotifications?: ShownNotification[] }
      ;(seen.sottoNotifications ??= []).push({ options, press: () => emit('click') })
      setTimeout(() => emit('show'), 0)
    },
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return undefined },
  }
}
