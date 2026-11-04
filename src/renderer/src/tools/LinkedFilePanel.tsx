import React, { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { withoutLinkLocation, type FileLinkPreview, type FilesBridge, type FilesError } from '../../../shared/files'
import { writeClipboard } from '../agents/richActions'
import { useOwlFeature } from '../state/owlFeature'
import { FilePreview, type ShownPreview } from './FilePreview'
import type { LinkedFile } from './linkedFile'
import './tools.css'

function windowFiles(): FilesBridge | undefined {
  return (window.sotto as { files?: FilesBridge } | undefined)?.files
}

type Read = { readonly status: 'loading' } | { readonly status: 'ready'; readonly file: FileLinkPreview } | { readonly status: 'error'; readonly error: FilesError }

/**
 * A Markdown file a message linked, read only (ADR-0120, November 3 amendment): Files' own preview, read through the link's
 * channel on the machine the thread runs on. Tools > Files shows it on the Threads page, and the beside pane's place shows
 * it in Watcher's room. A link inside the file runs nothing, since this panel is outside any thread's links.
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
  useEffect(() => {
    let live = true
    setRead(current => current.status === 'ready' ? current : { status: 'loading' })
    const unavailable = (message: string): void => { if (live) setRead({ status: 'error', error: { code: 'unavailable', message } }) }
    const previewLink = bridge?.previewLink
    if (!previewLink) { unavailable(t`Sotto cannot read this file from here. Nothing was opened.`); return () => { live = false } }
    // Through a promise, so a bridge that refuses by throwing says so here rather than taking the window down.
    void Promise.resolve().then(() => previewLink.call(bridge, { threadId, path })).then(result => {
      if (live) setRead(result.ok ? { status: 'ready', file: result.value } : { status: 'error', error: result.error })
    }, () => unavailable(t`Sotto could not read this file. Nothing was opened. Try again.`))
    return () => { live = false }
  // `t` follows the language and does not change which file is read.
  }, [bridge, threadId, path, revision, again])
  const shownPath = withoutLinkLocation(path)
  const preview: ShownPreview = read.status === 'loading' ? { status: 'loading', path: shownPath }
    : read.status === 'error' ? { status: 'error', path: shownPath, error: read.error }
      : { status: 'ready', path: shownPath, preview: { size: read.file.size, content: { kind: 'markdown', text: read.file.text } } }
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
      scrollTop={scroll.current} onScroll={top => { scroll.current = top }} onCopyPath={copyPath} onReveal={reveal} onClose={onClose} onRetry={readAgain}
      onRefreshFolder={readAgain} onMarkdownView={setView} onReadAgain={readAgain} takesFocus
      place={host === undefined ? undefined : t({ message: `on ${host}`, comment: '{host} is the name of a paired host, as in forge.' })}
      problem={error => <LinkedFileProblem error={error} onRetry={readAgain} />}
      under={backTo === undefined && notice === null ? undefined : <>
        {backTo !== undefined ? <div className="linked-file__back"><button type="button" className="linked-file__back-button tt-focusable" onClick={onClose}>{t({ message: `Back to ${backTo}`, comment: '{backTo} is a thread\'s title. Closes a Markdown file to show that thread again.' })}</button></div> : null}
        {notice !== null ? <p className="linked-file__notice" role="status">{notice}</p> : null}
      </>} />
  </div>
}

/** What main said about a file it would not read, in its own words: a link can fail in more ways than a file in the tree. */
function LinkedFileProblem({ error, onRetry }: { readonly error: FilesError; readonly onRetry: () => void }): ReactNode {
  const { t } = useLingui()
  return <div className="files-problem" role="status">
    <strong>{error.message || t`This file could not be read. Nothing was opened.`}</strong>
    <button type="button" className="files-link tt-focusable" onClick={onRetry}>{t`Read again`}</button>
  </div>
}
