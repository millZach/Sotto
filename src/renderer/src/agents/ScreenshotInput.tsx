import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Paperclip, X } from 'lucide-react'
import { plural, t } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { AGENT_IMAGE_MIME_TYPES, AGENT_MAX_ATTACHMENT_BYTES, AGENT_MAX_ATTACHMENTS, AGENT_MAX_IMAGE_BYTES, agentAttachmentHandlesSchema, attachmentHandlesBytes,
  SCREENSHOT_TOO_LARGE, SCREENSHOT_WRONG_TYPE, SCREENSHOTS_TOO_LARGE_IN_TOTAL, type AgentAttachmentDimensions, type AgentAttachmentHandle, type AgentImageSize } from '../../../shared/agents'
import { Button } from '../components/Button'
import type { ScreenshotReadPort } from './threadDraftStore'
import { prepareScreenshot, wasResized } from './screenshotResize'
import { stageImage, stagingReason, useThumbnail } from './stagedImages'
import './screenshots.css'

// The refusals a file's own type and size decide, checked before anything is read.
function checkImage(file: File): void {
  if (!(AGENT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) throw new Error(SCREENSHOT_WRONG_TYPE)
  if (file.size > AGENT_MAX_IMAGE_BYTES) throw new Error(SCREENSHOT_TOO_LARGE)
}

/** Scales a screenshot past the bound down in its own format (ADR-0030), then stages what is sent (ADR-0031). */
async function stageFile(target: string | null, file: File): Promise<AgentAttachmentHandle> {
  return stageImage(target, { name: screenshotName(file), mimeType: file.type, ...await prepareScreenshot(file) })
}

const screenshotName = (file: File): string => file.name || 'Screenshot.png'

/**
 * What a failed add says: which screenshot could not be added, that it and those after it were not attached, and
 * why, when staging gave a reason of its own. Those before it were attached, and their chips show it. When it was
 * the only screenshot, staging's own reason already says all of that.
 */
function addFailed(file: File, remaining: number, first: boolean, cause: unknown): string {
  const reason = stagingReason(cause)
  if (first && remaining === 1 && reason) return reason
  // Main's reasons are English sentences; the one it adds about nothing being attached is said here already.
  const next = reason?.replace(/ ?Nothing was attached\./u, '').trim() || plural(remaining, { one: 'Try adding it again.', other: 'Try adding them again.' })
  const name = screenshotName(file)
  const after = remaining - 1
  if (after === 0) return t({ message: `Could not add ${name}, so it was not attached. ${next}`, comment: '{next} is why, or what to do next.' })
  return plural(after, {
    one: `Could not add ${name}, so it and the # after it were not attached. ${next}`,
    other: `Could not add ${name}, so it and the # after it were not attached. ${next}`,
  })
}

/** "3840 x 2160", joined by no-break spaces so a size is never split across the chip's lines, nor "to" from the size after it. */
const shownSize = ({ width, height }: AgentImageSize): string => `${width}\u00a0x\u00a0${height}`

/** "Resized from 3840 by 2160 to 2576 by 1449 pixels": sizes only, for what a screen reader reads. */
function resizedDescription({ original, sent }: AgentAttachmentDimensions): string {
  return t`Resized from ${{ fromWidth: original.width }} by ${{ fromHeight: original.height }} to ${{ toWidth: sent.width }} by ${{ toHeight: sent.height }} pixels`
}

/** One attached image: its thumbnail, drawn in this window, or a placeholder with its name while the thumbnail is read and when there is none. */
function Chip({ target, attachment, disabled, onRemove }: { readonly target: string | null; readonly attachment: AgentAttachmentHandle; readonly disabled: boolean; readonly onRemove: () => void }): ReactNode {
  const { t } = useLingui()
  const thumbnail = useThumbnail(target, attachment)
  const name = attachment.name
  const dimensions = wasResized(attachment.dimensions) ? attachment.dimensions : undefined
  const from = dimensions === undefined ? '' : shownSize(dimensions.original)
  const to = dimensions === undefined ? '' : shownSize(dimensions.sent)
  return <figure>
    {thumbnail ? <img src={thumbnail} alt={attachment.name} /> : <span className="screenshot-previews__placeholder" role="img" aria-label={attachment.name} />}
    <figcaption title={attachment.name}>{attachment.name}</figcaption>
    {dimensions !== undefined && <small className="screenshot-previews__resized">
      <span aria-hidden="true"><Trans>Resized from {from} to&nbsp;{to}</Trans></span>
      <span className="tt-visually-hidden">{resizedDescription(dimensions)}</span></small>}
    <button type="button" title={t`Remove ${name}`} aria-label={t`Remove ${name}`} disabled={disabled} onClick={onRemove}><X size={12} /></button>
  </figure>
}

/**
 * Where screenshots join a draft. Each is scaled to the screenshot bound when it is past it, then staged once, on
 * the host that runs `target` (ADR-0031), and the draft carries its handle; the chips draw their own thumbnails.
 */
export function ScreenshotInput({ target, attachments, onChange, disabled, supported, children, reads }: {
  /** The thread the draft belongs to, or null for the coordinator's composer. */
  readonly target: string | null
  readonly attachments: readonly AgentAttachmentHandle[]
  readonly onChange: (attachments: AgentAttachmentHandle[]) => void
  readonly disabled: boolean
  readonly supported: boolean
  readonly children: ReactNode
  /** Reads that may outlive this input, as when the user moves to another thread while screenshots are read. */
  readonly reads?: ScreenshotReadPort
}): ReactNode {
  const { t } = useLingui()
  const picker = useRef<HTMLInputElement>(null)
  const current = useRef(attachments)
  current.current = attachments
  const latestChange = useRef(onChange)
  latestChange.current = onChange
  const latestReads = useRef(reads)
  latestReads.current = reads
  const reading = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [readingHere, setReadingHere] = useState(false)
  const pending = reads?.pending ?? false
  const busy = readingHere || pending
  const [error, setError] = useState<string | null>(null)
  const add = async (files: File[]): Promise<void> => {
    if (disabled || reading.current || pending) return
    if (!supported) { setError(t`This model does not support screenshots. Choose a model with image support.`); return }
    setError(null)
    const most = AGENT_MAX_ATTACHMENTS
    if (files.length + current.current.length > most) { setError(plural(most, { one: 'Attach up to # screenshot at a time.', other: 'Attach up to # screenshots at a time.' })); return }
    // Every refusal that the file sizes alone can decide comes before any file is read and staged.
    try { files.forEach(checkImage) } catch (cause) { setError(cause instanceof Error ? cause.message : t`Could not read these screenshots.`); return }
    const total = attachmentHandlesBytes(current.current) + files.reduce((sum, file) => sum + file.size, 0)
    if (total > AGENT_MAX_ATTACHMENT_BYTES) { setError(SCREENSHOTS_TOO_LARGE_IN_TOTAL); return }
    reading.current = true; setReadingHere(true)
    const handedOn = reads?.begin()
    // One at a time, so at most one decoded image is held in memory however many are added at once. A failure
    // stops the rest, and those read before it are still added.
    const images: AgentAttachmentHandle[] = []
    let failure: string | null = null
    for (const [index, file] of files.entries()) {
      try { images.push(await stageFile(target, file)) }
      catch (cause) { failure = addFailed(file, files.length - index, index === 0, cause); break }
    }
    try {
      if (!mounted.current) { latestReads.current?.addLate?.(images, failure); return }
      if (failure) setError(failure)
      if (images.length === 0) return
      // The schema stays the authority: it checks what was actually staged, not what the files claimed.
      const result = agentAttachmentHandlesSchema.safeParse([...current.current, ...images])
      if (!result.success) { setError(SCREENSHOTS_TOO_LARGE_IN_TOTAL); return }
      latestChange.current(result.data)
    } finally {
      handedOn?.()
      if (mounted.current) { reading.current = false; setReadingHere(false) }
    }
  }
  return <div className="screenshot-input" onPaste={event => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => file !== null)
    if (files.length) { event.preventDefault(); void add(files) }
  }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => {
    if (event.dataTransfer.files.length) { event.preventDefault(); void add([...event.dataTransfer.files]) }
  }}>
    {children}
    {attachments.length > 0 && <div className="screenshot-previews" aria-label={t`Attached screenshots`}>{attachments.map(attachment =>
      <Chip key={attachment.id} target={target} attachment={attachment} disabled={disabled || busy}
        onRemove={() => onChange(current.current.filter(item => item.id !== attachment.id))} />)}</div>}
    <div className="screenshot-input__tools"><input ref={picker} type="file" accept={AGENT_IMAGE_MIME_TYPES.join(',')} multiple aria-label={t`Screenshot files`} hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void add(files) }} />
      <Button type="button" variant="ghost" iconOnly aria-label={t`Attach screenshots`} disabled={disabled || busy || !supported} onClick={() => picker.current?.click()}><Paperclip size={16} /></Button>
      {busy && <small role="status"><Trans>Adding screenshots...</Trans></small>}
      {(error ?? reads?.problem) && <small className="agent-error" role="alert">{error ?? reads?.problem}</small>}
    </div>
  </div>
}
