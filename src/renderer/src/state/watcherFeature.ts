import type { UpdateStatus } from '../../../shared/contracts'
import { useOptionalApp } from './AppContext'

/** Main reads the running build once at startup. Missing information keeps Watcher hidden. */
export function watcherEnabledOf(update: UpdateStatus | null | undefined): boolean {
  return update?.watcherEnabled === true
}

/** Watcher surfaces ask main's startup gate before they exist; saved records remain in main. */
export function useWatcherEnabled(): boolean {
  return watcherEnabledOf(useOptionalApp()?.update)
}
