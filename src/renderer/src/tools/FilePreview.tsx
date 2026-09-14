import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, FolderOutput, X } from 'lucide-react'
import type { FilePreview as FilePreviewValue, FilesError } from '../../../shared/files'
import { MessageContent, formatAttachmentSize } from '../agents/MessageContent'
import type { PreviewState, ThreadFiles } from './filesBrowser'

/** Markdown beyond this is shown as source: the rendered view of a huge document would stall the panel. */
export const MAX_RENDERED_MARKDOWN_LENGTH = 200_000
const RASTER = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/u

/** The preview's image source only when it is the raster data URL main produced for the named type. */
export function trustedImageSource(content: FilePreviewValue['content']): string | null {
  if (content.kind !== 'image') return null
  const match = RASTER.exec(content.dataUrl)
  return match && `image/${match[1]}` === content.mime ? content.dataUrl : null
}

export function revealLabel(platform: string | undefined): string {
  return platform === 'darwin' ? 'Show in Finder' : 'Show in File Explorer'
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export interface FilePreviewProps {
  readonly files: ThreadFiles
  readonly preview: PreviewState
  readonly scrollTop: number
  readonly onScroll: (top: number) => void
  readonly onCopyPath: () => void
  readonly onReveal: () => void
  readonly onClose: () => void
  readonly onRetry: () => void
  readonly onRefreshFolder: () => void
  readonly onMarkdownView: (view: ThreadFiles['markdownView']) => void
  readonly platform?: string | undefined
}

function PreviewProblem({ error, onRetry, onRefreshFolder }: { error: FilesError; onRetry: () => void; onRefreshFolder: () => void }): ReactNode {
  switch (error.code) {
    case 'binary':
      return <div className="files-problem" role="status"><strong>No preview for this file.</strong><p>Text, Markdown and PNG, JPEG, GIF or WebP images preview here.</p></div>
    case 'too-large':
      return <div className="files-problem" role="status"><strong>Too large to preview.</strong><p>{error.message || 'Text previews up to 512 KB and images up to 8 MB.'}</p></div>
    case 'path-unavailable':
    case 'not-file':
      return <div className="files-problem" role="status"><strong>This file is no longer here.</strong><button type="button" className="files-link tt-focusable" onClick={onRefreshFolder}>Refresh folder</button></div>
    case 'path-outside-workspace':
      return <div className="files-problem" role="status"><strong>This file points outside the working folder.</strong></div>
    default:
      return <div className="files-problem" role="status"><strong>The preview could not load.</strong><button type="button" className="files-link tt-focusable" onClick={onRetry}>Retry</button></div>
  }
}

/** The open file: text as text, Markdown through the transcript's safe renderer, rasters from main's data URL. */
export function FilePreview({ files, preview, scrollTop, onScroll, onCopyPath, onReveal, onClose, onRetry, onRefreshFolder, onMarkdownView, platform }: FilePreviewProps): ReactNode {
  const body = useRef<HTMLDivElement>(null)
  const [wrap, setWrap] = useState(true)
  const ready = preview.status === 'ready' ? preview.preview : null
  const markdown = ready?.content.kind === 'markdown'
  const renderable = markdown && ready.content.kind === 'markdown' && ready.content.text.length <= MAX_RENDERED_MARKDOWN_LENGTH
  const rendered = renderable && files.markdownView === 'rendered'
  const name = fileName(preview.path)
  const size = ready ? formatAttachmentSize(ready.size) : null

  useLayoutEffect(() => {
    if (body.current && preview.status === 'ready') body.current.scrollTop = scrollTop
    // Restore only when a preview arrives, not while the reader scrolls.
  }, [preview.status, preview.path])

  let content: ReactNode
  if (preview.status === 'loading') content = <p className="files-preview__loading" role="status">Loading…</p>
  else if (preview.status === 'error') content = <PreviewProblem error={preview.error} onRetry={onRetry} onRefreshFolder={onRefreshFolder} />
  else if (ready!.content.kind === 'image') {
    const source = trustedImageSource(ready!.content)
    content = source
      ? <div className="files-preview__image"><img src={source} alt={name} draggable={false} decoding="async" /></div>
      : <PreviewProblem error={{ code: 'binary', message: '' }} onRetry={onRetry} onRefreshFolder={onRefreshFolder} />
  } else if (rendered) content = <div className="files-preview__markdown"><MessageContent text={ready!.content.text} /></div>
  else content = <>
    {markdown && !renderable ? <p className="files-preview__note">Long Markdown is shown as source.</p> : null}
    <pre className="files-preview__text" data-wrap={wrap} tabIndex={0} aria-label={`${name} contents`}>{ready!.content.text}</pre>
  </>

  return <section className="files-preview" aria-label={`Preview of ${name}`}>
    <header className="files-preview__head">
      <div className="files-preview__title" title={preview.path}>
        <span className="files-preview__name">{name}</span>
        {size ? <span className="files-preview__meta">{size}</span> : null}
      </div>
      <div className="files-preview__actions">
        {renderable ? <button type="button" className="files-toggle tt-focusable" aria-pressed={!rendered} onClick={() => onMarkdownView(rendered ? 'source' : 'rendered')}>Source</button> : null}
        <button type="button" className="files-icon tt-focusable" aria-label={`Copy path of ${name}`} title="Copy path" onClick={onCopyPath}><Copy size={16} aria-hidden="true" /></button>
        <button type="button" className="files-icon tt-focusable" aria-label={`${revealLabel(platform)}: ${name}`} title={revealLabel(platform)} onClick={onReveal}><FolderOutput size={16} aria-hidden="true" /></button>
        <button type="button" className="files-icon tt-focusable" aria-label="Close preview" title="Close preview" onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>
    </header>
    <div ref={body} className="files-preview__body" data-kind={ready?.content.kind} onScroll={event => onScroll(event.currentTarget.scrollTop)}>{content}</div>
    <div className="files-preview__status">
      <span>Read only</span>
      {ready && ready.content.kind !== 'image' && !rendered ? <button type="button" className="files-toggle tt-focusable" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>Wrap lines</button> : null}
    </div>
  </section>
}
