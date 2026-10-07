import type { StartupState } from '../../shared/contracts'

export interface LoginItemAdapter {
  /** `status` is macOS only. On macOS 13 and later it can say the login item waits for the user's approval. */
  getLoginItemSettings(): { readonly openAtLogin: boolean; readonly status?: string }
  setLoginItemSettings(settings: { readonly openAtLogin: boolean }): void
}

export class StartupService {
  constructor(private readonly loginItems: LoginItemAdapter) {}

  /**
   * A login item macOS holds for approval is still the user's choice: it reads as on, with `approvalRequired`,
   * so the toggle does not snap back and Settings can say where to allow it.
   */
  get(): StartupState {
    const settings = this.loginItems.getLoginItemSettings()
    if (settings.status === 'requires-approval') return { enabled: true, approvalRequired: true }
    return { enabled: settings.openAtLogin }
  }

  set(enabled: boolean): StartupState {
    if (this.get().enabled !== enabled) {
      this.loginItems.setLoginItemSettings({ openAtLogin: enabled })
    }
    return this.get()
  }
}
