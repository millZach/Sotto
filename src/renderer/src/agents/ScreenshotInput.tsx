import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, Paperclip, X } from 'lucide-react'
import { AGENT_IMAGE_MIME_TYPES, AGENT_MAX_ATTACHMENT_BYTES, AGENT_MAX_ATTACHMENTS, AGENT_MAX_ATTACHMENTS_TOTAL_BYTES, AGENT_MAX_FILE_BYTES, AGENT_MAX_IMAGE_BYTES,
  agentAttachmentHandlesSchema, attachmentHandlesBytes, attachmentImagesBytes, attachmentMimeType, isImageAttachment,
  SCREENSHOT_TOO_LARGE, SCREENSHOT_WRONG_TYPE, SCREENSHOTS_TOO_LARGE_IN_TOTAL, type AgentAttachmentDimensions, type AgentAttachmentHandle, type AgentImageSize } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useOwlFeature } from '../state/owlFeature'
import type { ScreenshotReadPort } from './threadDraftStore'
import { prepareScreenshot, wasResized } from './screenshotResize'
import { stageAttachedFile, stageImage, stagingReason, useThumbnail } from './stagedImages'
import { attachmentKind, AttachmentKindIcon, splitAttachmentName } from './attachmentKinds'
import { formatAttachmentSize } from './MessageContent'
import * as words from './attachmentWords'
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
  const lost = remaining === 1 ? 'it was' : `it and the ${remaining - 1} after it were`
  const next = reason?.replace(/ ?Nothing was attached\./u, '').trim() || `Try adding ${remaining === 1 ? 'it' : 'them'} again.`
  return `Could not add ${screenshotName(file)}, so ${lost} not attached. ${next}`
}

/** "3840 x 2160", joined by no-break spaces so a size is never split across the chip's lines, nor "to" from the size after it. */
const shownSize = ({ width, height }: AgentImageSize): string => `${width}\u00a0x\u00a0${height}`

/** "Resized from 3840 by 2160 to 2576 by 1449 pixels": sizes only, for what a screen reader reads. */
function resizedDescription({ original, sent }: AgentAttachmentDimensions): string {
  return `Resized from ${original.width} by ${original.height} to ${sent.width} by ${sent.height} pixels`
}

/** One attached image: its thumbnail, drawn in this window, or a placeholder with its name while the thumbnail is read and when there is none. */
function Chip({ target, attachment, disabled, onRemove, removeLabel }: { readonly target: string | null; readonly attachment: AgentAttachmentHandle; readonly disabled: boolean; readonly onRemove: () => void
  readonly removeLabel?: string }): ReactNode {
  const thumbnail = useThumbnail(target, attachment)
  const remove = removeLabel ?? `Remove ${attachment.name}`
  return <figure>
    {thumbnail ? <img src={thumbnail} alt={attachment.name} /> : <span className="screenshot-previews__placeholder" role="img" aria-label={attachment.name} />}
    <figcaption title={attachment.name}>{attachment.name}</figcaption>
    {wasResized(attachment.dimensions) && <small className="screenshot-previews__resized">
      <span aria-hidden="true">Resized from {shownSize(attachment.dimensions.original)} to&nbsp;{shownSize(attachment.dimensions.sent)}</span>
      <span className="tt-visually-hidden">{resizedDescription(attachment.dimensions)}</span></small>}
    <button type="button" title={remove} aria-label={remove} disabled={disabled} onClick={onRemove}><X size={12} /></button>
  </figure>
}

// Bidirectional overrides can make "gpj.exe" read as "exe.jpg".
const BIDI_CONTROLS = /\p{Bidi_Control}/gu

/**
 * One attached file that is not an image (ADR-0131): its type icon, its name cut in the middle so the extension stays
 * in view, its size, and a button that takes it off the draft.
 */
function FilePill({ attachment, disabled, onRemove }: { readonly attachment: AgentAttachmentHandle; readonly disabled: boolean; readonly onRemove: () => void }): ReactNode {
  const name = attachment.name.replace(BIDI_CONTROLS, '') || attachment.name
  const [head, tail] = splitAttachmentName(name)
  const remove = words.removeAttachment(name)
  return <li className="attached-file">
    <AttachmentKindIcon kind={attachmentKind(name, attachment.mimeType)} size={15} />
    <span className="attached-file__name" title={name}><span className="attached-file__head">{head}</span><span className="attached-file__tail">{tail}</span></span>
    <span className="attached-file__size">{formatAttachmentSize(attachment.sizeBytes)}</span>
    <button type="button" title={remove} aria-label={remove} disabled={disabled} onClick={onRemove}><X size={12} aria-hidden="true" /></button>
  </li>
}

/** A file on its way in, with the type it is staged under and the name it is shown by. */
interface Incoming { readonly file: File; readonly mimeType: string; readonly name: string; readonly image: boolean }

/**
 * Every refusal the files' types and sizes decide once any file can be attached (ADR-0131), in the plan's order, or null
 * when they may be read. `imagesSupported` is whether the thread's model reads images; files go to every model.
 */
function refusalBeforeReading(incoming: readonly Incoming[], current: readonly AgentAttachmentHandle[], imagesSupported: boolean): string | null {
  if (incoming.length + current.length > AGENT_MAX_ATTACHMENTS) return words.attachmentsTooMany()
  const images = incoming.filter(item => item.image)
  if (images.length && !imagesSupported) return words.imagesNotRead(images[0]!.name)
  if (incoming.some(item => !item.image && item.file.size > AGENT_MAX_FILE_BYTES)) return words.fileTooLarge()
  if (images.some(item => item.file.size > AGENT_MAX_IMAGE_BYTES)) return words.imageTooLarge()
  if (attachmentImagesBytes(current) + images.reduce((sum, item) => sum + item.file.size, 0) > AGENT_MAX_ATTACHMENT_BYTES) return words.imagesTooLargeInTotal()
  if (attachmentHandlesBytes(current) + incoming.reduce((sum, item) => sum + item.file.size, 0) > AGENT_MAX_ATTACHMENTS_TOTAL_BYTES) return words.attachmentsTooLargeInTotal()
  return null
}

/** Why a file's staging failed, in staging's own sentence, or null when only the window's plain failure is left. */
function fileStagingReason(cause: unknown): string | null {
  const reason = stagingReason(cause)
  return reason === words.fileStagingFailed() || reason === words.fileReadFailed() ? null : reason
}

/** The same as addFailed, in the interface language, for any attachment. */
function addAnyFailed(item: Incoming, remaining: number, first: boolean, cause: unknown): string {
  const given = item.image ? stagingReason(cause) : fileStagingReason(cause)
  // Main's and a host's English sentences are said in the interface language.
  const reason = given === null ? null : words.attachmentRefusal(given)
  if (first && remaining === 1 && reason) return reason
  return words.addFailedWords(item.name, remaining, reason === null ? null : words.withoutNothingAttached(reason) || null)
}

/**
 * Where screenshots join a draft. Each is scaled to the screenshot bound when it is past it, then staged once, on
 * the host that runs `target` (ADR-0031), and the draft carries its handle; the chips draw their own thumbnails.
 * With `attach-any-file` on (ADR-0131), any file joins it too: images as before, every other file staged with its
 * bytes as they are and shown as a pill under the images.
 */
export function ScreenshotInput({ target, attachments, onChange, disabled, supported, imagesSupported, children, reads }: {
  /** The thread the draft belongs to, or null for the coordinator's composer. */
  readonly target: string | null
  readonly attachments: readonly AgentAttachmentHandle[]
  readonly onChange: (attachments: AgentAttachmentHandle[]) => void
  readonly disabled: boolean
  /** Whether this draft takes attachments at all. With the Owl feature off, only a model that reads images makes it so. */
  readonly supported: boolean
  /** Whether the thread's model reads images; `supported` when absent. Read only once any file can be attached. */
  readonly imagesSupported?: boolean
  readonly children: ReactNode
  /** Reads that may outlive this input, as when the user moves to another thread while screenshots are read. */
  readonly reads?: ScreenshotReadPort
}): ReactNode {
  const anyFile = useOwlFeature('attach-any-file')
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
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  /**
   * Stages one file after another and adds those that were staged. One at a time, so at most one decoded image is held
   * in memory however many are added at once. A failure stops the rest, and those read before it are still added.
   */
  const stageAll = async <T,>(items: readonly T[], stage: (item: T) => Promise<AgentAttachmentHandle>, failed: (item: T, remaining: number, first: boolean, cause: unknown) => string,
    tooLarge: (staged: readonly AgentAttachmentHandle[]) => string): Promise<void> => {
    reading.current = true; setReadingHere(true)
    const handedOn = reads?.begin()
    const images: AgentAttachmentHandle[] = []
    let failure: string | null = null
    for (const [index, item] of items.entries()) {
      try { images.push(await stage(item)) }
      catch (cause) { failure = failed(item, items.length - index, index === 0, cause); break }
    }
    try {
      if (!mounted.current) { latestReads.current?.addLate?.(images, failure); return }
      if (failure) setError(failure)
      if (images.length === 0) return
      // The schema stays the authority: it checks what was actually staged, not what the files claimed.
      const result = agentAttachmentHandlesSchema.safeParse([...current.current, ...images])
      if (!result.success) { setError(tooLarge([...current.current, ...images])); return }
      latestChange.current(result.data)
    } finally {
      handedOn?.()
      if (mounted.current) { reading.current = false; setReadingHere(false) }
    }
  }
  const addScreenshots = async (files: File[]): Promise<void> => {
    if (disabled || reading.current || pending) return
    if (!supported) { setError('This model does not support screenshots. Choose a model with image support.'); return }
    setError(null)
    if (files.length + current.current.length > AGENT_MAX_ATTACHMENTS) { setError(`Attach up to ${AGENT_MAX_ATTACHMENTS} screenshots at a time.`); return }
    // Every refusal that the file sizes alone can decide comes before any file is read and staged.
    try { files.forEach(checkImage) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read these screenshots.'); return }
    const total = attachmentHandlesBytes(current.current) + files.reduce((sum, file) => sum + file.size, 0)
    if (total > AGENT_MAX_ATTACHMENT_BYTES) { setError(SCREENSHOTS_TOO_LARGE_IN_TOTAL); return }
    await stageAll(files, file => stageFile(target, file), addFailed, () => SCREENSHOTS_TOO_LARGE_IN_TOTAL)
  }
  const addAnyFiles = async (files: File[]): Promise<void> => {
    if (disabled || reading.current || pending) return
    if (!supported) { setError(words.noAttachmentsOnAnswer()); return }
    setError(null)
    const incoming = files.map((file): Incoming => {
      const mimeType = attachmentMimeType(file.type)
      const image = isImageAttachment(mimeType)
      return { file, mimeType, image, name: file.name || (image ? 'Screenshot.png' : 'File') }
    })
    // Every refusal that the files' types and sizes alone can decide comes before any file is read and staged.
    const refusal = refusalBeforeReading(incoming, current.current, imagesSupported ?? supported)
    if (refusal) { setError(refusal); return }
    const unread = { failed: words.fileStagingFailed(), unread: words.fileReadFailed() }
    await stageAll(incoming, item => item.image ? stageFile(target, item.file)
      : stageAttachedFile(target, { name: item.name, mimeType: item.mimeType, blob: item.file }, unread), addAnyFailed,
    staged => attachmentImagesBytes(staged) > AGENT_MAX_ATTACHMENT_BYTES ? words.imagesTooLargeInTotal() : words.attachmentsTooLargeInTotal())
  }
  const add = anyFile ? addAnyFiles : addScreenshots
  const remove = (id: string): void => onChange(current.current.filter(item => item.id !== id))
  const images = anyFile ? attachments.filter(attachment => isImageAttachment(attachment.mimeType)) : attachments
  const files = anyFile ? attachments.filter(attachment => !isImageAttachment(attachment.mimeType)) : []
  const endDrag = (): void => { dragDepth.current = 0; setDragging(false) }
  return <div className="screenshot-input" data-dragging={anyFile && dragging ? true : undefined} onPaste={event => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => file !== null)
    if (files.length) { event.preventDefault(); void add(files) }
  }} onDragEnter={anyFile ? event => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault(); dragDepth.current += 1; setDragging(true)
  } : undefined} onDragLeave={anyFile ? () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  } : undefined} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => {
    if (anyFile) endDrag()
    if (event.dataTransfer.files.length) { event.preventDefault(); void add([...event.dataTransfer.files]) }
  }}>
    {children}
    {images.length > 0 && <div className="screenshot-previews" aria-label={anyFile ? words.attachedImages() : 'Attached screenshots'}>{images.map(attachment =>
      <Chip key={attachment.id} target={target} attachment={attachment} disabled={disabled || busy} onRemove={() => remove(attachment.id)}
        {...anyFile ? { removeLabel: words.removeAttachment(attachment.name) } : {}} />)}</div>}
    {files.length > 0 && <ul className="attached-files" aria-label={words.attachedFiles()}>{files.map(attachment =>
      <FilePill key={attachment.id} attachment={attachment} disabled={disabled || busy} onRemove={() => remove(attachment.id)} />)}</ul>}
    <div className="screenshot-input__tools">
      {anyFile
        ? <input ref={picker} type="file" multiple aria-label={words.pickerLabel()} hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void add(files) }} />
        : <input ref={picker} type="file" accept={AGENT_IMAGE_MIME_TYPES.join(',')} multiple aria-label="Screenshot files" hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void add(files) }} />}
      <Button type="button" variant="ghost" iconOnly aria-label={anyFile ? words.attachButton() : 'Attach screenshots'} disabled={disabled || busy || !supported} onClick={() => picker.current?.click()}><Paperclip size={16} /></Button>
      {busy && <small role="status">{anyFile ? words.addingFiles() : 'Adding screenshots...'}</small>}
      {(error ?? reads?.problem) && <small className="agent-error" role="alert">{error ?? reads?.problem}</small>}
    </div>
    {anyFile && dragging && <div className="screenshot-input__drop" role="status"><span><Download size={16} aria-hidden="true" />{words.dropToAttach()}</span></div>}
  </div>
}
