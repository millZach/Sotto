import { useOptionalApp } from './AppContext'
import { useOwlFeature } from './owlFeature'
import { useReducedMotion } from './reducedMotion'

/**
 * Whether the click effect is chosen: Settings → Appearance → Click effect, on until turned off and before settings are
 * read. It is an Owl feature (ADR-0072), so where it is held it is never chosen. Chosen, it replaces every click ripple
 * Sotto had, Watcher's margin's included, even while reduced motion keeps its own waves still (ADR-0156).
 */
export function useClickEffectChosen(): boolean {
  const owl = useOwlFeature('click-effect')
  const saved = useOptionalApp()?.settings?.clickEffect
  return owl && saved !== false
}

/**
 * Whether a press sends waves of 0s and 1s through the room: chosen, and motion not reduced, the system's or Sotto's own.
 * Motion is followed only while the effect is chosen, so a held or switched-off effect starts nothing.
 */
export function useClickEffectOn(): boolean {
  const chosen = useClickEffectChosen()
  const reduced = useReducedMotion(chosen)
  return chosen && !reduced
}
