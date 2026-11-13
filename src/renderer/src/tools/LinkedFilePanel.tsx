import React, { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { isMarkdownPath, withoutLinkLocation, type FilePreview as FilePreviewValue, type FilesBridge, type FilesError } from '../../../shared/files'
import { writeClipboard } from '../agents/richActions'
import { useOwlFeature } from '../state/owlFeature'
import { FileDownloadLine, useFileDownload } from './FileDownload'
import { FilePreview, type ShownPreview } from './FilePreview'
import type { LinkedFile } from './linkedFile'
import './tools.css'

function windowFiles(): FilesBridge | undefined {
  return (window.sotto as { files?: FilesBridge } | undefined)?.files
}

type Read = { readonly status: 'loading' } | { readonly status: 'ready'; readonly file: Pick<FilePreviewValue, 'size' | 'content'> } | { readonly status: 'error'; readonly error: FilesError }

/**
 * A file a message linked, read only: Files' own preview, read through the link's channel on the machine the thread runs
 * on. A Markdown file anywhere (ADR-0120, November 3 amendment), and any other file on a paired host that Files' tree does
 * not hold, shown alone with its whole path (November 12 amendment). Tools > Files shows it on the Threads page, and the
 * beside pane's place shows it in Watcher's room. On a host its head offers Download. A link inside the file runs
 * nothing, since this panel is outside any thread's links.
 */
export function LinkedFilePanel({ file, host, backTo, onClose, bridge = windowFiles() }: {
  readonly file: LinkedFile
  /** The paired host's name for a thread on one; its folder is on that machine, so there is no folder to show here. */
  readonly host?: string | undefined
  /** The thread that waits behind the file, which closing brings back. */
  readonly backTo?: string | undefined
  readonly onClose: () => void
  readonly bridge?: FilesBridge | undefined
}): ReactNode {
  const { t } = useLingui()
  const revealLinks = useOwlFeature('reveal-linked-files')
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [again, setAgain] = useState(0)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [notice, setNotice] = useState<string | null>(null)
  const scroll = useRef(0)
  const { threadId, path, revision } = file
  const markdown = isMarkdownPath(path)
  const download = useFileDownload(bridge, host, threadId, path)
  useEffect(() => {
    let live = true
    setRead(current => current.status === 'ready' ? current : { status: 'loading' })
    const unavailable = (message: string): void => { if (live) setRead({ status: 'error', error: { code: 'unavailable', message } }) }
    // A Markdown file is read as it always was, which a host from before November 12 answers too; any other file as Files previews one.
    const reading = markdown ? bridge?.previewLink && (() => bridge.previewLink!({ threadId, path }).then(result => result.ok ? { ok: true as const, value: { size: result.value.size, content: { kind: 'markdown' as const, text: result.value.text } } } : result))
      : bridge?.linkedFile && (() => bridge.linkedFile!({ threadId, path, want: 'preview' }).then(result => !result.ok ? result : result.value.is === 'preview' ? { ok: true as const, value: { size: result.value.size, content: result.value.content } }
        : { ok: false as const, error: { code: 'unavailable' as const, message: '' } }))
    if (!reading) { unavailable(t`Sotto cannot read this file from here. Nothing was opened.`); return () => { live = false } }
    // Through a promise, so a bridge that refuses by throwing says so here rather than taking the window down.
    void Promise.resolve().then(reading).then(result => {
      if (live) setRead(result.ok ? { status: 'ready', file: result.value } : { status: 'error', error: result.error })
    }, () => unavailable(t`Sotto could not read this file. Nothing was opened. Try again.`))
    return () => { live = false }
  // `t` follows the language and does not change which file is read.
  }, [bridge, threadId, path, revision, again, markdown])
  const shownPath = withoutLinkLocation(path)
  const preview: ShownPreview = read.status === 'loading' ? { status: 'loading', path: shownPath }
    : read.status === 'error' ? { status: 'error', path: shownPath, error: read.error }
      : { status: 'ready', path: shownPath, preview: read.file }
  const downloadLine = download?.state && host !== undefined ? <FileDownloadLine bridge={bridge} host={host} threadId={threadId} path={path} platform={(window.sotto as { platform?: string } | undefined)?.platform} /> : null
  const copyPath = useCallback((): void => {
    void writeClipboard(path).then(() => setNotice(t`Path copied.`), () => setNotice(t`Could not copy the path.`))
  }, [path, t])
  const reveal = !host && revealLinks && bridge?.revealLink ? (): void => {
    void Promise.resolve().then(() => bridge.revealLink!({ threadId, path })).then(result => setNotice(result.ok ? null : result.error.message), () => setNotice(t`Sotto could not show this file. Nothing was opened.`))
  } : undefined
  const readAgain = (): void => { setNotice(null); setAgain(value => value + 1) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }
  return <div className="linked-file" onKeyDown={onKeyDown}>
    <FilePreview files={{ markdownView: view }} preview={preview} platform={(window.sotto as { platform?: string } | undefined)?.platform}
      scrollTop={scroll.current} onScroll={top => { scroll.current = top }} onCopyPath={copyPath} onReveal={reveal} onDownload={download?.start} downloading={download?.busy} onClose={onClose} onRetry={readAgain}
      onRefreshFolder={readAgain} onMarkdownView={setView} onReadAgain={readAgain} takesFocus
      place={host === undefined ? undefined : t({ message: `on ${host}`, comment: '{host} is the name of a paired host, as in forge.' })}
      problem={error => <LinkedFileProblem error={error} markdown={markdown} downloads={download !== undefined} onRetry={readAgain} />}
      under={backTo === undefined && notice === null && host === undefined && downloadLine === null ? undefined : <>
        {backTo !== undefined ? <div className="linked-file__back"><button type="button" className="linked-file__back-button tt-focusable" onClick={onClose}>{t({ message: `Back to ${backTo}`, comment: '{backTo} is a thread\'s title. Closes a Markdown file to show that thread again.' })}</button></div> : null}
        {downloadLine}
        {/* On a paired host no folder on this computer says where the file is, so its path as the link wrote it stands here. */}
        {host === undefined ? null : <p className="linked-file__path">{shownPath}</p>}
        {notice !== null ? <p className="linked-file__notice" role="status">{notice}</p> : null}
      </>} />
  </div>
}

/**
 * Why a file was not read. The service, which also runs on a paired host, answers in English, so each known refusal is said
 * here in the interface's language; what could not be reached says why in main's own words, which are already translated.
 */
function LinkedFileProblem({ error, markdown, downloads, onRetry }: { readonly error: FilesError; readonly markdown: boolean; readonly downloads: boolean; readonly onRetry: () => void }): ReactNode {
  const { t } = useLingui()
  // A file Files has no preview for is not a failure: it is there, and on a host it can still be downloaded.
  if (!markdown && (error.code === 'binary' || error.code === 'too-large')) return <div className="files-problem" role="status">
    <strong>{error.code === 'binary' ? t`No preview for this file.` : t`Too large to preview.`}</strong>
    <p className="tt-paragraph">{downloads ? t`Text, Markdown and PNG, JPEG, GIF or WebP images preview here. Download it to open it on this computer.` : t`Text, Markdown and PNG, JPEG, GIF or WebP images preview here.`}</p>
  </div>
  const words = (): string => {
    switch (error.code) {
      case 'path-unavailable': return t`This file is not on the computer this thread runs on, or it has moved. Nothing was opened.`
      case 'path-outside-workspace': return t`This link points outside the thread’s folder. Nothing was opened.`
      case 'not-file': return t`This link is not a file. Nothing was opened.`
      case 'invalid-request': return markdown ? t`This link does not lead to a Markdown file. Nothing was opened.` : t`This link is not a file path. Nothing was opened.`
      case 'too-large': return t`Markdown files open here up to 512 KB. Nothing was opened.`
      case 'binary': return t`This file is not text, so it cannot be read here. Nothing was opened.`
      default: return error.message || t`This file could not be read. Nothing was opened.`
    }
  }
  return <div className="files-problem" role="status">
    <strong>{words()}</strong>
    <button type="button" className="files-link tt-focusable" onClick={onRetry}>{t`Read again`}</button>
  </div>
}
