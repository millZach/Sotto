import { useOptionalApp } from './AppContext'
import { useOwlFeature } from './owlFeature'
import { useReducedMotion } from './reducedMotion'

/**
 * Whether a press sends waves of 0s and 1s through the room: Settings → Appearance → Click effect, on until turned off
 * and before settings are read. It is an Owl feature (ADR-0072), so where it is held nothing of it exists, and reduced
 * motion, the system's or Sotto's own, turns it off entirely (ADR-0154).
 */
export function useClickEffectOn(): boolean {
  const owl = useOwlFeature('click-effect')
  const saved = useOptionalApp()?.settings?.clickEffect
  const reduced = useReducedMotion()
  return owl && saved !== false && !reduced
}
