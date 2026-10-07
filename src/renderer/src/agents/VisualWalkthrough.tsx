import React, { useState, type ReactNode } from 'react'
import { keepRecent, readRecent } from '../../../shared/recentMap'
import type { AgentVisual } from '../../../shared/visuals'
import { clampStep } from './VisualStepper'

/**
 * A visual's walkthrough place (#793), shared by every card that shows one: a diagram's and an interactive page's
 * (ADR-0057). The stepper itself is `VisualStepper`, which holds no state; this keeps where the reader is.
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

/** Read all, named for what a press does: it shows every step, and reads Step through while it does. */
export function ReadAllToggle({ readAll, onToggle }: { readonly readAll: boolean; readonly onToggle: () => void }): ReactNode {
  return <button type="button" className="tt-button visual-card__read-all tt-focusable" data-reading-all={readAll || undefined}
    onClick={onToggle}>{readAll ? 'Step through' : 'Read all'}</button>
}
