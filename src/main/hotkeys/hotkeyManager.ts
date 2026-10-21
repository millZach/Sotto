import type { HotkeyChangeResult } from '../../shared/contracts'
import type { WidgetSnapshot } from '../../shared/dictation'
import type { SottoPlatform } from '../../shared/platform'
import { chordTokenSet } from './dictationShortcutRouter'

const ESCAPE_ACCELERATOR = 'Escape'
const RETRY_MS = 5_000
const RETRY_LIMIT = 12

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered?(accelerator: string): boolean
}

export class HotkeyManager {
  private accelerator: string | null = null
  private listening = false
  private disposed = false
  private suspended = false
  // A restore after a suspension failed: the accelerator is kept for retries but not claimed by current().
  private dead = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly shortcuts: GlobalShortcutAdapter,
    private readonly onToggle: () => void,
    private readonly onCancel: () => void,
    private readonly platform: SottoPlatform = 'win32',
    private readonly log: (event: 'native-hotkey-registration-failed') => void = () => undefined,
  ) {}

  replace(candidate: string): HotkeyChangeResult {
    if (this.disposed) {
      return { ok: false, reason: 'unavailable' }
    }

    const next = candidate.trim()
    if (next.length === 0 || next.toLowerCase() === ESCAPE_ACCELERATOR.toLowerCase()) {
      return { ok: false, reason: 'invalid' }
    }
    // The saved setting is kept for reset/rollback; Linux listens through compositor bindings.
    if (this.platform === 'linux') {
      this.accelerator = next
      return { ok: true }
    }
    // A replace registers for real, so it ends any suspension and any restore retry.
    const wasLive = !this.suspended && !this.dead
    this.suspended = false
    this.dead = false
    clearTimeout(this.retryTimer)
    if (next === this.accelerator) {
      return wasLive && this.isRegistered(next)
        ? { ok: true }
        : this.registerWithoutPrior(next)
    }

    const previous = this.accelerator
    // The same chord in another spelling: the OS refuses it while the old spelling holds it, so release first.
    if (previous !== null && chordTokenSet(next, this.platform) === chordTokenSet(previous, this.platform)) {
      this.safeUnregister(previous)
      const respelled = this.registerWithoutPrior(next)
      if (!respelled.ok) this.ensurePriorRegistration(previous, false)
      return respelled
    }

    let candidateRegistered: boolean
    try {
      candidateRegistered = this.shortcuts.register(next, this.onToggle)
    } catch {
      this.ensurePriorRegistration(previous, wasLive)
      return { ok: false, reason: 'unavailable' }
    }

    if (!candidateRegistered) {
      this.ensurePriorRegistration(previous, wasLive)
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
      this.ensurePriorRegistration(previous, wasLive)
      return { ok: false, reason: 'unavailable' }
    }
  }

  current(): string | null {
    return this.dead ? null : this.accelerator
  }

  /** Stands the primary shortcut down while Settings records keys, without forgetting it. */
  suspend(on: boolean): void {
    if (this.disposed || this.platform === 'linux' || on === this.suspended) return
    this.suspended = on
    clearTimeout(this.retryTimer)
    const active = this.accelerator
    if (active === null) return
    if (on) {
      this.safeUnregister(active)
      return
    }
    this.restore(active, 0)
  }

  private restore(accelerator: string, attempt: number): void {
    let restored: boolean
    try {
      restored = this.shortcuts.register(accelerator, this.onToggle)
    } catch {
      restored = false
    }
    this.dead = !restored
    if (!restored) this.retryAfterFailure(accelerator, attempt)
  }

  private retryAfterFailure(accelerator: string, attempt: number): void {
    if (attempt === 0) this.log('native-hotkey-registration-failed')
    if (attempt < RETRY_LIMIT) this.retryTimer = setTimeout(() => this.restore(accelerator, attempt + 1), RETRY_MS)
  }

  beginListening(): boolean {
    if (this.platform === 'linux') return false
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
    clearTimeout(this.retryTimer)
    this.releaseEscape()

    const active = this.accelerator
    this.accelerator = null
    if (active !== null && this.platform !== 'linux') {
      this.safeUnregister(active)
    }
  }

  private registerWithoutPrior(accelerator: string): HotkeyChangeResult {
    try {
      if (this.shortcuts.register(accelerator, this.onToggle)) {
        this.accelerator = accelerator
        return { ok: true }
      }
      this.lose(accelerator)
      return { ok: false, reason: 'conflict' }
    } catch {
      this.lose(accelerator)
      return { ok: false, reason: 'unavailable' }
    }
  }

  // The kept primary could not be registered again: never forget it, retry instead.
  private lose(accelerator: string): void {
    if (this.accelerator !== accelerator) return
    this.dead = true
    this.retryAfterFailure(accelerator, 0)
  }

  /** `live`: whether `previous` was registered before this replace, for adapters without isRegistered. */
  private ensurePriorRegistration(previous: string | null, live: boolean): void {
    if (previous === null || this.isRegistered(previous, live)) return
    this.restore(previous, 0)
  }

  private isRegistered(accelerator: string, fallback = true): boolean {
    return this.shortcuts.isRegistered?.(accelerator) ?? fallback
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
