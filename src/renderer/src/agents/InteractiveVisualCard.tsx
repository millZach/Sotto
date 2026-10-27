import React, { useRef, type ReactNode } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { INTERACTIVE_VISUAL_LABEL, type AgentVisual } from '../../../shared/visuals'
import type { VisualStepPlace } from '../../../shared/visualGuest'
import { useFrameControls, type FrameControls } from './diagrams/DiagramFrame'
import { ViewerDialog } from './diagrams/ViewerDialog'
import { InteractiveVisualPage } from './InteractiveVisual'
import { VisualCardShell } from './VisualCardShell'
import { pageStepFor, useWalkthroughPlace, type ExpandedWalkthrough } from './VisualWalkthrough'

/** Where a reader can turn when the page is not shown, by what the visual has besides it. */
export function pageFallbackHint(visual: Pick<AgentVisual, 'intro' | 'steps'>): string {
  if (visual.steps?.length) return i18n._(msg`Its steps are below.`)
  if (visual.intro) return i18n._(msg`What it shows is described below.`)
  return i18n._(msg({ message: 'Show source shows its HTML.', comment: 'Show source is the name of a button on the card.' }))
}

/**
 * An interactive visual in its card (ADR-0060): the same card as a diagram's (`VisualCardShell`), with the agent's page
 * running sealed where a diagram's drawing would be. Each step the reader moves to goes to the page as a step message
 * with the names that step is about, so the page can show it. Escape inside the page gives focus back to the card.
 */
export function InteractiveVisualCard({ visual, threadId }: { readonly visual: AgentVisual; readonly threadId: string | undefined }): ReactNode {
  const { t } = useLingui()
  const title = visual.title
  const frame = useFrameControls(visual.source)
  const card = useRef<HTMLElement>(null)
  const [place, movePlace] = useWalkthroughPlace(visual.id)
  const step = pageStepFor(visual.steps ?? [], place)
  const fallbackHint = pageFallbackHint(visual)
  // Escape from the page is a key, so focus lands on the card with its ring showing, until focus moves on.
  const returnFocus = (): void => {
    const element = card.current
    if (!element) return
    element.dataset.focusReturned = ''
    element.addEventListener('blur', () => { delete element.dataset.focusReturned }, { once: true })
    element.focus()
  }

  return <VisualCardShell visual={visual} kind={INTERACTIVE_VISUAL_LABEL} state="drawn" interactive cardRef={card} frame={frame} showing shownTitle={t`Show page`}
    place={place} movePlace={movePlace}
    stage={frame.showSource
      ? <div className="visual-card__stage">
        <pre className="rich-code__scroll visual-card__source" tabIndex={0} aria-label={t({ message: `${title} source`, comment: '{title} is a visual\'s title: its source.' })}><code>{visual.source}</code></pre>
      </div>
      // The page stops while Expand shows it, so one visual never runs twice.
      : frame.expanded ? <div className="interactive-visual" data-state="expanded" aria-hidden="true" />
        : <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} fallbackHint={fallbackHint} onEscape={returnFocus} />}
    expandedView={walkthrough => frame.expanded && <InteractiveVisualViewer visual={visual} threadId={threadId} step={step} fallbackHint={fallbackHint} frame={frame} walkthrough={walkthrough} />} />
}

/**
 * An interactive visual expanded over the window: the same sealed page with the room to fill, Copy source and Close,
 * and the card's walkthrough under it. Left and Right step it while focus is outside the page; inside, they are the
 * page's own.
 */
function InteractiveVisualViewer({ visual, threadId, step, fallbackHint, frame, walkthrough }: {
  readonly visual: AgentVisual; readonly threadId: string | undefined; readonly step: VisualStepPlace; readonly fallbackHint: string; readonly frame: FrameControls
  readonly walkthrough: ExpandedWalkthrough | undefined
}): ReactNode {
  const { t } = useLingui()
  const closeButton = useRef<HTMLButtonElement>(null)
  const { feedback, copied, copy, close } = frame
  const title = visual.title
  return <ViewerDialog title={t({ message: `Interactive page: ${title}`, comment: '{title} is the title of a page an agent made.' })} className="interactive-visual-viewer" status={feedback} focusOnOpen={closeButton} walkthrough={walkthrough} onClose={close}
    controls={<>
      <button type="button" className="rich-code__copy tt-focusable" data-copied={copied || undefined} aria-label={t`Copy page source`} title={t`Copy source`} onClick={copy}>
        {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
      <button ref={closeButton} type="button" className="rich-code__copy tt-focusable" aria-label={t`Close page`} title={t`Close (Esc)`} onClick={close}><X size={17} aria-hidden="true" /></button>
    </>}>
    <div className="interactive-visual-viewer__body">
      <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} fallbackHint={fallbackHint} expanded onEscape={close} />
    </div>
  </ViewerDialog>
}
