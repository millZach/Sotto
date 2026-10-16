import { mapHostReferences, parseHostEntityKey } from '../../shared/clientIdentity'
import { z } from 'zod'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { AGENT_CHOOSE_PROJECT_DIRECTORY, AGENT_WORKING_COPY_OPTIONS, agentWorkingCopyOptionsRequestSchema, agentWorkingCopyOptionsSchema, type AgentWorkingCopyOptions, type AgentCommand, type AgentCommandReceipt, type AgentState } from '../../shared/agents'
import { AGENT_GIT_REFS, gitRefsRequestSchema, type GitRefsPage, type GitRefsRequest } from '../../shared/gitRefs'
import { AGENT_GIT_CHANGED_FILES, gitChangedFilesRequestSchema, type GitChangedFiles, type GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import { AGENT_GIT_PULL_REQUEST, gitPullRequestRequestSchema, type GitPullRequestRead, type GitPullRequestRequest } from '../../shared/gitPullRequests'
import { AGENT_HOST_FOLDERS, hostFoldersClientRequestSchema, type HostFoldersClientRequest, type HostFoldersResult } from '../../shared/hostFolders'
import { resolveE2EConfiguration } from '../e2e/e2eBoundary'
import { AGENT_ATTACHMENT_CONTENT, AGENT_ATTACHMENT_PREVIEW, AGENT_ATTACHMENT_STAGE, agentAttachmentContentRequestSchema, agentAttachmentStageRequestSchema, type AgentAttachmentContent, type AgentAttachmentContentRequest, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult, type AgentAttachmentHandle, type AgentAttachmentStageRequest, AGENT_COMMAND, AGENT_GET, AGENT_THREAD_DETAIL_GET, agentAttachmentPreviewRequestSchema, agentCommandSchema, agentThreadDetailRequestSchema } from '../../shared/agents'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { AgentControl } from './control'
import { desktopWindowClient, type HostService } from './hostService'

export interface AgentIpcOptions {
  /** Encodes a command's reply as a command receipt (issue #323): `AgentStateBroadcaster.encodeReceipt`,
   * so the receipt names each catalog by the revision the broadcast uses. */
  readonly encodeReceipt: (state: AgentState) => AgentCommandReceipt
  /** The working-copy choices for a project; without it the window is told they are unavailable. */
  readonly workingCopyOptions?: (projectId: string) => Promise<AgentWorkingCopyOptions>
}

/**
 * The window's end of the host boundary. Reads still go straight to the coordinator, because the
 * window is in the same process; every command goes through the host service with the identity of
 * the client that sent it, which is the line a remote client would cross (ADR-0016).
 */
export function registerAgentIpc(ipc: IpcMainAdapter, control: Pick<AgentControl, 'get' | 'shell'> & { threadDetail: (id: string) => ReturnType<AgentControl['threadDetail']> | Promise<ReturnType<AgentControl['threadDetail']>>; attachmentPreview: (request: AgentAttachmentPreviewRequest) => AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>; gitRefs?: (request: GitRefsRequest) => Promise<GitRefsPage>; gitChangedFiles?: (request: GitChangedFilesRequest) => Promise<GitChangedFiles>; gitPullRequest?: (request: GitPullRequestRequest) => Promise<GitPullRequestRead>; hostFolders?: (request: HostFoldersClientRequest) => Promise<HostFoldersResult>; stageAttachment?: (request: AgentAttachmentStageRequest) => Promise<AgentAttachmentHandle>; attachmentContent?: (request: AgentAttachmentContentRequest) => Promise<AgentAttachmentContent | null> }, host: Pick<HostService, 'command'>, senders: () => readonly TrustedIpcSender[], options: AgentIpcOptions): () => void {
  const { workingCopyOptions, encodeReceipt } = options
  ipc.handle(AGENT_WORKING_COPY_OPTIONS, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const [projectId] = z.tuple([agentWorkingCopyOptionsRequestSchema]).parse(args)
    if (!workingCopyOptions) throw new Error('Working-copy choices are unavailable. Reopen the project and try again.')
    return agentWorkingCopyOptionsSchema.parse(await workingCopyOptions(projectId))
  })
  ipc.handle(AGENT_CHOOSE_PROJECT_DIRECTORY, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    z.tuple([]).or(z.tuple([z.undefined()])).parse(args)
    const parent = BrowserWindow.fromWebContents(event.sender as WebContents)
    if (parent === null || parent.isDestroyed()) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (resolveE2EConfiguration(app.isPackaged, process.env) !== null) {
      const path = process.env.SOTTO_E2E_PROJECT_DIRECTORY
      if (path === undefined) return null
      if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('AGENT_E2E_PROJECT_DIRECTORY_INVALID')
      return path
    }
    const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  /** The one client there is: this app's own window, over IPC, as this machine's user. */
  const windowClient = desktopWindowClient()
  // The window assembles its own full state from the shell and the detail of the threads it is looking at,
  // so neither the first state nor a command's answer carries every thread's history across the bridge.
  ipc.handle(AGENT_GET, event => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_SENDER_REJECTED')
    return control.shell()
  })
  ipc.handle(AGENT_THREAD_DETAIL_GET, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    return control.threadDetail(agentThreadDetailRequestSchema.parse(payload))
  })
  ipc.handle(AGENT_ATTACHMENT_PREVIEW, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_SENDER_REJECTED')
    return control.attachmentPreview(agentAttachmentPreviewRequestSchema.parse(payload))
  })
  // The composer stages screenshots and reads back a chip's image (ADR-0031).
  ipc.handle(AGENT_ATTACHMENT_STAGE, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_SENDER_REJECTED')
    if (!control.stageAttachment) throw new Error('Screenshots cannot be attached in this window. Nothing was attached.')
    return control.stageAttachment(agentAttachmentStageRequestSchema.parse(payload))
  })
  ipc.handle(AGENT_ATTACHMENT_CONTENT, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_SENDER_REJECTED')
    if (!control.attachmentContent) return null
    return control.attachmentContent(agentAttachmentContentRequestSchema.parse(payload))
  })
  // The branch picker's list, for the management window alone; the request names a client-scoped thread the router resolves.
  ipc.handle(AGENT_GIT_REFS, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.gitRefs) throw new Error('Branches are unavailable.')
    return control.gitRefs(gitRefsRequestSchema.parse(payload))
  })
  // The commit dialog's file list, for the management window alone.
  ipc.handle(AGENT_GIT_CHANGED_FILES, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.gitChangedFiles) throw new Error('Changed files are unavailable.')
    return control.gitChangedFiles(gitChangedFilesRequestSchema.parse(payload))
  })
  // The Pull request surface's read, for the management window alone.
  ipc.handle(AGENT_GIT_PULL_REQUEST, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.gitPullRequest) throw new Error('Pull requests are unavailable.')
    return control.gitPullRequest(gitPullRequestRequestSchema.parse(payload))
  })
  // The Add project dialog's folder browser, for the management window alone; the request names the host directly.
  ipc.handle(AGENT_HOST_FOLDERS, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.hostFolders) throw new Error('This host cannot list its folders yet. Update Sotto on it, then try again.')
    return control.hostFolders(hostFoldersClientRequestSchema.parse(payload))
  })
  ipc.handle(AGENT_COMMAND, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_SENDER_REJECTED')
    agentCommandSchema.parse(mapHostReferences(payload, id => parseHostEntityKey(id)?.id ?? id))
    // The host answers with the shell already; the coordinator builds it without copying any history.
    // The window already has the catalogs from the broadcast, so the answer names each by its catalog
    // revision rather than listing it again (issue #323); the page recovers through AGENT_GET on a mismatch.
    return host.command(payload as AgentCommand, windowClient).then(encodeReceipt)
  })
  return () => { ipc.removeHandler(AGENT_WORKING_COPY_OPTIONS); ipc.removeHandler(AGENT_CHOOSE_PROJECT_DIRECTORY); ipc.removeHandler(AGENT_GET); ipc.removeHandler(AGENT_THREAD_DETAIL_GET); ipc.removeHandler(AGENT_ATTACHMENT_PREVIEW); ipc.removeHandler(AGENT_ATTACHMENT_STAGE); ipc.removeHandler(AGENT_ATTACHMENT_CONTENT); ipc.removeHandler(AGENT_GIT_REFS); ipc.removeHandler(AGENT_GIT_CHANGED_FILES); ipc.removeHandler(AGENT_GIT_PULL_REQUEST); ipc.removeHandler(AGENT_HOST_FOLDERS); ipc.removeHandler(AGENT_COMMAND) }
}
