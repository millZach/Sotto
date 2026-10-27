import React, { useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { keepRecent, readRecent } from '../../../shared/recentMap'
import type { AgentVisual } from '../../../shared/visuals'
import { READ_ALL_STEP, type VisualStepPlace } from '../../../shared/visualGuest'
import { VisualStepper, clampStep } from './VisualStepper'

/**
 * A visual's walkthrough place (#793), shared by every card that shows one: a diagram's and an interactive page's
 * (ADR-0060). The stepper itself is `VisualStepper`, which holds no state; this keeps where the reader is.
 */

/** Where a reader is in one visual's walkthrough: the step shown, and whether every step is shown instead. */
export interface WalkthroughPlace { readonly step: number; readonly readAll: boolean }
const FIRST_STEP: WalkthroughPlace = { step: 0, readAll: false }

/**
 * Each visual's place, by the visual's id. A card is drawn again when its turn finishes and folds, or the thread is
 * opened again, and the reader stays where they were. Kept for this window's life only, the most recent 200.
 */
const places = new Map<string, WalkthroughPlace>()
const MAX_PLACES = 200

/** One visual's place, and a function that moves it and keeps where it went. */
export function useWalkthroughPlace(id: string): [WalkthroughPlace, (change: Partial<WalkthroughPlace>) => void] {
  const [place, setPlace] = useState(() => readRecent(places, id) ?? FIRST_STEP)
  const move = (change: Partial<WalkthroughPlace>): void => setPlace(keepRecent(places, id, { ...place, ...change }, MAX_PLACES))
  return [place, move]
}

/** What a place shows of these steps: whether the walkthrough shows, the step's index, and the names it lights. */
export function walkthroughView(steps: NonNullable<AgentVisual['steps']>, place: WalkthroughPlace): {
  readonly walking: boolean; readonly current: number; readonly highlight: readonly string[] | undefined
} {
  const walking = steps.length > 0 && !place.readAll
  const current = clampStep(place.step, steps.length)
  return { walking, current, highlight: walking ? steps[current]?.highlight : undefined }
}

/**
 * The walkthrough as Expand shows it: the card's own bar under the picture, and a step for Left and Right anywhere in
 * the expanded view. It moves the card's place, so Expand opens on the card's step and the card is on the step Expand
 * closed on.
 */
export interface ExpandedWalkthrough {
  readonly bar: ReactNode
  /** One step back (-1) or on (1), stopping at the ends; none for a visual with one step, which has nowhere to go. */
  readonly step: ((direction: -1 | 1) => void) | undefined
}

/** The expanded walkthrough for a place, or none while Read all shows every step or the visual has none. */
export function expandedWalkthrough(steps: NonNullable<AgentVisual['steps']>, place: WalkthroughPlace,
  movePlace: (change: Partial<WalkthroughPlace>) => void): ExpandedWalkthrough | undefined {
  const { walking, current } = walkthroughView(steps, place)
  if (!walking) return undefined
  const onStep = (index: number): void => movePlace({ step: index })
  return {
    bar: <VisualStepper steps={steps} index={current} onStep={onStep} />,
    step: steps.length < 2 ? undefined : direction => {
      const next = clampStep(current + direction, steps.length)
      if (next !== current) onStep(next)
    },
  }
}

/**
 * What an interactive page is told of a place: the step shown, counted from 1 where the place counts its index from 0,
 * with the names that step lists; or, while Read all shows every step (and for a visual with none), `READ_ALL_STEP`
 * with nothing named.
 */
export function pageStepFor(steps: NonNullable<AgentVisual['steps']>, place: WalkthroughPlace): VisualStepPlace {
  const { walking, current, highlight } = walkthroughView(steps, place)
  return walking ? { step: current + 1, total: steps.length, highlight: [...highlight ?? []] } : { step: READ_ALL_STEP, total: steps.length, highlight: [] }
}

/** Read all, named for what a press does: it shows every step, and reads Step through while it does. */
export function ReadAllToggle({ readAll, onToggle }: { readonly readAll: boolean; readonly onToggle: () => void }): ReactNode {
  const { t } = useLingui()
  return <button type="button" className="tt-button visual-card__read-all tt-focusable" data-reading-all={readAll || undefined}
    onClick={onToggle}>{readAll ? t`Step through` : t`Read all`}</button>
}
