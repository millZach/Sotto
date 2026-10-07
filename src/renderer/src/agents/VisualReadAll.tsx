import React, { type ReactNode } from 'react'
import type { AgentVisual } from '../../../shared/visuals'

/**
 * A visual's explanation laid out to read all at once: the intro, then the numbered steps. A visual without steps shows
 * it always; one with steps shows it under Read all, in place of the walkthrough.
 */
export function VisualReadAll({ intro, steps }: Pick<AgentVisual, 'intro' | 'steps'>): ReactNode {
  if (!intro && !steps?.length) return null
  return <div className="visual-card__explain">
    {intro ? <p className="visual-card__intro">{intro}</p> : null}
    {steps?.length ? <ol className="visual-card__steps">{steps.map((step, index) => <li key={index}>{step.text}</li>)}</ol> : null}
  </div>
}
