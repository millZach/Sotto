import React, { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { RotateCw, X } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { FilesBridge, FilesError } from '../../../shared/files'
import { FilePreview } from './FilePreview'
import { FileTree } from './FileTree'
import { ToolsChrome } from './ToolsChrome'
import { type FilesBrowserStore, type PathAction, type ThreadFiles } from './filesBrowser'

export function useThreadFiles(store: FilesBrowserStore, threadId: string | null): ThreadFiles | undefined {
  const read = useCallback(() => threadId === null ? undefined : store.thread(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}

function RootProblem({ error, bridge, onRetry }: { error: FilesError; bridge: boolean; onRetry: () => void }): ReactNode {
  const { t } = useLingui()
  const title = !bridge ? t`Files is not available in this window.`
    : error.code === 'thread-unavailable' ? t`This thread is not available to Files.`
      : error.code === 'workspace-unavailable' ? t`The working folder is not available.`
        : error.code === 'busy' ? t`Files is busy.`
          : t`Files could not read the working folder.`
  return <div className="files-problem files-problem--root" role="status">
    <strong>{title}</strong>
    {/* What could not be reached says why, such as a paired host that runs another Sotto version. */}
    {bridge && error.code === 'unavailable' && error.message ? <p>{error.message}</p> : null}
    {bridge ? <button type="button" className="files-link tt-focusable" onClick={onRetry}>{t`Retry`}</button> : null}
  </div>
}

export interface FilesSurfaceProps {
  readonly threadId: string
  readonly store: FilesBrowserStore
  readonly bridge: FilesBridge | undefined
  readonly platform?: string | undefined
  readonly onPathAction: (action: PathAction, path: string) => void
}

/**
 * Files for one thread: its line of chrome, then the working-folder tree above its preview, beside it once the panel is
 * wide. A bridge without reveal (a thread on a paired host, whose folder is on that machine) offers no Show in folder.
 */
export function FilesSurface({ threadId, store, bridge, platform, onPathAction }: FilesSurfaceProps): ReactNode {
  const { t } = useLingui()
  const files = useThreadFiles(store, threadId)
  const folder = files?.workspace ? folderName(files.workspace.workingDirectory) : null
  const filesTitle = t({ message: 'Files', comment: 'The Tools surface that shows a thread\'s working folder.' })
  const chrome = <ToolsChrome title={filesTitle} detail={folder}>
    <button type="button" className="files-icon tt-focusable" aria-label={t`Refresh files`} title={t`Refresh files`} data-busy={files?.refreshing || undefined} onClick={() => void store.refresh(bridge, threadId)}><RotateCw size={15} aria-hidden="true" /></button>
  </ToolsChrome>
  if (!files) return <>{chrome}<p className="files-preview__loading" role="status">{t`Loading…`}</p></>
  const root = files.listings.get('')
  const rootError = root?.status === 'error' ? root.error : null
  const label = folder ? t`Files in ${folder}` : filesTitle
  const preview = files.preview
  return <>{chrome}<div className="files-surface" data-preview={preview && !rootError ? '' : undefined}>
    {files.workspaceChanged ? <div className="files-notice" role="status">
      <span>{t`The working folder changed, so Files started over.`}</span>
      <button type="button" className="files-icon tt-focusable" aria-label={t`Dismiss`} title={t`Dismiss`} onClick={() => store.dismissWorkspaceChanged(threadId)}><X size={14} aria-hidden="true" /></button>
    </div> : null}
    {rootError
      ? <RootProblem error={rootError} bridge={bridge !== undefined} onRetry={() => void store.refresh(bridge, threadId)} />
      : <FileTree files={files} store={store} bridge={bridge} label={label} />}
    {preview && !rootError ? <FilePreview key={preview.path} files={files} preview={preview} platform={platform}
      scrollTop={store.scrollOf(threadId).preview} onScroll={top => store.setScroll(threadId, 'preview', top)}
      onCopyPath={() => onPathAction('copyPath', preview.path)} onReveal={bridge?.reveal ? () => onPathAction('reveal', preview.path) : undefined}
      onClose={() => store.closePreview(threadId)} onRetry={() => store.openFile(bridge, threadId, preview.path)}
      onRefreshFolder={() => store.recoverMissing(bridge, threadId, preview.path)}
      onMarkdownView={view => store.setMarkdownView(threadId, view)} /> : null}
  </div></>
}
