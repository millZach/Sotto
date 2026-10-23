import { CREATURES, DEFAULT_SETTINGS, type Creature } from '../../../shared/settings'
import { useOptionalApp } from './AppContext'
import { useOwlFeature } from './owlFeature'

/**
 * Which character stands above the composer: the one chosen in Settings → Appearance. Anything the settings do not
 * name, and a window that has not read them yet, gets Sotto's own.
 */
export function useCreature(): Creature {
  const chosen = useOptionalApp()?.settings?.creature
  return chosen !== undefined && (CREATURES as readonly string[]).includes(chosen) ? chosen : DEFAULT_SETTINGS.creature
}

/**
 * Whether the creature shows at all: Settings → Appearance → Show the creature. On until turned off, and before settings
 * are read. The switch is an Owl feature (ADR-0072), so where it is held the creature always shows.
 */
export function useCreatureShown(): boolean {
  const switchable = useOwlFeature('creature-toggle')
  const saved = useOptionalApp()?.settings?.showCreature
  return !switchable || saved !== false
}
