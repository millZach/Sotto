import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Creature } from '../../../shared/settings'
import { ClaudeBotMonitoring } from './ClaudeBotMonitoring'
import { Lardo } from './Lardo'
import { MonitoringCreature } from './ThreadMonitor'
import './threadMonitor.css'

/**
 * One creature walking back and forth along a short track of its own, so Settings → Appearance can show each
 * character doing what it does above the composer. Decorative: the choice around it names the character.
 * Settings keeps hidden panels mounted, so the walker (and its frame loop) mounts only while the block is on screen;
 * the block keeps its size when empty so nothing jumps.
 */
export function CreatureWalk({ creature }: { readonly creature: Creature }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  // Without IntersectionObserver (jsdom) there is nothing to wait for: walk at once, as before.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !ref.current) return
    const observer = new IntersectionObserver(entries => {
      const last = entries[entries.length - 1]
      if (last) setVisible(last.isIntersecting)
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} className="creature-walk" data-creature={creature} aria-hidden="true">
    {visible && <div className="thread-monitor__track">{creature === 'lardo' ? <Lardo pose="monitoring" playful={false} /> : creature === 'claude' ? <ClaudeBotMonitoring /> : <MonitoringCreature />}</div>}
  </div>
}
