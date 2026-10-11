import type { StartupState } from '../../shared/contracts'

export interface LoginItemAdapter {
  readonly supported?: boolean
  /** Packaged Linux also reconciles an unchanged setting after its executable moves. */
  readonly reconcileOnSet?: boolean
  /** `status` is macOS only. On macOS 13 and later it can say the login item waits for the user's approval. */
  getLoginItemSettings(): { readonly openAtLogin: boolean; readonly status?: string }
  setLoginItemSettings(settings: { readonly openAtLogin: boolean }): void
}

/**
 * Electron's login items do nothing on Linux, so nothing there may reach them: not the Settings row, not a
 * remembered setting at startup, not the settings channel. Development builds read as unsupported;
 * packaged builds use the XDG autostart adapter instead.
 */
export const LINUX_LOGIN_ITEMS: LoginItemAdapter = Object.freeze({
  supported: false,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: () => undefined,
})

export class StartupService {
  constructor(private readonly loginItems: LoginItemAdapter) {}

  /**
   * A login item macOS holds for approval is still the user's choice: it reads as on, with `approvalRequired`,
   * so the toggle does not snap back and Settings can say where to allow it.
   */
  get(): StartupState {
    const settings = this.loginItems.getLoginItemSettings()
    if (settings.status === 'requires-approval') return { enabled: true, approvalRequired: true }
    return { enabled: settings.openAtLogin, ...(this.loginItems.supported === undefined ? {} : { supported: this.loginItems.supported }) }
  }

  set(enabled: boolean): StartupState {
    if (this.get().enabled !== enabled || this.loginItems.reconcileOnSet === true) {
      this.loginItems.setLoginItemSettings({ openAtLogin: enabled })
    }
    return this.get()
  }
}
