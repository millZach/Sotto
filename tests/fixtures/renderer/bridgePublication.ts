import { vi } from 'vitest'

/** Event streams do not implicitly change command replies; cases script those separately. */
export function bridgePublication<Event>() {
  const listeners = new Set<(event: Event) => void>()
  const subscribe = vi.fn((listener: (event: Event) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  return { listeners, subscribe, publish: (event: Event) => { for (const listener of [...listeners]) listener(event) },
    dispose: () => { listeners.clear() } }
}

export function publishedState<State extends object>(initial: State) {
  let current = structuredClone(initial)
  const events = bridgePublication<State>()
  return { ...events, state: () => current,
    set: (next: State) => { current = next; return current },
    publish: (patch: Partial<State>) => { current = { ...current, ...patch }; events.publish(current) },
  }
}
