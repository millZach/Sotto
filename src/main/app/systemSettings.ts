import { systemSettingsPaneSchema, type SystemSettingsPane } from '../../shared/systemSettings'
import type { SottoPlatform } from '../../shared/platform'

// The only URLs this module ever opens: fixed, one per pane, never built from input.
const PANE_URLS: Readonly<Record<SystemSettingsPane, string>> = Object.freeze({
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
})

/**
 * Opens a macOS Privacy & Security pane, or returns null where there is none
 * to open. The pane is checked against the fixed list again here, so nothing
 * but these three URLs can reach `openExternal`.
 */
export function createSystemSettingsOpener(
  platform: SottoPlatform,
  openExternal: (url: string) => Promise<void>,
): ((pane: SystemSettingsPane) => Promise<void>) | null {
  if (platform !== 'darwin') return null
  return async (pane) => openExternal(PANE_URLS[systemSettingsPaneSchema.parse(pane)])
}
