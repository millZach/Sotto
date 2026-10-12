import type { UpdateStatus } from '../../../shared/contracts'
import { owlFeatureEnabledOf, useOwlFeature } from './owlFeature'

/** Compatibility wrapper around the Owl feature list for Watcher branches in flight. */
export function watcherEnabledOf(update: UpdateStatus | null | undefined): boolean {
  return owlFeatureEnabledOf(update, 'watcher')
}

/** Compatibility wrapper around useOwlFeature; saved records remain in main. */
export function useWatcherEnabled(): boolean {
  return useOwlFeature('watcher')
}
