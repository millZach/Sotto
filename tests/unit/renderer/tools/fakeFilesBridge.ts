import { vi } from 'vitest'
import type { FileListing, FileListRequest, FilePath, FileRequest, FilePreview, FilesBridge, FilesError, FilesResult } from '../../../../src/shared/files'

export type FakeNode = { readonly kind: 'directory' } | { readonly kind: 'unavailable' } | { readonly kind: 'file'; readonly content: FilePreview['content']; readonly size?: number } | { readonly kind: 'fail'; readonly error: FilesError['code']; readonly as?: 'file' | 'directory' }

export const TOKEN_A = 'a'.repeat(64)
export const TOKEN_B = 'b'.repeat(64)

/** An in-memory working folder per thread that answers like the main Files service, including token checks. */
export type FakeFolders = Record<string, { readonly root: string; readonly token: string; readonly tree: Record<string, FakeNode> }>
export function fakeFilesBridge(folders: Record<string, { readonly root: string; readonly token: string; readonly tree: Record<string, FakeNode> }>) {
  const fail = (code: FilesError['code']): FilesResult<never> => ({ ok: false, error: { code, message: `fake ${code}` } })
  const workspace = (threadId: string) => {
    const folder = folders[threadId]!
    return { threadId, projectId: 'workshop', workingDirectory: folder.root, workspaceId: folder.token }
  }
  const guard = (request: FileListRequest | FileRequest): FilesResult<never> | null => {
    const folder = folders[request.threadId]
    if (!folder) return fail('thread-unavailable')
    if (request.workspaceId !== undefined && request.workspaceId !== folder.token) return fail('workspace-changed')
    return null
  }
  const located = (request: FileRequest): FilesResult<FilePath> => ({ ok: true, value: { workspace: workspace(request.threadId), path: request.path, absolutePath: `${folders[request.threadId]!.root}/${request.path}` } })
  const bridge: FilesBridge = {
    list: vi.fn(async (request: FileListRequest): Promise<FilesResult<FileListing>> => {
      const problem = guard(request)
      if (problem) return problem
      const { tree } = folders[request.threadId]!
      const node = request.path === '' ? { kind: 'directory' as const } : tree[request.path]
      if (!node) return fail('path-unavailable')
      if (node.kind === 'fail') return fail(node.error)
      if (node.kind !== 'directory') return fail('not-directory')
      const prefix = request.path === '' ? '' : `${request.path}/`
      const entries = Object.entries(tree).filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, item]) => ({ name: path.slice(prefix.length), path, kind: item.kind === 'fail' ? item.as ?? 'directory' as const : item.kind }))
      return { ok: true, value: { workspace: workspace(request.threadId), path: request.path, entries, truncated: request.path === 'many' } }
    }),
    preview: vi.fn(async (request: FileRequest): Promise<FilesResult<FilePreview>> => {
      const problem = guard(request)
      if (problem) return problem
      const node = folders[request.threadId]!.tree[request.path]
      if (!node) return fail('path-unavailable')
      if (node.kind === 'fail') return fail(node.error)
      if (node.kind !== 'file') return fail('not-file')
      return { ok: true, value: { workspace: workspace(request.threadId), path: request.path, name: request.path.split('/').pop()!, size: node.size ?? 12, content: node.content } }
    }),
    copyPath: vi.fn(async (request: FileRequest) => guard(request) ?? located(request)),
    reveal: vi.fn(async (request: FileRequest) => guard(request) ?? located(request)),
  }
  return bridge
}

export const text = (value: string): FilePreview['content'] => ({ kind: 'text', text: value })
export const markdown = (value: string): FilePreview['content'] => ({ kind: 'markdown', text: value })
