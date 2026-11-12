import React, { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { FilesBridge } from '../../../shared/files'
import { revealLabel } from './FilePreview'
import { fileDownloads, type FileDownloadsStore, type FileDownloadState } from './fileDownloads'

/** One file's download: how it stands, and the press that starts it. Undefined where the file is not on a paired host. */
export interface FileDownloadControl {
  readonly state: FileDownloadState | undefined
  readonly start: () => void
}

/**
 * The download of one file on a paired host to this computer (ADR-0120, November 12 amendment), offered only where the
 * file is on a host and the window can ask for it.
 */
export function useFileDownload(bridge: FilesBridge | undefined, host: string | undefined, threadId: string, path: string, store: FileDownloadsStore = fileDownloads): FileDownloadControl | undefined {
  const state = useSyncExternalStore(store.subscribe, () => store.state(threadId, path))
  const start = useCallback(() => store.start(bridge, threadId, path), [store, bridge, threadId, path])
  return host === undefined || !bridge?.download ? undefined : { state, start }
}

/**
 * The line under a file's head once its download was asked for: how far it is with Stop, then that it was saved with
 * Show in File Explorer and Open, or why nothing was saved. Nothing is drawn before the first press.
 */
export function FileDownloadLine({ bridge, host, threadId, path, platform, store = fileDownloads }: {
  readonly bridge: FilesBridge | undefined
  readonly host: string
  readonly threadId: string
  readonly path: string
  readonly platform?: string | undefined
  readonly store?: FileDownloadsStore
}): ReactNode {
  const { t } = useLingui()
  const state = useSyncExternalStore(store.subscribe, () => store.state(threadId, path))
  const [after, setAfter] = useState<string | null>(null)
  if (!state) return null
  if (state.status === 'going') {
    const percent = state.size > 0 ? Math.min(99, Math.floor(state.received / state.size * 100)) : 0
    return <div className="file-download" role="status">
      <span>{t({ message: `Downloading from ${host}… ${percent}%`, comment: '{host} is the name of a paired host, as in forge; {percent} is a whole number from 0 to 99.' })}</span>
      <progress className="file-download__bar" max={100} value={percent} aria-label={t`Download progress`} />
      <button type="button" className="files-link tt-focusable" onClick={() => store.stop(bridge, threadId, path)}>{t({ message: 'Stop', comment: 'Stops a file download.' })}</button>
    </div>
  }
  if (state.status === 'saved') {
    const { downloadId, name } = state
    const show = (): void => {
      void Promise.resolve().then(() => bridge?.showDownload?.({ downloadId })).then(result => setAfter(result?.ok ? null : result?.error.message ?? t`Sotto could not show this file. Nothing was opened.`), () => setAfter(t`Sotto could not show this file. Nothing was opened.`))
    }
    const open = (): void => {
      void Promise.resolve().then(() => bridge?.openDownload?.({ downloadId })).then(result => setAfter(!result?.ok ? result?.error.message ?? t`Sotto could not open this file. Nothing was opened.`
        : result.value.did === 'shown' ? t({ message: `${name} is a program or script, so it was shown in its folder. Nothing was run.`, comment: '{name} is a file name.' }) : null), () => setAfter(t`Sotto could not open this file. Nothing was opened.`))
    }
    return <div className="file-download" role="status">
      <span className="file-download__words">{after ?? t({ message: `Saved ${name} to Downloads on this computer.`, comment: '{name} is the name a downloaded file was saved under.' })}</span>
      <button type="button" className="files-link tt-focusable" onClick={show}>{revealLabel(platform)}</button>
      <button type="button" className="files-link tt-focusable" onClick={open}>{t({ message: 'Open', comment: 'Opens a downloaded file in its own app.' })}</button>
    </div>
  }
  return <div className="file-download" role="status">
    <span className="file-download__words">{state.status === 'stopped' ? t`Download stopped. Nothing was saved.` : state.message ?? t`Sotto could not download this file. Nothing was saved. Try again.`}</span>
    <button type="button" className="files-link tt-focusable" onClick={() => store.dismiss(threadId, path)}>{t`Dismiss`}</button>
  </div>
}
