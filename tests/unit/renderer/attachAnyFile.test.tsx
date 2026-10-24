import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { i18n } from '@lingui/core'
import { generateMessageId } from '@lingui/message-utils/generateMessageId'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATTACHED_FILE_TOO_LARGE, ATTACHED_IMAGE_TOO_LARGE, ATTACHED_IMAGES_TOO_LARGE_IN_TOTAL, ATTACHMENTS_TOO_LARGE_IN_TOTAL, ATTACHMENTS_TOO_MANY,
  FILE_UPLOAD_INCOMPLETE, HOST_CANNOT_STAGE_FILES, imagesNotReadRefusal, SCREENSHOT_WRONG_TYPE, type AgentAttachmentHandle, type AgentAttachmentStageRequest } from '../../../src/shared/agents'
import { ScreenshotInput } from '../../../src/renderer/src/agents/ScreenshotInput'
import { AttachmentPreviews } from '../../../src/renderer/src/agents/MessageContent'
import { attachmentKind, fileTypeLabel, splitAttachmentName } from '../../../src/renderer/src/agents/attachmentKinds'
import { handleOf } from '../../fixtures/stagedImages'

// Attaching any file is an Owl feature (ADR-0072, ADR-0131); each test says whether this build has it.
const gate = vi.hoisted(() => ({ on: true }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'attach-any-file' && gate.on,
}))

let staged: AgentAttachmentStageRequest[] = []
beforeEach(() => {
  gate.on = true; staged = []
  vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => {
    staged.push(request); return handleOf(request.bytes, crypto.randomUUID(), request.name, request.mimeType)
  }) } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const MB = 1024 * 1024
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const png = (name = 'shot.png') => new File([new Uint8Array(PNG_SIGNATURE)], name, { type: 'image/png' })
const pdf = (name = 'quarterly-report.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' })
/** A file that reports `size` bytes, so a test can cross the limits without allocating them. */
const sized = (file: File, size: number) => Object.defineProperty(file, 'size', { value: size })
const attached = (id: string, mimeType: string, sizeBytes: number, name = id): AgentAttachmentHandle => ({ id, name, mimeType, sizeBytes, digest: 'a'.repeat(64) })

function Harness({ imagesSupported = true, initial = [] }: { imagesSupported?: boolean; initial?: AgentAttachmentHandle[] }) {
  const [items, setItems] = useState<AgentAttachmentHandle[]>(initial)
  return <ScreenshotInput target="workshop" attachments={items} onChange={setItems} disabled={false} supported imagesSupported={imagesSupported}><textarea aria-label="Prompt" /></ScreenshotInput>
}
const pick = (...files: File[]) => fireEvent.change(screen.getByLabelText('Files to attach'), { target: { files } })

describe('attaching any file in the composer (ADR-0131)', () => {
  it('takes any file from the picker, with no accept filter, and stages its bytes as they are', async () => {
    render(<Harness />)
    const picker = screen.getByLabelText('Files to attach')
    expect(picker).not.toHaveAttribute('accept')
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled()
    pick(pdf())
    const pills = await screen.findByRole('list', { name: 'Attached files' })
    expect(within(pills).getByRole('listitem')).toHaveTextContent('quarterly-report.pdf8 B')
    expect(staged).toEqual([expect.objectContaining({ threadId: 'workshop', name: 'quarterly-report.pdf', mimeType: 'application/pdf' })])
    expect(new TextDecoder().decode(staged[0]!.bytes)).toBe('%PDF-1.7')
    fireEvent.click(screen.getByRole('button', { name: 'Remove quarterly-report.pdf' }))
    expect(screen.queryByRole('list', { name: 'Attached files' })).not.toBeInTheDocument()
  })

  it('stages a file the browser gives no type as application/octet-stream', async () => {
    render(<Harness />)
    pick(new File([new Uint8Array([1, 2, 3])], 'firmware', { type: '' }))
    await waitFor(() => expect(staged).toEqual([expect.objectContaining({ name: 'firmware', mimeType: 'application/octet-stream' })]))
  })

  it('takes pasted and dropped files, and shows images as tiles above the file pills', async () => {
    render(<Harness />)
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', getAsFile: () => pdf('notes.pdf') }] } })
    await screen.findByRole('button', { name: 'Remove notes.pdf' })
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [png(), new File(['x'], 'build.zip', { type: 'application/zip' })], types: ['Files'] } })
    await screen.findByRole('button', { name: 'Remove build.zip' })
    const images = screen.getByLabelText('Attached images')
    const files = screen.getByRole('list', { name: 'Attached files' })
    expect(within(images).getByRole('img', { name: 'shot.png' })).toBeVisible()
    expect(within(images).getByRole('button', { name: 'Remove shot.png' })).toBeVisible()
    expect(within(files).getAllByRole('listitem').map(item => item.textContent)).toEqual(['notes.pdf8 B', 'build.zip1 B'])
    expect(images.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(staged.map(item => item.mimeType)).toEqual(['application/pdf', 'image/png', 'application/zip'])
  })

  it('shows a quiet drop outline while files are dragged over it, and clears it on drop or leave', () => {
    render(<Harness />)
    const box = screen.getByRole('textbox')
    fireEvent.dragEnter(box, { dataTransfer: { types: ['Files'], files: [] } })
    expect(screen.getByRole('status')).toHaveTextContent('Drop to attach')
    fireEvent.dragLeave(box, { dataTransfer: { types: ['Files'], files: [] } })
    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument()
    fireEvent.dragEnter(box, { dataTransfer: { types: ['Files'], files: [] } })
    fireEvent.drop(box, { dataTransfer: { types: ['Files'], files: [] } })
    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument()
    // Dragged text is not a file.
    fireEvent.dragEnter(box, { dataTransfer: { types: ['text/plain'], files: [] } })
    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument()
  })

  it.each([
    ['nine files', () => Array.from({ length: 9 }, (_, i) => pdf(`f${i}.pdf`)), [], ATTACHMENTS_TOO_MANY],
    ['nine with those attached', () => [pdf()], Array.from({ length: 8 }, (_, i) => attached(`kept-${i}`, 'text/plain', 1)), ATTACHMENTS_TOO_MANY],
    ['a file over 25 MB', () => [sized(pdf(), 25 * MB + 1)], [], ATTACHED_FILE_TOO_LARGE],
    ['an image over 10 MB', () => [sized(png(), 10 * MB + 1)], [], ATTACHED_IMAGE_TOO_LARGE],
    ['images over 20 MB', () => [sized(png('a.png'), 8 * MB), sized(png('b.png'), 8 * MB)], [attached('kept', 'image/png', 5 * MB)], ATTACHED_IMAGES_TOO_LARGE_IN_TOTAL],
    ['everything over 50 MB', () => [sized(pdf('a.pdf'), 20 * MB), sized(pdf('b.pdf'), 20 * MB)], [attached('kept', 'application/zip', 11 * MB)], ATTACHMENTS_TOO_LARGE_IN_TOTAL],
  ] as const)('refuses %s before reading any of them', (_, files, initial, sentence) => {
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer')
    render(<Harness initial={[...initial]} />)
    pick(...files())
    expect(screen.getByRole('alert')).toHaveTextContent(sentence)
    expect(staged).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('still takes images totalling 20 MB and everything totalling 50 MB', async () => {
    render(<Harness initial={[attached('kept', 'application/zip', 25 * MB)]} />)
    pick(sized(png('a.png'), 10 * MB), sized(png('b.png'), 10 * MB), sized(pdf(), 5 * MB))
    await waitFor(() => expect(staged).toHaveLength(3))
  })

  it('names the image a model that reads none is refused, and takes files on that model', async () => {
    render(<Harness imagesSupported={false} />)
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled()
    pick(pdf(), png('diagram.png'))
    expect(screen.getByRole('alert')).toHaveTextContent(imagesNotReadRefusal('diagram.png'))
    expect(staged).toEqual([])
    pick(pdf())
    await screen.findByRole('button', { name: 'Remove quarterly-report.pdf' })
  })

  it('says why a file could not be kept, in the host\'s own sentence', async () => {
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async () => { throw new Error(`Error invoking remote method 'sotto:agents:stage-attachment': Error: ${HOST_CANNOT_STAGE_FILES}`) }) } })
    render(<Harness />)
    pick(pdf())
    expect(await screen.findByRole('alert')).toHaveTextContent(HOST_CANNOT_STAGE_FILES)
  })

  it('says a host’s refusal in the interface language, not in its English (ADR-0123)', async () => {
    // A stand-in translation; every other message shows in English.
    const translated = {
      [HOST_CANNOT_STAGE_FILES]: 'Dieser Host kann noch keine Dateien behalten. Aktualisiere Sotto dort. Nichts wurde angehängt.',
      [FILE_UPLOAD_INCOMPLETE]: 'Diese Datei kam nicht vollständig an. Nichts wurde angehängt. Hänge sie erneut an.',
      'Nothing was attached.': 'Nichts wurde angehängt.',
      'Could not add {name}, so it and the {after} after it were not attached. {next}': '{name} konnte nicht hinzugefügt werden, {after} weitere auch nicht. {next}',
    }
    i18n.loadAndActivate({ locale: 'de', messages: Object.fromEntries(Object.entries(translated).map(([english, german]) => [generateMessageId(english), german])) })
    try {
      vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async () => { throw new Error(`Error invoking remote method 'sotto:agents:stage-attachment': Error: ${HOST_CANNOT_STAGE_FILES}`) }) } })
      render(<Harness />)
      pick(pdf())
      expect(await screen.findByRole('alert')).toHaveTextContent(translated[HOST_CANNOT_STAGE_FILES])
      cleanup()
      // With others after it, the sentence loses its "Nothing was attached." in the interface language too.
      vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async () => { throw new Error(FILE_UPLOAD_INCOMPLETE) }) } })
      render(<Harness />)
      pick(pdf('a.pdf'), pdf('b.pdf'))
      expect(await screen.findByRole('alert')).toHaveTextContent('a.pdf konnte nicht hinzugefügt werden, 1 weitere auch nicht. Diese Datei kam nicht vollständig an. Hänge sie erneut an.')
      expect(screen.getByRole('alert')).not.toHaveTextContent('Nothing was attached')
    } finally {
      act(() => i18n.activate('en'))
    }
  })

  it('names the file that could not be added, adds the ones before it, and says the rest were not attached', async () => {
    let calls = 0
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => {
      calls += 1
      if (calls === 2) throw new Error('STAGE_FAILED')
      return handleOf(request.bytes, crypto.randomUUID(), request.name, request.mimeType)
    }) } })
    render(<Harness />)
    pick(pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add b.pdf, so it and the 1 after it were not attached. Try adding them again.')
    expect(screen.getByRole('button', { name: 'Remove a.pdf' })).toBeVisible()
  })

  it('cuts a long name in the middle so its extension stays in view, and keeps the whole name for its title', async () => {
    const name = 'a-very-long-quarterly-report-final-version.pdf'
    render(<Harness />)
    pick(pdf(name))
    const button = await screen.findByRole('button', { name: `Remove ${name}` })
    const pill = button.closest('li')!
    expect(pill.querySelector('.attached-file__name')).toHaveAttribute('title', name)
    expect(pill.querySelector('.attached-file__tail')).toHaveTextContent('sion.pdf')
    expect(splitAttachmentName('README')).toEqual(['', 'README'])
    expect(splitAttachmentName('notes')).toEqual(['', 'notes'])
  })

  it('says the plan\'s words while adding, and offers nothing to an answer', () => {
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={vi.fn()} disabled={false} supported={false} imagesSupported
      reads={{ pending: true, problem: null, begin: () => () => undefined }}><textarea aria-label="Prompt" /></ScreenshotInput>)
    expect(screen.getByRole('status')).toHaveTextContent('Adding files...')
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
  })

  it('keeps today\'s screenshot input whole with the Owl feature off', async () => {
    gate.on = false
    render(<Harness />)
    expect(screen.getByLabelText('Screenshot files')).toHaveAttribute('accept', 'image/png,image/jpeg,image/gif,image/webp')
    expect(screen.getByRole('button', { name: 'Attach screenshots' })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [pdf()] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(SCREENSHOT_WRONG_TYPE)
    fireEvent.dragEnter(screen.getByRole('textbox'), { dataTransfer: { types: ['Files'], files: [] } })
    expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument()
    expect(staged).toEqual([])
  })
})

describe('a sent file\'s tile (ADR-0131)', () => {
  const files = [
    { id: 'zip', name: 'build-output.zip', mimeType: 'application/x-zip-compressed', sizeBytes: 3 * MB },
    { id: 'pdf', name: 'quarterly-report.pdf', mimeType: 'application/pdf', sizeBytes: Math.round(2.4 * MB) },
    { id: 'log', name: 'server.log', mimeType: 'text/plain', sizeBytes: 12 * 1024 },
    { id: 'bin', name: 'firmware', mimeType: 'application/octet-stream', sizeBytes: 900 },
    { id: 'png', name: 'shot.png', mimeType: 'image/png', sizeBytes: 2048 },
  ]
  it('names each file\'s type and size, claims no preview, and puts images first', () => {
    render(<AttachmentPreviews attachments={files} />)
    const items = within(screen.getByRole('list', { name: '5 attachments' })).getAllByRole('listitem')
    expect(items.map(item => item.textContent)).toEqual([
      'shot.pngPNG · 2 KB · Preview unavailable',
      'build-output.zipZIP · 3.0 MB',
      'quarterly-report.pdfPDF · 2.4 MB',
      'server.logLOG · 12 KB',
      'firmwareFile · 900 B',
    ])
    expect(screen.queryByText(/No preview for this file type/u)).not.toBeInTheDocument()
  })

  it('shows an SVG, a BMP or a HEIC as a file, never as an image waiting for its preview', () => {
    const others = [
      { id: 'svg', name: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 3 * 1024 },
      { id: 'bmp', name: 'scan.bmp', mimeType: 'image/bmp', sizeBytes: 2 * MB },
      { id: 'heic', name: 'IMG_0001.HEIC', mimeType: 'image/heic', sizeBytes: Math.round(1.5 * MB) },
      { id: 'png', name: 'shot.png', mimeType: 'image/png', sizeBytes: 2048 },
    ]
    render(<AttachmentPreviews attachments={others} />)
    const items = within(screen.getByRole('list', { name: '4 attachments' })).getAllByRole('listitem')
    expect(items.map(item => item.textContent)).toEqual(['shot.pngPNG · 2 KB · Preview unavailable', 'logo.svgSVG · 3 KB', 'scan.bmpBMP · 2.0 MB', 'IMG_0001.HEICHEIC · 1.5 MB'])
    for (const item of items.slice(1)) expect(item).toHaveClass('rich-attachment--file')
  })

  it('keeps today\'s tile with the Owl feature off', () => {
    gate.on = false
    render(<AttachmentPreviews attachments={files.slice(1, 2)} />)
    expect(screen.getByText('quarterly-report.pdf').parentElement).toHaveTextContent('PDF · 2.4 MB · No preview for this file type')
  })

  it('reads a type from the extension when the MIME type is generic, and picks an icon by kind', () => {
    expect(fileTypeLabel('text/plain', 'notes')).toBe('TXT')
    expect(fileTypeLabel('text/plain', 'notes.md')).toBe('MD')
    expect(fileTypeLabel('application/zip', 'site.jar')).toBe('ZIP')
    expect(fileTypeLabel('application/octet-stream', 'disk.img')).toBe('IMG')
    expect(fileTypeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx')).toBe('DOCX')
    expect(fileTypeLabel('application/json', 'data')).toBe('JSON')
    expect(attachmentKind('a.tsx', 'application/octet-stream')).toBe('code')
    expect(attachmentKind('a.tar.gz', 'application/gzip')).toBe('archive')
    expect(attachmentKind('report', 'application/pdf')).toBe('text')
    expect(attachmentKind('blob', 'application/octet-stream')).toBe('file')
    expect(attachmentKind('shot.png', 'image/png')).toBe('image')
  })
})
