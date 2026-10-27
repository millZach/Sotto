import React, { type ReactNode } from 'react'
import './effortTrace.css'

/**
 * The light that travels round a composer while its thread is set to the top effort (ADR-0019). It is drawn in every
 * composer and shows only while the effort chip inside carries `data-effort-trace`, so no prop has to travel; the
 * pieces are real elements because each turning light sits inside a mask, which a pseudo element cannot hold.
 */
export function EffortTrace(): ReactNode {
  return <span className="effort-trace" aria-hidden="true">
    <span className="effort-trace__halo"><span className="effort-trace__glow"><span className="effort-trace__stretch"><span className="effort-trace__light" /></span></span></span>
    <span className="effort-trace__line"><span className="effort-trace__stretch"><span className="effort-trace__light" /></span></span>
  </span>
}
