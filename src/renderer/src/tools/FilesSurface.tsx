import React, { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { FilesBridge, FilesError } from '../../../shared/files'
import { FilePreview } from './FilePreview'
import { FileTree } from './FileTree'
import { type FilesBrowserStore, type PathAction, type ThreadFiles } from './filesBrowser'

export function useThreadFiles(store: FilesBrowserStore, threadId: string | null): ThreadFiles | undefined {
  const read = useCallback(() => threadId === null ? undefined : store.thread(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}

function RootProblem({ error, bridge, onRetry }: { error: FilesError; bridge: boolean; onRetry: () => void }): ReactNode {
  const title = !bridge ? 'Files is not available in this window.'
    : error.code === 'thread-unavailable' ? 'This thread is not available to Files.'
      : error.code === 'workspace-unavailable' ? 'The working folder is not available.'
        : error.code === 'busy' ? 'Files is busy.'
          : 'Files could not read the working folder.'
  return <div className="files-problem files-problem--root" role="status">
    <strong>{title}</strong>
    {bridge ? <button type="button" className="files-link tt-focusable" onClick={onRetry}>Retry</button> : null}
  </div>
}

export interface FilesSurfaceProps {
  readonly threadId: string
  readonly store: FilesBrowserStore
  readonly bridge: FilesBridge | undefined
  readonly platform?: string | undefined
  readonly onPathAction: (action: PathAction, path: string) => void
}

/** Files for one thread: the working-folder tree beside its preview, stacking in a narrow panel. */
export function FilesSurface({ threadId, store, bridge, platform, onPathAction }: FilesSurfaceProps): ReactNode {
  const files = useThreadFiles(store, threadId)
  if (!files) return <p className="files-preview__loading" role="status">Loading…</p>
  const root = files.listings.get('')
  const rootError = root?.status === 'error' ? root.error : null
  const label = files.workspace ? `Files in ${folderName(files.workspace.workingDirectory)}` : 'Files'
  const preview = files.preview
  return <div className="files-surface" data-preview={preview && !rootError ? '' : undefined}>
    {files.workspaceChanged ? <div className="files-notice" role="status">
      <span>The working folder changed, so Files started over.</span>
      <button type="button" className="files-icon tt-focusable" aria-label="Dismiss" title="Dismiss" onClick={() => store.dismissWorkspaceChanged(threadId)}><X size={14} aria-hidden="true" /></button>
    </div> : null}
    {rootError
      ? <RootProblem error={rootError} bridge={bridge !== undefined} onRetry={() => void store.refresh(bridge, threadId)} />
      : <FileTree files={files} store={store} bridge={bridge} label={label} />}
    {preview && !rootError ? <FilePreview key={preview.path} files={files} preview={preview} platform={platform}
      scrollTop={store.scrollOf(threadId).preview} onScroll={top => store.setScroll(threadId, 'preview', top)}
      onCopyPath={() => onPathAction('copyPath', preview.path)} onReveal={() => onPathAction('reveal', preview.path)}
      onClose={() => store.closePreview(threadId)} onRetry={() => store.openFile(bridge, threadId, preview.path)}
      onRefreshFolder={() => store.recoverMissing(bridge, threadId, preview.path)}
      onMarkdownView={view => store.setMarkdownView(threadId, view)} /> : null}
  </div>
}
