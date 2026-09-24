import { useCallback } from 'react'
import {
  DEFAULT_SETTINGS, initialMergeMethod, mergeMethodChosenPatch,
  type DiffFileState, type DiffLayout, type GitMergeMethod,
} from '../../../shared/settings'
import { useOptionalApp } from './AppContext'

/** What Changes starts with until the user changes it there: the Diff layout, whitespace and file state settings. */
export interface DiffPreferences {
  readonly layout: DiffLayout
  readonly hideWhitespace: boolean
  readonly fileState: DiffFileState
}

/**
 * The diff settings Changes starts from. Null until settings arrive, and outside the app (a surface rendered
 * on its own in a test), so a starting view is never taken from defaults and then replaced by the real choice.
 */
export function useDiffPreferences(): DiffPreferences | null {
  const settings = useOptionalApp()?.settings
  return settings ? { layout: settings.diffLayout, hideWhitespace: settings.diffHideWhitespace, fileState: settings.diffFileState } : null
}

/**
 * The merge method a pull request's merge starts on, and what to call once the user merges: under Last
 * selected the chosen method is saved as the one to start on next time; under a fixed default nothing is saved.
 */
export function useMergeMethod(): { readonly method: GitMergeMethod; readonly remember: (method: GitMergeMethod) => void } {
  const app = useOptionalApp()
  const settings = app?.settings ?? null
  const updateSettings = app?.actions.updateSettings
  const remember = useCallback((method: GitMergeMethod) => {
    const patch = settings ? mergeMethodChosenPatch(settings, method) : null
    if (patch && updateSettings) void updateSettings(patch)
  }, [settings, updateSettings])
  return { method: initialMergeMethod(settings ?? DEFAULT_SETTINGS), remember }
}

/** Whether Changes may open on its own after a large turn. Off unless the user turned Proactive panels on. */
export function useProactivePanelsEnabled(): boolean {
  return useOptionalApp()?.settings?.proactivePanels === true
}
