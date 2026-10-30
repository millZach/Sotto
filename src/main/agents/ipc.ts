import { t } from '@lingui/core/macro'
import { AGENT_THREAD_PROMPTS, agentThreadPromptsRequestSchema, type AgentThreadPrompts, type AgentThreadPromptsRequest } from '../../shared/threadPrompts'
import { mapHostReferences, parseHostEntityKey } from '../../shared/clientIdentity'
import { z } from 'zod'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import { AGENT_CHOOSE_PROJECT_DIRECTORY, AGENT_WORKING_COPY_OPTIONS, agentWorkingCopyOptionsRequestSchema, agentWorkingCopyOptionsSchema, type AgentWorkingCopyOptions, type AgentCommand, type AgentCommandReceipt, type AgentCommandThreadChangesReceipt, type AgentState } from '../../shared/agents'
import { AGENT_GIT_REFS, gitRefsRequestSchema, type GitRefsPage, type GitRefsRequest } from '../../shared/gitRefs'
import { AGENT_GIT_CHANGED_FILES, gitChangedFilesRequestSchema, type GitChangedFiles, type GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import { AGENT_GIT_PULL_REQUEST, gitPullRequestRequestSchema, type GitPullRequestRead, type GitPullRequestRequest } from '../../shared/gitPullRequests'
import { AGENT_HOST_FOLDERS, hostFoldersClientRequestSchema, type HostFoldersClientRequest, type HostFoldersResult } from '../../shared/hostFolders'
import { resolveE2EConfiguration } from '../e2e/e2eBoundary'
import { AGENT_ATTACHMENT_CONTENT, AGENT_ATTACHMENT_PREVIEW, AGENT_ATTACHMENT_STAGE, agentAttachmentContentRequestSchema, agentAttachmentStageRequestSchema, type AgentAttachmentContent, type AgentAttachmentContentRequest, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult, type AgentAttachmentHandle, type AgentAttachmentStageRequest, AGENT_ACTIVITY_BODY, AGENT_COMMAND, AGENT_GET, AGENT_START_HANDOVER, AGENT_THREAD_DETAIL_GET, agentActivityBodyRequestSchema, agentAttachmentPreviewRequestSchema, agentCommandSchema, agentCommandReplyOptionsSchema, agentThreadDetailRequestSchema, type AgentActivityBodyRequest, type AgentStartHandover } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { AgentControl } from './control'
import { desktopWindowClient, type HostService } from './hostService'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const workingCopyOptionsArguments = z.tuple([agentWorkingCopyOptionsRequestSchema])
const noArguments = z.tuple([]).or(z.tuple([z.undefined()]))

export interface AgentIpcOptions {
  /** Encodes a command's reply as a command receipt (issue #323): `AgentStateBroadcaster.encodeReceipt`,
   * so the receipt names each catalog by the revision the broadcast uses. */
  readonly encodeReceipt: (state: AgentState) => AgentCommandReceipt
  /** Encodes the reply for a window that asked for its threads as changes: `AgentStateBroadcaster.encodeThreadChangesReceipt`,
   * from the same broadcaster, so the changes are measured from what the window was last broadcast. */
  readonly encodeThreadChangesReceipt: (state: AgentState) => AgentCommandThreadChangesReceipt
  /** The working-copy choices for a project; without it the window is told they are unavailable. */
  readonly workingCopyOptions?: (projectId: string) => Promise<AgentWorkingCopyOptions>
  /** Told when the window reads the whole state, before it is read: `AgentStateBroadcaster.windowRead`, so the next
   * broadcast lists every thread record (issue #1330). */
  readonly windowRead?: () => void
}

/**
 * The window's end of the host boundary. Reads still go straight to the coordinator, because the
 * window is in the same process; every command goes through the host service with the identity of
 * the client that sent it, which is the line a remote client would cross (ADR-0016).
 */
export function registerAgentIpc(ipc: IpcMainAdapter, control: Pick<AgentControl, 'get' | 'shell'> & { threadDetail: (id: string) => ReturnType<AgentControl['threadDetail']> | Promise<ReturnType<AgentControl['threadDetail']>>; attachmentPreview: (request: AgentAttachmentPreviewRequest) => AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>; gitRefs?: (request: GitRefsRequest) => Promise<GitRefsPage>; gitChangedFiles?: (request: GitChangedFilesRequest) => Promise<GitChangedFiles>; gitPullRequest?: (request: GitPullRequestRequest) => Promise<GitPullRequestRead>; hostFolders?: (request: HostFoldersClientRequest) => Promise<HostFoldersResult>; startHandover?: (threadId: string) => Promise<AgentStartHandover | null>; activityBody?: (request: AgentActivityBodyRequest) => Promise<AgentActivity | null>; threadPrompts?: (request: AgentThreadPromptsRequest) => Promise<AgentThreadPrompts | null>; stageAttachment?: (request: AgentAttachmentStageRequest) => Promise<AgentAttachmentHandle>; attachmentContent?: (request: AgentAttachmentContentRequest) => Promise<AgentAttachmentContent | null> }, host: Pick<HostService, 'command'>, senders: () => readonly TrustedIpcSender[], options: AgentIpcOptions): () => void {
  const { workingCopyOptions, encodeReceipt, encodeThreadChangesReceipt, windowRead } = options
  ipc.handle(AGENT_WORKING_COPY_OPTIONS, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const [projectId] = workingCopyOptionsArguments.parse(args)
    if (!workingCopyOptions) throw new Error(t`Working-copy choices are unavailable. Reopen the project and try again.`)
    return agentWorkingCopyOptionsSchema.parse(await workingCopyOptions(projectId))
  })
  ipc.handle(AGENT_CHOOSE_PROJECT_DIRECTORY, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    noArguments.parse(args)
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
    // A window that reads the whole state holds nothing the next broadcast's threads could be measured from.
    windowRead?.()
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
    if (!control.stageAttachment) throw new Error(t`Screenshots cannot be attached in this window. Nothing was attached.`)
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
    if (!control.gitRefs) throw new Error(t`Branches are unavailable.`)
    return control.gitRefs(gitRefsRequestSchema.parse(payload))
  })
  // The commit dialog's file list, for the management window alone.
  ipc.handle(AGENT_GIT_CHANGED_FILES, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.gitChangedFiles) throw new Error(t`Changed files are unavailable.`)
    return control.gitChangedFiles(gitChangedFilesRequestSchema.parse(payload))
  })
  // The Pull request surface's read, for the management window alone.
  ipc.handle(AGENT_GIT_PULL_REQUEST, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.gitPullRequest) throw new Error(t`Pull requests are unavailable.`)
    return control.gitPullRequest(gitPullRequestRequestSchema.parse(payload))
  })
  // The Add project dialog's folder browser, for the management window alone; the request names the host directly.
  ipc.handle(AGENT_HOST_FOLDERS, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.hostFolders) throw new Error(t`This host cannot list its folders yet. Update Sotto on it, then try again.`)
    return control.hostFolders(hostFoldersClientRequestSchema.parse(payload))
  })
  // A started thread's handover, read on its own host when the user asks to read it (#1028).
  ipc.handle(AGENT_START_HANDOVER, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (!control.startHandover) throw new Error(t`Continuing an agent as a thread is unavailable in this window.`)
    return control.startHandover(agentThreadDetailRequestSchema.parse(payload))
  })
  // One record of a remote thread whole, read on its host when its row opens (ADR-0025, October 18 amendment).
  ipc.handle(AGENT_ACTIVITY_BODY, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const request = agentActivityBodyRequestSchema.parse(payload)
    return control.activityBody ? control.activityBody(request) : null
  })
  // The prompts above a pane's window, read on the thread's own host for the message scrubber (ADR-0109).
  ipc.handle(AGENT_THREAD_PROMPTS, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const request = agentThreadPromptsRequestSchema.parse(payload)
    return control.threadPrompts ? control.threadPrompts(request) : null
  })
  ipc.handle(AGENT_COMMAND, (event, payload, replyOptions) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_SENDER_REJECTED')
    agentCommandSchema.parse(mapHostReferences(payload, id => parseHostEntityKey(id)?.id ?? id))
    const changes = replyOptions === undefined ? undefined : agentCommandReplyOptionsSchema.parse(replyOptions)
    // The host answers with the shell already; the coordinator builds it without copying any history.
    // The window already has the catalogs from the broadcast, so the answer names each by its catalog
    // revision rather than listing it again (issue #323); the page recovers through AGENT_GET on a mismatch.
    // A page that holds the last broadcast's threads asks for them as changes, which it puts back the same way.
    const encode: (state: AgentState) => AgentCommandReceipt | AgentCommandThreadChangesReceipt = changes?.threadChanges ? encodeThreadChangesReceipt : encodeReceipt
    return host.command(payload as AgentCommand, windowClient).then(encode)
  })
  return () => { ipc.removeHandler(AGENT_WORKING_COPY_OPTIONS); ipc.removeHandler(AGENT_CHOOSE_PROJECT_DIRECTORY); ipc.removeHandler(AGENT_GET); ipc.removeHandler(AGENT_THREAD_DETAIL_GET); ipc.removeHandler(AGENT_ATTACHMENT_PREVIEW); ipc.removeHandler(AGENT_ATTACHMENT_STAGE); ipc.removeHandler(AGENT_ATTACHMENT_CONTENT); ipc.removeHandler(AGENT_GIT_REFS); ipc.removeHandler(AGENT_GIT_CHANGED_FILES); ipc.removeHandler(AGENT_GIT_PULL_REQUEST); ipc.removeHandler(AGENT_HOST_FOLDERS); ipc.removeHandler(AGENT_START_HANDOVER); ipc.removeHandler(AGENT_ACTIVITY_BODY); ipc.removeHandler(AGENT_THREAD_PROMPTS); ipc.removeHandler(AGENT_COMMAND) }
}
