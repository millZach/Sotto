import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Paperclip, X } from 'lucide-react'
import { AGENT_IMAGE_MIME_TYPES, AGENT_MAX_ATTACHMENT_BYTES, AGENT_MAX_ATTACHMENTS, AGENT_MAX_IMAGE_BYTES, agentAttachmentsSchema, attachmentSizeBytes, type AgentAttachment } from '../../../shared/agents'
import { Button } from '../components/Button'
import './screenshots.css'

const TOO_LARGE_IN_TOTAL = 'Screenshots must total 20 MB or less. Remove an image or choose smaller files.'

function checkImage(file: File): void {
  if (!(AGENT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) throw new Error('Choose PNG, JPEG, GIF, or WebP screenshots.')
  if (file.size > AGENT_MAX_IMAGE_BYTES) throw new Error('Each screenshot must be 10 MB or smaller.')
}

function readImage(file: File): Promise<AgentAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read this screenshot. Try selecting it again.'))
    reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name || 'Screenshot.png', mimeType: file.type as AgentAttachment['mimeType'], dataUrl: String(reader.result) })
    reader.readAsDataURL(file)
  })
}

export function ScreenshotInput({ attachments, onChange, disabled, supported, children, onReadingChange }: {
  readonly attachments: AgentAttachment[]
  readonly onChange: (attachments: AgentAttachment[]) => void
  readonly disabled: boolean
  readonly supported: boolean
  readonly children: ReactNode
  readonly onReadingChange?: (reading: boolean) => void
}): ReactNode {
  const picker = useRef<HTMLInputElement>(null)
  const current = useRef(attachments)
  current.current = attachments
  const latestChange = useRef(onChange)
  latestChange.current = onChange
  const reading = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onReadingChange?.(false) } }, [onReadingChange])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async (files: File[]): Promise<void> => {
    if (disabled || reading.current) return
    if (!supported) { setError('This model does not support screenshots. Choose a model with image support.'); return }
    setError(null)
    if (files.length + current.current.length > AGENT_MAX_ATTACHMENTS) { setError(`Attach up to ${AGENT_MAX_ATTACHMENTS} screenshots at a time.`); return }
    // Every refusal that the file sizes alone can decide comes before any file is read and encoded.
    try { files.forEach(checkImage) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read these screenshots.'); return }
    const total = current.current.reduce((sum, item) => sum + attachmentSizeBytes(item.dataUrl), 0) + files.reduce((sum, file) => sum + file.size, 0)
    if (total > AGENT_MAX_ATTACHMENT_BYTES) { setError(TOO_LARGE_IN_TOTAL); return }
    reading.current = true; setBusy(true); onReadingChange?.(true)
    try {
      const images = await Promise.all(files.map(readImage))
      if (!mounted.current) return
      // The schema stays the authority: it checks what was actually read, not what the files claimed.
      const result = agentAttachmentsSchema.safeParse([...current.current, ...images])
      if (!result.success) { setError(TOO_LARGE_IN_TOTAL); return }
      latestChange.current(result.data)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read these screenshots.') }
    finally { if (mounted.current) { reading.current = false; setBusy(false); onReadingChange?.(false) } }
  }
  return <div className="screenshot-input" onPaste={event => {
    const files = [...event.clipboardData.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => file !== null)
    if (files.length) { event.preventDefault(); void add(files) }
  }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => {
    if (event.dataTransfer.files.length) { event.preventDefault(); void add([...event.dataTransfer.files]) }
  }}>
    {children}
    {attachments.length > 0 && <div className="screenshot-previews" aria-label="Attached screenshots">{attachments.map(attachment => <figure key={attachment.id}>
      <img src={attachment.dataUrl} alt={attachment.name} /><figcaption title={attachment.name}>{attachment.name}</figcaption>
      <button type="button" title={`Remove ${attachment.name}`} aria-label={`Remove ${attachment.name}`} disabled={disabled || busy} onClick={() => onChange(current.current.filter(item => item.id !== attachment.id))}><X size={12} /></button>
    </figure>)}</div>}
    <div className="screenshot-input__tools"><input ref={picker} type="file" accept={AGENT_IMAGE_MIME_TYPES.join(',')} multiple aria-label="Screenshot files" hidden onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void add(files) }} />
      <Button type="button" variant="ghost" iconOnly aria-label="Attach screenshots" disabled={disabled || busy || !supported} onClick={() => picker.current?.click()}><Paperclip size={16} /></Button>
      {busy && <small role="status">Adding screenshots...</small>}
      {error && <small className="agent-error" role="alert">{error}</small>}
    </div>
  </div>
}
