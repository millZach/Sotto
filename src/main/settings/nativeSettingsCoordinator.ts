import type {
  DictationShortcutsChange,
  DictationShortcutsResult,
  HotkeyChangeResult,
  StartupState,
} from '../../shared/contracts'
import { chordNeedsListener, chordTokens, MAX_SHORTCUTS_PER_ROLE, standbyAllowed, type DictationShortcutSet } from '../../shared/dictationShortcuts'
import type { SottoPlatform } from '../../shared/platform'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsPatch,
} from '../../shared/settings'
import { chordTokenSet } from '../hotkeys/dictationShortcutRouter'

export interface NativeSettingsRepository {
  get(): Promise<AppSettings>
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  save(settings: AppSettings): Promise<AppSettings>
  reset(): Promise<AppSettings>
}

export interface NativeSettingsHotkeyService {
  current(): string | null | Promise<string | null>
  replace(accelerator: string): HotkeyChangeResult | Promise<HotkeyChangeResult>
  /** Releases (true) or restores (false) the registered accelerator; replace also ends a release. */
  suspend?(on: boolean): void
}

export interface NativeSettingsStartupService {
  get(): StartupState | Promise<StartupState>
  set(enabled: boolean): StartupState | Promise<StartupState>
}

/** Extra press and hold shortcuts (Owl `dictation-hold-shortcuts`); absent on Linux and with the feature off. */
export interface NativeSettingsDictationShortcutService {
  apply(set: DictationShortcutSet, mode: 'strict' | 'lenient'): DictationShortcutsResult
  /** Releases (true) or re-registers (false) the applied extras; apply also ends a release. */
  suspend(on: boolean): void
}

/**
 * Linux: Sotto's keys are Hyprland bindings (ADR-0062, ADR-0097). A change rewrites them first, in the Omarchy setup's
 * own lane, which then saves the shortcuts through `commitCompositorShortcuts`; that order never waits on this queue.
 */
export interface NativeSettingsCompositorKeys {
  replace(set: DictationShortcutSet): Promise<DictationShortcutsResult>
}

export interface NativeSettingsCoordinatorDependencies {
  readonly repository: NativeSettingsRepository
  readonly hotkeys: NativeSettingsHotkeyService
  readonly startup: NativeSettingsStartupService
  readonly onAutoPasteChanged: (enabled: boolean) => void | Promise<void>
  readonly onSettingsChanged: (settings: AppSettings) => void | Promise<void>
  readonly dictationShortcuts?: NativeSettingsDictationShortcutService
  /**
   * Platform defaults; must be the same row the repository resets to, or the
   * reset transaction fails its own verification. Omitting them keeps Windows.
   */
  readonly defaults?: AppSettings
  /** Chords compare by token set, with this platform's aliases. Omitting it keeps Windows. */
  readonly platform?: SottoPlatform
  /** Present only on Linux. */
  readonly compositorKeys?: NativeSettingsCompositorKeys
}

export class NativeManagedSettingMutationError extends Error {
  readonly code = 'NATIVE_MANAGED_SETTING_MUTATION'

  constructor() {
    super('Native-managed setting requires its dedicated operation')
    this.name = 'NativeManagedSettingMutationError'
  }
}

class NativeSettingsTransactionError extends Error {
  readonly code = 'NATIVE_SETTINGS_TRANSACTION_FAILED'

  constructor() {
    super('Native settings transaction failed')
    this.name = 'NativeSettingsTransactionError'
  }
}

/** A row's chords fit: between `min` and four, each a non-empty chord of at most 64 characters. */
function shortcutsFit(list: readonly string[], min: number): boolean {
  return list.length >= min && list.length <= MAX_SHORTCUTS_PER_ROLE && list.every((chord) => chord.length >= 1 && chord.length <= 64 && chordTokens(chord).length > 0)
}

export class NativeSettingsCoordinator {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly dependencies: NativeSettingsCoordinatorDependencies) {}

  getSettings(): Promise<AppSettings> {
    return this.enqueue(() => this.dependencies.repository.get())
  }

  updateSettings(patch: SettingsPatch): Promise<AppSettings> {
    if (Object.hasOwn(patch, 'hotkey') || Object.hasOwn(patch, 'launchAtStartup')) {
      return Promise.reject(new NativeManagedSettingMutationError())
    }
    const patchSnapshot = { ...patch }
    return this.enqueue(async () => {
      const previous = await this.dependencies.repository.get()
      try {
        // Apply fallible native effects before committing settings and OS-vault credentials.
        // Public snapshots deliberately contain a credential marker, not a rollback secret.
        if (
          patchSnapshot.autoPaste !== undefined &&
          patchSnapshot.autoPaste !== previous.autoPaste
        ) {
          await this.dependencies.onAutoPasteChanged(patchSnapshot.autoPaste)
        }
        const { worktreeCleanup, ...fields } = patchSnapshot
        const updated = await this.dependencies.repository.update({
          ...fields,
          ...(worktreeCleanup === undefined ? {} : {
            worktreeCleanup: { ...previous.worktreeCleanup, ...worktreeCleanup },
          }),
        })
        await this.notifySettingsChanged(updated)
        return updated
      } catch {
        await this.restoreSettings(previous)
        if (Object.hasOwn(patchSnapshot, 'autoPaste')) {
          await this.restoreAutoPaste(previous.autoPaste)
        }
        throw new NativeSettingsTransactionError()
      }
    })
  }

  /** Re-publish the read-only state main projects into settings (the Omarchy theme, the shell pill) without writing settings or invoking native effects. */
  republish(): Promise<void> {
    return this.enqueue(async () => this.notifySettingsChanged(await this.dependencies.repository.get()))
  }

  getHotkey(): Promise<string | null> {
    return this.enqueue(() => Promise.resolve(this.dependencies.hotkeys.current()))
  }

  replaceHotkey(accelerator: string): Promise<HotkeyChangeResult> {
    const next = accelerator.trim()
    const keys = this.dependencies.compositorKeys
    if (keys !== undefined) {
      // Stable on Linux changes only the first press shortcut; the rest stay as they were saved.
      return this.dependencies.repository.get().then(async (saved) => {
        const result = await keys.replace({ press: [next, ...saved.pressShortcuts], hold: saved.holdShortcuts })
        return result.ok ? result : { ok: false, reason: result.reason, ...(result.message === undefined ? {} : { message: result.message }) }
      }, () => ({ ok: false, reason: 'unavailable' }))
    }
    return this.enqueue(async () => {
      const previousSettings = await this.dependencies.repository.get()
      const previousNative =
        (await this.dependencies.hotkeys.current()) ?? previousSettings.hotkey

      let result: HotkeyChangeResult
      try {
        result = await this.dependencies.hotkeys.replace(next)
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      if (!result.ok) {
        return result
      }

      try {
        if ((await this.dependencies.hotkeys.current()) !== next) {
          throw new NativeSettingsTransactionError()
        }
        const updated = await this.dependencies.repository.update({ hotkey: next })
        if (updated.hotkey !== next) {
          throw new NativeSettingsTransactionError()
        }
        await this.notifySettingsChanged(updated)
        return result
      } catch {
        await this.restoreHotkey(previousNative)
        await this.restoreSettings(previousSettings)
        throw new NativeSettingsTransactionError()
      }
    })
  }

  replaceDictationShortcuts(change: DictationShortcutsChange): Promise<DictationShortcutsResult> {
    const press = change.press.map((chord) => chord.trim())
    const hold = change.hold.map((chord) => chord.trim())
    const keys = this.dependencies.compositorKeys
    if (keys !== undefined) {
      if (!shortcutsFit(press, 1) || !shortcutsFit(hold, 0)) return Promise.resolve({ ok: false, reason: 'invalid' })
      return keys.replace({ press, hold }).catch(() => ({ ok: false, reason: 'unavailable' }))
    }
    const router = this.dependencies.dictationShortcuts
    if (router === undefined) return Promise.resolve({ ok: false, reason: 'unavailable' })
    return this.enqueue(async (): Promise<DictationShortcutsResult> => {
      if (!shortcutsFit(press, 1) || !shortcutsFit(hold, 0)) return { ok: false, reason: 'invalid' }
      const previous = await this.dependencies.repository.get()
      const primary = press[0]!
      const platform = this.dependencies.platform ?? 'win32'
      const primaryChanged = chordTokenSet(primary, platform) !== chordTokenSet(previous.hotkey, platform)
      // The main shortcut must stay Electron-registerable; only an unchanged legacy value is taken as it is.
      if (primaryChanged && chordNeedsListener(primary, 'press')) return { ok: false, reason: 'invalid', chord: primary }
      const previousNative = (await this.dependencies.hotkeys.current()) ?? previous.hotkey
      const previousSet = { press: [previous.hotkey, ...previous.pressShortcuts], hold: previous.holdShortcuts }
      // A new primary (or a new spelling of it) may be an old extra (promotion, swap), and the OS refuses an
      // accelerator already held, so every dictation accelerator is released before the primary registers.
      const release = primary !== previous.hotkey

      let routerApplied = false
      try {
        if (release) {
          router.suspend(true)
          this.dependencies.hotkeys.suspend?.(true)
          const result = await this.dependencies.hotkeys.replace(primary)
          if (!result.ok) {
            // A refused replace keeps the prior primary; the old extras follow it.
            router.suspend(false)
            return { ok: false, reason: result.reason, chord: primary }
          }
        }
        const applied = router.apply({ press, hold }, 'strict')
        if (!applied.ok) {
          // A refused apply releases its new extras and keeps the old ones released: old primary first, then them.
          if (release) {
            await this.restoreHotkey(previousNative)
            router.suspend(false)
          }
          return applied
        }
        routerApplied = true
        const updated = await this.dependencies.repository.update({
          hotkey: primary,
          // A set that no longer fits standby brings the main shortcut back.
          hotkeyStandby: (change.standby ?? previous.hotkeyStandby) && standbyAllowed(press),
          pressShortcuts: press.slice(1),
          holdShortcuts: hold,
        })
        await this.notifySettingsChanged(updated)
        return { ok: true }
      } catch {
        // Release the new set, then register the old primary, then the old extras.
        if (routerApplied) this.releaseDictationShortcuts(true)
        if (release) await this.restoreHotkey(previousNative)
        if (routerApplied) this.restoreDictationShortcuts(previousSet)
        else if (release) this.releaseDictationShortcuts(false)
        await this.restoreSettings(previous)
        return { ok: false, reason: 'unavailable' }
      }
    })
  }

  /** Linux: saves shortcuts Hyprland has just taken. A throw tells the Omarchy setup to put the previous keys back. */
  commitCompositorShortcuts(set: DictationShortcutSet): Promise<void> {
    return this.enqueue(async () => {
      const primary = set.press[0]
      if (primary === undefined) throw new NativeSettingsTransactionError()
      const previous = await this.dependencies.repository.get()
      try {
        await this.dependencies.hotkeys.replace(primary)
        const updated = await this.dependencies.repository.update({ hotkey: primary, pressShortcuts: set.press.slice(1), holdShortcuts: [...set.hold] })
        await this.notifySettingsChanged(updated)
      } catch {
        await this.restoreHotkey(previous.hotkey)
        await this.restoreSettings(previous)
        throw new NativeSettingsTransactionError()
      }
    })
  }

  getStartup(): Promise<StartupState> {
    return this.enqueue(() => Promise.resolve(this.dependencies.startup.get()))
  }

  setStartup(enabled: boolean): Promise<StartupState> {
    return this.enqueue(async () => {
      const previousSettings = await this.dependencies.repository.get()
      const previousNative = await this.dependencies.startup.get()
      try {
        const changed = await this.dependencies.startup.set(enabled)
        if (changed.enabled !== enabled) {
          throw new NativeSettingsTransactionError()
        }
        const updated = await this.dependencies.repository.update({
          launchAtStartup: enabled,
        })
        if (updated.launchAtStartup !== enabled) {
          throw new NativeSettingsTransactionError()
        }
        await this.notifySettingsChanged(updated)
        return changed
      } catch {
        await this.restoreStartup(previousNative.enabled)
        await this.restoreSettings(previousSettings)
        throw new NativeSettingsTransactionError()
      }
    })
  }

  resetSettings(): Promise<AppSettings> {
    return this.enqueue(async () => {
      const defaults = this.dependencies.defaults ?? DEFAULT_SETTINGS
      const previousSettings = await this.dependencies.repository.get()
      const previousHotkey =
        (await this.dependencies.hotkeys.current()) ?? previousSettings.hotkey
      const previousStartup = await this.dependencies.startup.get()
      // Linux's keys live in Hyprland and change only from their own row, so a reset keeps them (ADR-0097).
      const keepKeys = this.dependencies.compositorKeys !== undefined
      const hotkey = keepKeys ? previousSettings.hotkey : defaults.hotkey

      try {
        // An old extra may equal the default hotkey: release every dictation accelerator before it registers.
        this.releaseDictationShortcuts(true)
        this.dependencies.hotkeys.suspend?.(true)
        const hotkeyResult = await this.dependencies.hotkeys.replace(hotkey)
        if (!hotkeyResult.ok) {
          throw new NativeSettingsTransactionError()
        }
        if ((await this.dependencies.hotkeys.current()) !== hotkey) {
          throw new NativeSettingsTransactionError()
        }
        const startupResult = await this.dependencies.startup.set(
          defaults.launchAtStartup,
        )
        if (startupResult.enabled !== defaults.launchAtStartup) {
          throw new NativeSettingsTransactionError()
        }
        if (previousSettings.autoPaste !== defaults.autoPaste) {
          await this.dependencies.onAutoPasteChanged(defaults.autoPaste)
        }

        let reset = await this.dependencies.repository.reset()
        if (keepKeys) {
          reset = await this.dependencies.repository.update({
            hotkey: previousSettings.hotkey,
            pressShortcuts: previousSettings.pressShortcuts,
            holdShortcuts: previousSettings.holdShortcuts,
          })
        }
        if (
          reset.hotkey !== hotkey ||
          reset.launchAtStartup !== defaults.launchAtStartup ||
          reset.autoPaste !== defaults.autoPaste
        ) {
          throw new NativeSettingsTransactionError()
        }
        this.restoreDictationShortcuts({ press: [reset.hotkey, ...reset.pressShortcuts], hold: reset.holdShortcuts })
        await this.notifySettingsChanged(reset)
        return reset
      } catch {
        await this.restoreAutoPaste(previousSettings.autoPaste)
        await this.restoreStartup(previousStartup.enabled)
        await this.restoreHotkey(previousHotkey)
        this.releaseDictationShortcuts(false)
        await this.restoreSettings(previousSettings)
        throw new NativeSettingsTransactionError()
      }
    })
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const queued = this.mutationTail.then(operation)
    this.mutationTail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  private async restoreSettings(settings: AppSettings): Promise<void> {
    try {
      await this.dependencies.repository.save(settings)
    } catch {
      // Preserve the original finite transaction failure at the IPC boundary.
    }
  }

  private async notifySettingsChanged(settings: AppSettings): Promise<void> {
    try {
      await this.dependencies.onSettingsChanged({ ...settings })
    } catch {
      // Renderer synchronization is observational after the authoritative commit.
    }
  }

  private async restoreHotkey(accelerator: string): Promise<void> {
    try {
      await this.dependencies.hotkeys.replace(accelerator)
    } catch {
      // Best-effort rollback; the transaction still fails closed.
    }
  }

  private restoreDictationShortcuts(set: DictationShortcutSet): void {
    try {
      this.dependencies.dictationShortcuts?.apply(set, 'lenient')
    } catch {
      // Best-effort rollback; the transaction still fails closed.
    }
  }

  private releaseDictationShortcuts(on: boolean): void {
    try {
      this.dependencies.dictationShortcuts?.suspend(on)
    } catch {
      // Best-effort; the transaction still fails closed.
    }
  }

  private async restoreStartup(enabled: boolean): Promise<void> {
    try {
      await this.dependencies.startup.set(enabled)
    } catch {
      // Best-effort rollback; the transaction still fails closed.
    }
  }

  private async restoreAutoPaste(enabled: boolean): Promise<void> {
    try {
      await this.dependencies.onAutoPasteChanged(enabled)
    } catch {
      // Best-effort rollback; the transaction still fails closed.
    }
  }
}
