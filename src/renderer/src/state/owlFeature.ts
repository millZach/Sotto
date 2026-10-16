import { useMemo } from 'react'
import type { UpdateStatus } from '../../../shared/contracts'
import { HELD_PROVIDER_ENTRIES, heldProvidersOf, type HeldProviders } from '../../../shared/heldProviders'
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

/** The providers held to Owl by the startup answers; missing information holds every one. */
export function heldProvidersOfUpdate(update: UpdateStatus | null | undefined): HeldProviders {
  return heldProvidersOf(Object.fromEntries(HELD_PROVIDER_ENTRIES.map(entry => [entry.feature, owlFeatureEnabledOf(update, entry.feature)])))
}

/** Ask before listing a provider: a held provider shows nowhere, as no Owl feature's part does. */
export function useHeldProviders(): HeldProviders {
  const update = useOptionalApp()?.update
  return useMemo(() => heldProvidersOfUpdate(update), [update])
}
