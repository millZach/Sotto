import React, { type ReactNode } from 'react'
import type { Creature } from '../../../shared/settings'
import { ClaudeBotMonitoring } from './ClaudeBotMonitoring'
import { MonitoringCreature } from './ThreadMonitor'
import './threadMonitor.css'

/**
 * One creature walking back and forth along a short track of its own, so Settings → Appearance can show each
 * character doing what it does above the composer. Decorative: the choice around it names the character.
 */
export function CreatureWalk({ creature }: { readonly creature: Creature }): ReactNode {
  return <div className="creature-walk" data-creature={creature} aria-hidden="true">
    <div className="thread-monitor__track">{creature === 'claude' ? <ClaudeBotMonitoring /> : <MonitoringCreature />}</div>
  </div>
}
