import { CREATURES, DEFAULT_SETTINGS, type Creature } from '../../../shared/settings'
import { useOptionalApp } from './AppContext'

/**
 * Which character stands above the composer: the one chosen in Settings → Appearance. Anything the settings do not
 * name, and a window that has not read them yet, gets Sotto's own.
 */
export function useCreature(): Creature {
  const chosen = useOptionalApp()?.settings?.creature
  return chosen !== undefined && (CREATURES as readonly string[]).includes(chosen) ? chosen : DEFAULT_SETTINGS.creature
}

/** Whether the creature shows at all: Settings → Appearance → Creature. On until turned off, and before settings are read. */
export function useCreatureShown(): boolean {
  return useOptionalApp()?.settings?.showCreature !== false
}
