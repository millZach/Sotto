import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, FolderOutput, WrapText, X } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
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
  if (platform === 'linux') return i18n._(msg`Show in file manager`)
  return platform === 'darwin' ? i18n._(msg`Show in Finder`) : i18n._(msg`Show in File Explorer`)
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
  /** Absent for a thread on a paired host: its file is on that machine, so there is no folder to show here. */
  readonly onReveal?: (() => void) | undefined
  readonly onClose: () => void
  readonly onRetry: () => void
  readonly onRefreshFolder: () => void
  readonly onMarkdownView: (view: ThreadFiles['markdownView']) => void
  readonly platform?: string | undefined
}

function PreviewProblem({ error, onRetry, onRefreshFolder }: { error: FilesError; onRetry: () => void; onRefreshFolder: () => void }): ReactNode {
  const { t } = useLingui()
  switch (error.code) {
    case 'binary':
      return <div className="files-problem" role="status"><strong>{t`No preview for this file.`}</strong><p className="tt-paragraph">{t`Text, Markdown and PNG, JPEG, GIF or WebP images preview here.`}</p></div>
    case 'too-large':
      return <div className="files-problem" role="status"><strong>{t`Too large to preview.`}</strong><p className="tt-paragraph">{error.message || t`Text previews up to 512 KB and images up to 8 MB.`}</p></div>
    case 'path-unavailable':
    case 'not-file':
      return <div className="files-problem" role="status"><strong>{t`This file is no longer here.`}</strong><button type="button" className="files-link tt-focusable" onClick={onRefreshFolder}>{t`Refresh folder`}</button></div>
    case 'path-outside-workspace':
      return <div className="files-problem" role="status"><strong>{t`This file points outside the working folder.`}</strong></div>
    default:
      return <div className="files-problem" role="status"><strong>{t`The preview could not load.`}</strong><button type="button" className="files-link tt-focusable" onClick={onRetry}>{t`Retry`}</button></div>
  }
}

/** The open file: text as text, Markdown through the transcript's safe renderer, rasters from main's data URL. */
export function FilePreview({ files, preview, scrollTop, onScroll, onCopyPath, onReveal, onClose, onRetry, onRefreshFolder, onMarkdownView, platform }: FilePreviewProps): ReactNode {
  const { t } = useLingui()
  const body = useRef<HTMLDivElement>(null)
  const [wrap, setWrap] = useState(true)
  const ready = preview.status === 'ready' ? preview.preview : null
  const markdown = ready?.content.kind === 'markdown'
  const renderable = markdown && ready.content.kind === 'markdown' && ready.content.text.length <= MAX_RENDERED_MARKDOWN_LENGTH
  const rendered = renderable && files.markdownView === 'rendered'
  const name = fileName(preview.path)
  const size = ready ? formatAttachmentSize(ready.size) : null
  const reveal = revealLabel(platform)

  useLayoutEffect(() => {
    if (body.current && preview.status === 'ready') body.current.scrollTop = scrollTop
    // Restore only when a preview arrives, not while the reader scrolls.
  }, [preview.status, preview.path])

  let content: ReactNode
  if (preview.status === 'loading') content = <p className="files-preview__loading" role="status">{t`Loading…`}</p>
  else if (preview.status === 'error') content = <PreviewProblem error={preview.error} onRetry={onRetry} onRefreshFolder={onRefreshFolder} />
  else if (ready!.content.kind === 'image') {
    const source = trustedImageSource(ready!.content)
    content = source
      ? <div className="files-preview__image"><img src={source} alt={name} draggable={false} decoding="async" /></div>
      : <PreviewProblem error={{ code: 'binary', message: '' }} onRetry={onRetry} onRefreshFolder={onRefreshFolder} />
  } else if (rendered) content = <div className="files-preview__markdown"><MessageContent text={ready!.content.text} /></div>
  else content = <>
    {markdown && !renderable ? <p className="files-preview__note tt-paragraph">{t`Long Markdown is shown as source.`}</p> : null}
    <pre className="files-preview__text" data-wrap={wrap} tabIndex={0} aria-label={t({ message: `${name} contents`, comment: '{name} is a file name.' })}>{ready!.content.text}</pre>
  </>

  // One line over the open file: its name, size and that it is read only, then its own actions. The wrap switch
  // sits here too, as an icon the size of the others, so no second bar under the file competes with the panel's
  // footer and the head stays one line in the narrowest panel.
  return <section className="files-preview" aria-label={t`Preview of ${name}`}>
    <header className="files-preview__head">
      <div className="files-preview__title" title={preview.path}>
        <span className="files-preview__name">{name}</span>
        <span className="files-preview__meta">{size ? t({ message: `${size} · Read only`, comment: '{size} is a file size, as in "12 KB".' }) : t`Read only`}</span>
      </div>
      <div className="files-preview__actions">
        {renderable ? <button type="button" className="files-toggle tt-focusable" aria-pressed={!rendered} onClick={() => onMarkdownView(rendered ? 'source' : 'rendered')}>{t({ message: 'Source', comment: 'Shows a Markdown file as its source text rather than rendered.' })}</button> : null}
        {ready && ready.content.kind !== 'image' && !rendered ? <button type="button" className="files-icon tt-focusable" aria-label={t`Wrap lines`} title={wrap ? t`Wrap lines: on` : t`Wrap lines: off`} aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={16} aria-hidden="true" /></button> : null}
        <button type="button" className="files-icon tt-focusable" aria-label={t`Copy path of ${name}`} title={t`Copy path`} onClick={onCopyPath}><Copy size={16} aria-hidden="true" /></button>
        {onReveal ? <button type="button" className="files-icon tt-focusable" aria-label={t({ message: `${reveal}: ${name}`, comment: '{reveal} is "Show in File Explorer" or the like; {name} is a file name.' })} title={reveal} onClick={onReveal}><FolderOutput size={16} aria-hidden="true" /></button> : null}
        <button type="button" className="files-icon tt-focusable" aria-label={t`Close preview`} title={t`Close preview`} onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>
    </header>
    <div ref={body} className="files-preview__body" data-kind={ready?.content.kind} onScroll={event => onScroll(event.currentTarget.scrollTop)}>{content}</div>
  </section>
}
