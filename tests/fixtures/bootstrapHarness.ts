// @vitest-environment node
import { vi } from 'vitest'
import {
  type BootstrapApplication,
  type RuntimeController
} from '../../src/main/app/bootstrap'

export function createApp(ready: Promise<void>): BootstrapApplication & {
  emit(event: 'second-instance' | 'activate' | 'before-quit'): void
  quit: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, Set<() => void>>()
  const quit = vi.fn()
  return {
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => ready),
    on: vi.fn((event, listener) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    removeListener: vi.fn((event, listener) => listeners.get(event)?.delete(listener)),
    quit,
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    },
  }
}

export function createRuntime(start: () => Promise<void> = async () => undefined) {
  return {
    start: vi.fn<() => Promise<void>>(start),
    showMain: vi.fn<() => void>(),
    showFromActivation: vi.fn<() => void>(),
    beginQuit: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
  } satisfies RuntimeController
}

export function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}
