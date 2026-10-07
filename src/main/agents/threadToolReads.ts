import type { FileListing, FileListRequest, FilePreview, FileRequest, FilesResult } from '../../shared/files'
import type { GitChangeListing, GitReview, GitReviewRequest } from '../../shared/gitChanges'
import type { SubagentAssignmentsPage, SubagentAssignmentsRequest, SubagentPage, SubagentPageRequest } from '../../shared/subagents'
import type { ToolListRequest, ToolsResult } from '../../shared/tools'
import { FilesService, type FilesBinding } from '../files/service'
import { GitChangesService } from '../tools/gitChanges'
import type { WorkspaceHost } from './workspace'

/**
 * The reads a client may make of a thread's tools on this host (ADR-0025, October 5 amendment): a folder's entries
 * and a file's preview for Files, the change list and the Working tree or Branch changes comparison for Changes, and
 * the roster and an agent's assignments for Agents. Each answers exactly as the desktop's own IPC does, with the same
 * bounds, so the window's stores read a paired host's thread unchanged. Nothing here writes, copies or opens anything.
 */
export interface HostThreadToolReads {
  threadFiles(request: FileListRequest): Promise<FilesResult<FileListing>>
  threadFilePreview(request: FileRequest): Promise<FilesResult<FilePreview>>
  gitChanges(request: ToolListRequest): Promise<ToolsResult<GitChangeListing>>
  gitReview(request: GitReviewRequest): Promise<ToolsResult<GitReview>>
  subagentPage(request: SubagentPageRequest): Promise<SubagentPage>
  subagentAssignments(request: SubagentAssignmentsRequest): Promise<SubagentAssignmentsPage>
}

/** Copy path and reveal act on the machine the window is on, so a host's own reads never do either. */
const notHere = (): never => { throw new Error('This read does not copy or open anything on the host.') }

/**
 * The runtime's own Files and Changes services, bound to its threads' working copies through the same resolver the
 * desktop's use. They carry no checkpoints, no watch and no clipboard: those stay with the window on this computer.
 */
export function threadToolReads(options: { resolveBinding(threadId: string): FilesBinding | null; subagents: Pick<WorkspaceHost, 'subagentPage' | 'subagentAssignments'> }): HostThreadToolReads & { dispose(): void } {
  const files = new FilesService({ resolveBinding: options.resolveBinding, copyPath: notHere, reveal: notHere })
  const git = new GitChangesService({ files, copyPath: notHere, reveal: notHere, emit: () => undefined })
  return {
    threadFiles: request => files.list(request),
    threadFilePreview: request => files.preview(request),
    gitChanges: request => git.list(request),
    gitReview: request => git.review(request),
    subagentPage: request => options.subagents.subagentPage(request),
    subagentAssignments: request => options.subagents.subagentAssignments(request),
    dispose: () => git.dispose(),
  }
}
