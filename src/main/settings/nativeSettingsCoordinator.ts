import type { HotkeyChangeResult, StartupState } from '../../shared/contracts'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsPatch,
} from '../../shared/settings'

export interface NativeSettingsRepository {
  get(): Promise<AppSettings>
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  save(settings: AppSettings): Promise<AppSettings>
  reset(): Promise<AppSettings>
}

export interface NativeSettingsHotkeyService {
  current(): string | null | Promise<string | null>
  replace(accelerator: string): HotkeyChangeResult | Promise<HotkeyChangeResult>
}

export interface NativeSettingsStartupService {
  get(): StartupState | Promise<StartupState>
  set(enabled: boolean): StartupState | Promise<StartupState>
}

export interface NativeSettingsCoordinatorDependencies {
  readonly repository: NativeSettingsRepository
  readonly hotkeys: NativeSettingsHotkeyService
  readonly startup: NativeSettingsStartupService
  readonly onAutoPasteChanged: (enabled: boolean) => void | Promise<void>
  readonly onSettingsChanged: (settings: AppSettings) => void | Promise<void>
  /**
   * Platform defaults; must be the same row the repository resets to, or the
   * reset transaction fails its own verification. Omitting them keeps Windows.
   */
  readonly defaults?: AppSettings
}

export class NativeManagedSettingMutationError extends Error {
  readonly code = 'NATIVE_MANAGED_SETTING_MUTATION'

  constructor() {
    super('Native-managed setting requires its dedicated operation')
    this.name = 'NativeManagedSettingMutationError'
  }
}

export class NativeSettingsTransactionError extends Error {
  readonly code = 'NATIVE_SETTINGS_TRANSACTION_FAILED'

  constructor() {
    super('Native settings transaction failed')
    this.name = 'NativeSettingsTransactionError'
  }
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
        const updated = await this.dependencies.repository.update(patchSnapshot)
        if (
          Object.hasOwn(patchSnapshot, 'autoPaste') &&
          updated.autoPaste !== previous.autoPaste
        ) {
          await this.dependencies.onAutoPasteChanged(updated.autoPaste)
        }
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

  getHotkey(): Promise<string | null> {
    return this.enqueue(() => Promise.resolve(this.dependencies.hotkeys.current()))
  }

  replaceHotkey(accelerator: string): Promise<HotkeyChangeResult> {
    const next = accelerator.trim()
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

      try {
        const hotkeyResult = await this.dependencies.hotkeys.replace(defaults.hotkey)
        if (!hotkeyResult.ok) {
          throw new NativeSettingsTransactionError()
        }
        if ((await this.dependencies.hotkeys.current()) !== defaults.hotkey) {
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

        const reset = await this.dependencies.repository.reset()
        if (
          reset.hotkey !== defaults.hotkey ||
          reset.launchAtStartup !== defaults.launchAtStartup ||
          reset.autoPaste !== defaults.autoPaste
        ) {
          throw new NativeSettingsTransactionError()
        }
        await this.notifySettingsChanged(reset)
        return reset
      } catch {
        await this.restoreAutoPaste(previousSettings.autoPaste)
        await this.restoreStartup(previousStartup.enabled)
        await this.restoreHotkey(previousHotkey)
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
