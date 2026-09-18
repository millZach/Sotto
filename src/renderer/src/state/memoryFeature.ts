import { useOptionalApp } from './AppContext'

/**
 * Whether memory is shown at all. It is off for the beta (`memoryEnabled` in
 * settings), which hides the Memory page and its link, the questionnaire that
 * greets the Agents room and the preferences a turn would retrieve, while
 * leaving the store and its code in place. The main process reads the same
 * setting once at start to keep preferences out of agent turns.
 */
export function useMemoryEnabled(): boolean {
  const app = useOptionalApp()
  return app?.settings?.memoryEnabled === true
}
