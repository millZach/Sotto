import { useOptionalApp } from './AppContext'

/**
 * Whether the voice coordinator is shown at all. It is off for the beta
 * (`voiceCoordinatorEnabled` in settings), which hides the wake phrase, the
 * Agents room, spoken hints, the widget's voice controls and assignment while
 * leaving the code in place. Dictation does not depend on it.
 */
export function useVoiceCoordinatorEnabled(): boolean {
  const app = useOptionalApp()
  return app?.settings?.voiceCoordinatorEnabled === true
}
