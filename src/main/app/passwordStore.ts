import type { SottoPlatform } from '../../shared/platform'

export interface PasswordStoreCommandLine {
  hasSwitch(name: string): boolean
  appendSwitch(name: string, value: string): void
}

/** Hyprland needs an explicit secret-service backend before Chromium starts. */
export function configurePasswordStore(platform: SottoPlatform, commandLine: PasswordStoreCommandLine): void {
  if (platform === 'linux' && !commandLine.hasSwitch('password-store')) {
    commandLine.appendSwitch('password-store', 'gnome-libsecret')
  }
}
