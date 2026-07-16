import type { StartupState } from '../../shared/contracts'

export interface LoginItemAdapter {
  getLoginItemSettings(): { readonly openAtLogin: boolean }
  setLoginItemSettings(settings: { readonly openAtLogin: boolean }): void
}

export class StartupService {
  constructor(private readonly loginItems: LoginItemAdapter) {}

  get(): StartupState {
    return { enabled: this.loginItems.getLoginItemSettings().openAtLogin }
  }

  set(enabled: boolean): StartupState {
    if (this.get().enabled !== enabled) {
      this.loginItems.setLoginItemSettings({ openAtLogin: enabled })
    }
    return this.get()
  }
}
