import React, { useLayoutEffect, type ReactNode } from 'react'
import { ClaudeBotSprite, paintBot, useBotParts } from './claudeBotSprite'

/**
 * Claude bot at rest, holding up a sign with a pull request's mark, in the muted colour (the stylesheet mutes it). Like
 * Sotto's babysitting creature it never moves: it claims no watch and no work running (ADR-0061), so there is no frame
 * loop and reduced motion has nothing to hold still. The resting stance is painted once.
 */
export function ClaudeBotBabysitting(): ReactNode {
  const parts = useBotParts()
  useLayoutEffect(() => { paintBot(parts, { eyes: 'rest' }) }, [parts])
  return <div className="thread-monitor__actor" aria-hidden="true">
    <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
      <ClaudeBotSprite parts={parts}>
        {/* The pole stands clear of the body and legs; the fist wraps it, so it reads as held rather than as a leg. */}
        <path className="thread-monitor__handle" d="M32 11h2v21h-2z" />
        <path className="bot-b" d="M31 21h4v1h-4z" />
        <path className="bot-h" d="M31 20h4v1h-4z" />
        <path className="bot-l" d="M31 22h4v1h-4z" />
        {/* Sotto's sign, a unit to the right: translucent, outlined so it reads on any surface, with the pull request mark. */}
        <path className="thread-monitor__color" opacity=".28" d="M29 3h9v8h-9z" />
        <path className="thread-monitor__shine" d="M29 2h9v1h-9z M29 11h9v1h-9z M28 3h1v8h-1z M38 3h1v8h-1z" />
        <path className="thread-monitor__sign" d="M30 4h2v2h-2z M31 6h1v4h-1z M30 10h2v2h-2z M35 4h1v1h-1z M36 5h1v5h-1z M35 10h2v2h-2z M34 4h1v1h-1z" />
      </ClaudeBotSprite>
    </svg>
  </div>
}
