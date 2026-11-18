import type { OwlFeatureId, OwlFeatureStates } from '../../src/shared/owlFeatures'

/**
 * Owl answers for a build whose version still holds these features, as every stable build did before Zach sent them
 * (ADR-0072). Since November 17, 2026 the list holds none, so a test that proves a gate holds passes its own held set to
 * the headless host's test-only `owlFeatures` option rather than relying on a stable version.
 */
export function holding(...ids: readonly OwlFeatureId[]): Partial<OwlFeatureStates> {
  return Object.fromEntries(ids.map(id => [id, false])) as Partial<OwlFeatureStates>
}
