import { sameChord } from '../../shared/dictationShortcuts'
import { popupShortcutRefusal, type PopupShortcutResult, type PopupShortcutState } from '../../shared/popup'
import type { SottoPlatform } from '../../shared/platform'
import type { AppSettings } from '../../shared/settings'
import type { GlobalShortcutAdapter } from '../hotkeys/hotkeyManager'

export type PopupShortcutKeys = Pick<AppSettings, 'popupShortcut' | 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>

/**
 * The popup's global shortcut (ADR-0181): registered while the Owl feature is on, following the saved setting, and
 * never on keys a dictation shortcut holds. A change from Settings registers the new keys before they are saved, so a
 * chord another app holds is refused and the old one keeps working; a change that arrives as a saved setting (Reset
 * all, another window) is followed as it is, and the state says when it could not be taken.
 */
export class PopupShortcut {
  private registered: string | null = null
  private keys: PopupShortcutKeys | null = null
  private current: PopupShortcutState = { status: 'off', chord: null }
  private suspended = false
  private disposed = false

  constructor(
    private readonly shortcuts: GlobalShortcutAdapter,
    private readonly onPress: () => void,
    private readonly platform: SottoPlatform,
    private readonly onState: (state: PopupShortcutState) => void = () => undefined,
  ) {}

  state(): PopupShortcutState {
    return this.current
  }

  /** Follows the saved keys: at start and after every settings change. Unchanged keys that are registered stay as they are. */
  apply(keys: PopupShortcutKeys): void {
    if (this.disposed) return
    this.keys = keys
    if (this.suspended) return
    const chord = keys.popupShortcut
    if (chord === null) {
      this.release()
      this.publish({ status: 'off', chord: null })
      return
    }
    const refusal = popupShortcutRefusal(chord, keys, this.platform)
    if (refusal === 'dictation-press' || refusal === 'dictation-hold') {
      this.release()
      this.publish({ status: 'dictation', chord })
      return
    }
    if (this.registered === chord) {
      this.publish({ status: 'on', chord })
      return
    }
    this.release()
    this.publish({ status: this.register(chord) ? 'on' : 'taken', chord })
  }

  /** Settings' change: the new keys are registered first, and a refusal leaves the shortcut as it was. */
  replace(chord: string | null, keys: Omit<PopupShortcutKeys, 'popupShortcut'>): PopupShortcutResult {
    if (this.disposed) return { ok: false, reason: 'unavailable' }
    this.suspended = false
    if (chord === null) {
      this.release()
      this.keys = { ...keys, popupShortcut: null }
      this.publish({ status: 'off', chord: null })
      return { ok: true }
    }
    const refusal = popupShortcutRefusal(chord, keys, this.platform)
    if (refusal === 'dictation-press' || refusal === 'dictation-hold') return this.resume({ ok: false, reason: 'dictation' })
    if (refusal !== null) return this.resume({ ok: false, reason: 'invalid' })
    const previous = this.registered
    if (previous === chord) return this.resume({ ok: true })
    // The same keys in another spelling: the system refuses them while the old spelling holds them, so let go first. They
    // are one shortcut to the system, so letting go of the old spelling afterwards would let go of the new one too.
    const respelled = previous !== null && sameChord(previous, chord, this.platform)
    if (respelled) this.release()
    if (!this.register(chord)) {
      if (this.registered === null && previous !== null) this.register(previous)
      return this.resume({ ok: false, reason: 'taken' })
    }
    if (previous !== null && !respelled) this.unregister(previous)
    this.keys = { ...keys, popupShortcut: chord }
    this.publish({ status: 'on', chord })
    return { ok: true }
  }

  /**
   * Lets go of the keys while dictation tries to take them, so a dictation shortcut recorded on the popup's keys is
   * registered by dictation and the popup then leaves them to it; `takeBack` takes them back when dictation did not.
   */
  yieldTo(chords: readonly string[]): void {
    const held = this.registered
    if (held !== null && chords.some(chord => sameChord(chord, held, this.platform))) this.release()
  }

  takeBack(): void {
    if (!this.disposed && !this.suspended && this.keys !== null) this.apply(this.keys)
  }

  /** Stands the shortcut aside while Settings records keys, so pressing it is recorded rather than run. */
  suspend(on: boolean): void {
    if (this.disposed || on === this.suspended) return
    this.suspended = on
    if (on) {
      this.release()
      return
    }
    if (this.keys !== null) this.apply(this.keys)
  }

  dispose(): void {
    if (this.disposed) return
    this.release()
    this.disposed = true
  }

  /** A refused change gives back what a recording stood aside, as it was. */
  private resume(result: PopupShortcutResult): PopupShortcutResult {
    if (this.registered === null && this.keys !== null) this.apply(this.keys)
    return result
  }

  private register(chord: string): boolean {
    let ok: boolean
    try { ok = this.shortcuts.register(chord, this.onPress) } catch { ok = false }
    if (ok) this.registered = chord
    return ok
  }

  private release(): void {
    const chord = this.registered
    this.registered = null
    if (chord !== null) this.unregister(chord)
  }

  private unregister(chord: string): void {
    try { this.shortcuts.unregister(chord) } catch { /* Already gone: nothing holds it. */ }
  }

  private publish(state: PopupShortcutState): void {
    if (state.status === this.current.status && state.chord === this.current.chord) return
    this.current = state
    this.onState(state)
  }
}
