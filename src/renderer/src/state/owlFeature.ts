import type { UpdateStatus } from '../../../shared/contracts'
import type { OwlFeatureId } from '../../../shared/owlFeatures'
import { useOptionalApp } from './AppContext'

/** Main supplies the startup answers. Older Watcher callers may still supply only its alias. */
export function owlFeatureEnabledOf(update: UpdateStatus | null | undefined, id: OwlFeatureId): boolean {
  if (update?.owlFeatures !== undefined) return update.owlFeatures[id] === true
  return id === 'watcher' && update?.watcherEnabled === true
}

/** Ask before mounting any part of an Owl feature; missing startup information keeps it hidden. */
export function useOwlFeature(id: OwlFeatureId): boolean {
  return owlFeatureEnabledOf(useOptionalApp()?.update, id)
}
