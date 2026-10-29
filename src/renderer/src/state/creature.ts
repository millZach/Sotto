import { CREATURES, DEFAULT_SETTINGS, type Creature } from '../../../shared/settings'
import { useOptionalApp } from './AppContext'
import { useOwlFeature } from './owlFeature'

/**
 * The creatures this build offers: Lardo only where his Owl feature is on (ADR-0072), the others always.
 */
export function offeredCreatures(lardo: boolean): readonly Creature[] {
  return CREATURES.filter(creature => creature !== 'lardo' || lardo)
}

/**
 * The character that stands for `chosen`: itself where the build offers it, and Sotto's own for anything else, a
 * held Lardo included. The saved choice is left as it was, so a build that has him shows him again.
 */
export function creatureShown(chosen: string | undefined, lardo: boolean): Creature {
  return chosen !== undefined && (offeredCreatures(lardo) as readonly string[]).includes(chosen) ? chosen as Creature : DEFAULT_SETTINGS.creature
}

/** Whether this build offers Lardo: his Owl feature, asked before any part of him exists. */
export function useLardoOffered(): boolean {
  return useOwlFeature('lardo-creature')
}

/**
 * Which character stands above the composer: the one chosen in Settings → Appearance. Anything the settings do not
 * name, a creature this build holds, and a window that has not read them yet, gets Sotto's own.
 */
export function useCreature(): Creature {
  const chosen = useOptionalApp()?.settings?.creature
  return creatureShown(chosen, useLardoOffered())
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
