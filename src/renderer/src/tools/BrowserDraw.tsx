import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { BrowserCapture } from '../../../shared/browser'
import { MarkupEditor } from '../agents/MarkupEditor'
import type { MarkupSize } from '../agents/markup'
import type { ReplyAttach } from '../agents/replyAttach'
import { useDictationOn } from '../state/dictationFeature'
import './browserDraw.css'

/**
 * Draw on the page (ADR-0222): Point at something's other half. The page is captured as it looks now, and that frozen
 * picture stands in its place in Sotto's own mark-up editor (pen, box, arrow, circle, note), with a comment beside it.
 * Nothing goes into the page: the drawing is the window's, on a picture. Add to message hands the marked copy and the
 * comment to `onAdd`, which puts them in the thread's draft; Cancel or Escape puts the live page back.
 *
 * Dictation types into the comment as into any field: its hotkey pastes where the focus is, so the field takes the
 * focus when the editor opens and says so.
 */
export function BrowserDraw({ capture, name, onAdd, onCancel, onAdded }: {
  readonly capture: BrowserCapture
  /** The page's name, as the editor's title says what is being marked up. */
  readonly name: string
  /** Resolves to why nothing was added, or null once the picture and comment are in the draft. */
  readonly onAdd: (image: File, comment: string) => Promise<string | null>
  readonly onCancel: () => void
  readonly onAdded: () => void
}): ReactNode {
  const { t } = useLingui()
  const dictation = useDictationOn()
  const [size, setSize] = useState<MarkupSize | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const commentRef = useRef('')
  commentRef.current = comment
  const field = useRef<HTMLTextAreaElement>(null)
  // The editor draws in the picture's own pixels, read from the picture itself.
  useEffect(() => {
    let current = true
    const picture = new Image()
    picture.decoding = 'async'
    picture.src = capture.image
    void picture.decode().then(() => { if (current) setSize({ width: picture.naturalWidth || capture.width, height: picture.naturalHeight || capture.height }) },
      () => { if (current) setProblem(t`The picture of the page could not be shown. Try again.`) })
    return () => { current = false }
  }, [capture.image, capture.width, capture.height, t])
  // The comment takes the focus first, so speaking fills it; the tools are a Tab away.
  useEffect(() => { if (size) requestAnimationFrame(() => field.current?.focus()) }, [size])
  const reply: ReplyAttach = {
    refusal: () => null,
    add: files => files[0] ? onAdd(files[0], commentRef.current) : Promise.resolve(t`Could not make the marked copy. Nothing was added.`),
    focus: () => undefined,
  }
  const side = <div className="browser-draw__comment">
    <label className="markup-editor__heading" htmlFor="browser-draw-comment">{t({ message: 'Comment', comment: 'Heads the words the user writes for the agent about what they drew on a browser page.' })}</label>
    <textarea ref={field} id="browser-draw-comment" className="tt-focusable" data-markup-own-keys="" value={comment} maxLength={8000}
      placeholder={t`What should the agent know about this?`} aria-describedby={dictation ? 'browser-draw-dictation' : undefined}
      onChange={event => setComment(event.currentTarget.value)} />
    {dictation ? <p id="browser-draw-dictation" className="browser-draw__hint tt-paragraph">{t({ message: 'Dictation types here while this field has the focus.', comment: 'Sotto\'s dictation can fill the comment on a drawing of a browser page.' })}</p> : null}
  </div>
  return <div className="browser-draw" data-covers-native-view>
    {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
    {size ? <MarkupEditor name={name} source={capture.image} size={size} reply={reply} onCancel={onCancel} onAdded={onAdded} side={side}
      addLabel={t`Add to message`} copyNote={t`The marked picture and your comment go into the message. The page stays as it was.`} /> : null}
  </div>
}
