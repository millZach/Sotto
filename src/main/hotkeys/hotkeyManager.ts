import type { HotkeyChangeResult } from '../../shared/contracts'
import type { WidgetSnapshot } from '../../shared/dictation'

const ESCAPE_ACCELERATOR = 'Escape'

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered?(accelerator: string): boolean
}

export class HotkeyManager {
  private accelerator: string | null = null
  private listening = false
  private disposed = false

  constructor(
    private readonly shortcuts: GlobalShortcutAdapter,
    private readonly onToggle: () => void,
    private readonly onCancel: () => void,
  ) {}

  replace(candidate: string): HotkeyChangeResult {
    if (this.disposed) {
      return { ok: false, reason: 'unavailable' }
    }

    const next = candidate.trim()
    if (next.length === 0 || next.toLowerCase() === ESCAPE_ACCELERATOR.toLowerCase()) {
      return { ok: false, reason: 'invalid' }
    }
    if (next === this.accelerator) {
      return this.isRegistered(next)
        ? { ok: true }
        : this.registerWithoutPrior(next)
    }

    const previous = this.accelerator
    let candidateRegistered: boolean
    try {
      candidateRegistered = this.shortcuts.register(next, this.onToggle)
    } catch {
      return { ok: false, reason: 'unavailable' }
    }

    if (!candidateRegistered) {
      this.ensurePriorRegistration(previous)
      return { ok: false, reason: 'conflict' }
    }

    try {
      if (previous !== null) {
        this.shortcuts.unregister(previous)
      }
      this.accelerator = next
      return { ok: true }
    } catch {
      this.safeUnregister(next)
      this.accelerator = previous
      this.ensurePriorRegistration(previous)
      return { ok: false, reason: 'unavailable' }
    }
  }

  current(): string | null {
    return this.accelerator
  }

  beginListening(): boolean {
    if (this.disposed || this.listening) {
      return this.listening
    }

    try {
      this.listening = this.shortcuts.register(ESCAPE_ACCELERATOR, this.onCancel)
    } catch {
      this.listening = false
    }
    return this.listening
  }

  stopListening(): void {
    this.releaseEscape()
  }

  cancelListening(): void {
    this.releaseEscape()
  }

  failListening(): void {
    this.releaseEscape()
  }

  isListening(): boolean {
    return this.listening
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.releaseEscape()

    const active = this.accelerator
    this.accelerator = null
    if (active !== null) {
      this.safeUnregister(active)
    }
  }

  private registerWithoutPrior(accelerator: string): HotkeyChangeResult {
    try {
      if (!this.shortcuts.register(accelerator, this.onToggle)) {
        return { ok: false, reason: 'conflict' }
      }
      this.accelerator = accelerator
      return { ok: true }
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  }

  private ensurePriorRegistration(previous: string | null): void {
    if (previous === null || this.isRegistered(previous)) {
      return
    }
    try {
      if (!this.shortcuts.register(previous, this.onToggle)) {
        this.accelerator = null
      }
    } catch {
      this.accelerator = null
    }
  }

  private isRegistered(accelerator: string): boolean {
    return this.shortcuts.isRegistered?.(accelerator) ?? true
  }

  private releaseEscape(): void {
    if (!this.listening) {
      return
    }
    this.listening = false
    this.safeUnregister(ESCAPE_ACCELERATOR)
  }

  private safeUnregister(accelerator: string): void {
    try {
      this.shortcuts.unregister(accelerator)
    } catch {
      // Native cleanup is best-effort; internal state is released first.
    }
  }
}

export function syncEscapeForWidgetSnapshot(
  hotkeys: HotkeyManager,
  snapshot: Pick<WidgetSnapshot, 'status' | 'cancellable'>,
): void {
  if (snapshot.cancellable) {
    hotkeys.beginListening()
    return
  }
  if (snapshot.status === 'cancelled') {
    hotkeys.cancelListening()
  } else if (snapshot.status === 'error') {
    hotkeys.failListening()
  } else {
    hotkeys.stopListening()
  }
}
