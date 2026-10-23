import type { GlobalShortcutAdapter } from './hotkeyManager'
import type { KeyListener } from './keyListener'

/**
 * Dictation turned off (ADR-0107) holds every dictation shortcut back from the OS and stops the key listener's helper.
 * The hotkey manager and the shortcut router never notice: they keep what they registered and watch, so turning
 * dictation on hands it all back without a restart.
 */
export interface DictationGate {
  readonly shortcuts: GlobalShortcutAdapter
  listener(inner: KeyListener): KeyListener
  /** Turns dictation on or off; returns the accelerators the OS refused when turning on, which are let go. */
  set(on: boolean): string[]
}

export function createDictationGate(inner: GlobalShortcutAdapter, initiallyOn: boolean): DictationGate {
  let on = initiallyOn
  // What the manager and the router hold, whether the OS has it now (on) or not (off).
  const held = new Map<string, () => void>()
  const rewatch: Array<() => void> = []

  const shortcuts: GlobalShortcutAdapter = {
    register(accelerator, callback) {
      if (on && !inner.register(accelerator, callback)) return false
      held.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      held.delete(accelerator)
      if (on) inner.unregister(accelerator)
    },
    isRegistered(accelerator) {
      return on ? inner.isRegistered?.(accelerator) ?? held.has(accelerator) : held.has(accelerator)
    },
  }

  return {
    shortcuts,
    listener(listener) {
      let tokens: readonly string[] = []
      rewatch.push(() => listener.watch(on ? tokens : []))
      return {
        ...listener,
        watch(next) {
          tokens = next
          listener.watch(on ? next : [])
        },
        // Settings hides the shortcut rows while off; a recording asked for then starts no helper.
        record(recording) { listener.record(on && recording) },
      }
    },
    set(next) {
      if (next === on) return []
      on = next
      const refused: string[] = []
      for (const [accelerator, callback] of [...held]) {
        try {
          if (!on) inner.unregister(accelerator)
          else if (!inner.register(accelerator, callback)) refused.push(accelerator)
        } catch {
          if (on) refused.push(accelerator)
        }
      }
      for (const accelerator of refused) held.delete(accelerator)
      for (const watch of rewatch) watch()
      return refused
    },
  }
}
