import { mapHostReferences, parseHostEntityKey } from '../../shared/clientIdentity'
import { z } from 'zod'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { AGENT_CHOOSE_PROJECT_DIRECTORY, AGENT_WORKING_COPY_OPTIONS, agentWorkingCopyOptionsRequestSchema, agentWorkingCopyOptionsSchema, type AgentWorkingCopyOptions, type AgentCommandReceipt, type AgentState } from '../../shared/agents'
import { AGENT_GIT_REFS, gitRefsRequestSchema, type GitRefsPage, type GitRefsRequest } from '../../shared/gitRefs'
import { AGENT_GIT_CHANGED_FILES, gitChangedFilesRequestSchema, type GitChangedFiles, type GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import { AGENT_GIT_PULL_REQUEST, gitPullRequestRequestSchema, type GitPullRequestRead, type GitPullRequestRequest } from '../../shared/gitPullRequests'
import { AGENT_HOST_FOLDERS, hostFoldersClientRequestSchema, type HostFoldersClientRequest, type HostFoldersResult } from '../../shared/hostFolders'
import { resolveE2EConfiguration } from '../e2e/e2eBoundary'
import { AGENT_ATTACHMENT_CONTENT, AGENT_ATTACHMENT_PREVIEW, AGENT_ATTACHMENT_STAGE, agentAttachmentContentRequestSchema, agentAttachmentStageRequestSchema, type AgentAttachmentContent, type AgentAttachmentContentRequest, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult, type AgentAttachmentHandle, type AgentAttachmentStageRequest, AGENT_COMMAND, AGENT_GET, AGENT_SPEECH, AGENT_SPEECH_CANCEL, AGENT_GROK_VOICES, AGENT_VOICE_MODEL, AGENT_WAKE, AGENT_THREAD_DETAIL_GET, agentAttachmentPreviewRequestSchema, agentCommandSchema, agentThreadDetailRequestSchema } from '../../shared/agents'
import type { SottoPlatform } from '../../shared/platform'
import { synthesizeAgentSpeech } from './speech'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { AgentControl } from './control'
import { desktopWindowClient, type HostService } from './hostService'
import { AgentWakeService } from './wake'
import type { NaturalSpeechModels } from './speechModels'
import type { GrokSpeechService } from './grokSpeech'
import type { KokoroSpeechService } from './kokoroSpeech'

export interface AgentIpcOptions {
  readonly removalMode?: boolean
  readonly voiceCoordinatorEnabled: boolean
  readonly wakeControl: Pick<AgentControl, 'configuration'>
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
export function registerAgentIpc(ipc: IpcMainAdapter, control: Pick<AgentControl, 'get' | 'shell'> & { threadDetail: (id: string) => ReturnType<AgentControl['threadDetail']> | Promise<ReturnType<AgentControl['threadDetail']>>; attachmentPreview: (request: AgentAttachmentPreviewRequest) => AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>; gitRefs?: (request: GitRefsRequest) => Promise<GitRefsPage>; gitChangedFiles?: (request: GitChangedFilesRequest) => Promise<GitChangedFiles>; gitPullRequest?: (request: GitPullRequestRequest) => Promise<GitPullRequestRead>; hostFolders?: (request: HostFoldersClientRequest) => Promise<HostFoldersResult>; stageAttachment?: (request: AgentAttachmentStageRequest) => Promise<AgentAttachmentHandle>; attachmentContent?: (request: AgentAttachmentContentRequest) => Promise<AgentAttachmentContent | null> }, host: Pick<HostService, 'command'>, senders: () => readonly TrustedIpcSender[], platform: SottoPlatform, speechModels: Pick<NaturalSpeechModels, 'status' | 'download'>, grokSpeech: Pick<GrokSpeechService, 'synthesize' | 'voices' | 'cancel'>, kokoroSpeech: Pick<KokoroSpeechService, 'synthesize' | 'cancel'>, options: AgentIpcOptions): () => void {
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
  ipc.handle(AGENT_GROK_VOICES, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    z.undefined().parse(payload)
    if (options.removalMode) throw new Error('Reply voices are no longer available.')
    return grokSpeech.voices()
  })
  ipc.handle(AGENT_VOICE_MODEL, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const action = z.enum(['status', 'download']).parse(payload)
    if (options.removalMode) throw new Error('Reply voices are no longer available.')
    return action === 'download' ? speechModels.download() : speechModels.status()
  })
  /** The one client there is: this app's own window, over IPC, as this machine's user. */
  const windowClient = desktopWindowClient()
  const wake = new AgentWakeService(app.isPackaged ? join(process.resourcesPath, 'runtime', 'kws') : join(app.getAppPath(), 'node_modules', 'sherpa-onnx'), join(__dirname, 'wakeWorker.js'))
  ipc.handle(AGENT_WAKE, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const request = z.discriminatedUnion('type', [
      z.object({ type: z.literal('prepare') }).strict(),
      z.object({ type: z.literal('detect'), audio: z.instanceof(Float32Array) }).strict(),
      z.object({ type: z.literal('release') }).strict(),
    ]).parse(payload)
    if (request.type === 'release') { wake.dispose(); return { detected: false, endSeconds: 0 } }
    if (options.removalMode) throw new Error('Voice control is no longer available. Dictation is still available.')
    const configuration = options.wakeControl.configuration()
    if (!options.voiceCoordinatorEnabled || !configuration.enabled) throw new Error('Agent voice control is not enabled.')
    await wake.prepare(configuration.wakeModelDirectory, configuration.wakeRuntimeDirectory || undefined)
    return request.type === 'detect' ? wake.detect(request.audio) : { detected: false, endSeconds: 0 }
  })
  let speechOperation: symbol | null = null
  let remoteSpeech = false
  ipc.handle(AGENT_SPEECH_CANCEL, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    z.undefined().parse(payload)
    grokSpeech.cancel()
    kokoroSpeech.cancel()
    if (remoteSpeech) speechOperation = null
  })
  ipc.handle(AGENT_SPEECH, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (options.removalMode) throw new Error('Reply voices are no longer available.')
    if (speechOperation !== null) throw new Error('Speech is already being prepared.')
    const text = z.string().min(1).max(2000).parse(payload)
    const configuration = control.get().configuration
    if (configuration.speechProvider === 'natural') throw new Error('Natural speech uses the local voice worker. Reopen Sotto and retry.')
    const operation = Symbol('speech')
    speechOperation = operation
    remoteSpeech = configuration.speechProvider === 'grok' || configuration.speechProvider === 'kokoro'
    try {
      if (configuration.speechProvider === 'grok') return await grokSpeech.synthesize(text, configuration.grokSpeechVoice)
      if (configuration.speechProvider === 'kokoro') return await kokoroSpeech.synthesize(text)
      return await synthesizeAgentSpeech(text, platform)
    } finally { if (speechOperation === operation) speechOperation = null }
  })
  // The window assembles its own full state from the shell and the detail of the threads it is looking at,
  // so neither the first state nor a command's answer carries every thread's history across the bridge.
  ipc.handle(AGENT_GET, event => {
    if (!isAuthorizedIpcSender(event, senders(), ['main', 'widget'])) throw new Error('AGENT_SENDER_REJECTED')
    return control.shell()
  })
  // Thread history is the management window's alone; the widget draws a thread's state from the shell.
  ipc.handle(AGENT_THREAD_DETAIL_GET, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    return control.threadDetail(agentThreadDetailRequestSchema.parse(payload))
  })
  ipc.handle(AGENT_ATTACHMENT_PREVIEW, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main', 'widget'])) throw new Error('AGENT_SENDER_REJECTED')
    return control.attachmentPreview(agentAttachmentPreviewRequestSchema.parse(payload))
  })
  // Both windows have a composer that takes screenshots, so both stage them and read back a chip's image (ADR-0031).
  ipc.handle(AGENT_ATTACHMENT_STAGE, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main', 'widget'])) throw new Error('AGENT_SENDER_REJECTED')
    if (!control.stageAttachment) throw new Error('Screenshots cannot be attached in this window. Nothing was attached.')
    return control.stageAttachment(agentAttachmentStageRequestSchema.parse(payload))
  })
  ipc.handle(AGENT_ATTACHMENT_CONTENT, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main', 'widget'])) throw new Error('AGENT_SENDER_REJECTED')
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
    if (!isAuthorizedIpcSender(event, senders(), ['main', 'widget'])) throw new Error('AGENT_SENDER_REJECTED')
    const command = agentCommandSchema.parse(mapHostReferences(payload, id => parseHostEntityKey(id)?.id ?? id))
    const speakOnly = command.type === 'configure' && typeof command.patch.speak === 'boolean' && Object.keys(command.patch).length === 1
    const widgetCommand = ['compose', 'send', 'manual-send', 'answer', 'steer', 'queue-followup', 'edit-followup', 'steer-followup', 'remove-followup', 'reorder-followups', 'resume-followups', 'cancel-draft', 'pause-draft', 'resume-draft', 'cancel-request', 'assign', 'unassign', 'resume', 'pause', 'voice', 'utterance', 'select-thread', 'select-attention', 'next', 'later'].includes(command.type)
    if (!speakOnly && !widgetCommand && !isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    // The host answers with the shell already; the coordinator builds it without copying any history.
    // The window already has the catalogs from the broadcast, so the answer names each by its catalog
    // revision rather than listing it again (issue #323); the page recovers through AGENT_GET on a mismatch.
    return host.command(payload as typeof command, windowClient).then(encodeReceipt)
  })
  return () => { grokSpeech.cancel(); kokoroSpeech.cancel(); wake.dispose(); ipc.removeHandler(AGENT_WORKING_COPY_OPTIONS); ipc.removeHandler(AGENT_CHOOSE_PROJECT_DIRECTORY); ipc.removeHandler(AGENT_WAKE); ipc.removeHandler(AGENT_GET); ipc.removeHandler(AGENT_THREAD_DETAIL_GET); ipc.removeHandler(AGENT_ATTACHMENT_PREVIEW); ipc.removeHandler(AGENT_ATTACHMENT_STAGE); ipc.removeHandler(AGENT_ATTACHMENT_CONTENT); ipc.removeHandler(AGENT_GIT_REFS); ipc.removeHandler(AGENT_GIT_CHANGED_FILES); ipc.removeHandler(AGENT_GIT_PULL_REQUEST); ipc.removeHandler(AGENT_HOST_FOLDERS); ipc.removeHandler(AGENT_COMMAND); ipc.removeHandler(AGENT_SPEECH); ipc.removeHandler(AGENT_SPEECH_CANCEL); ipc.removeHandler(AGENT_GROK_VOICES); ipc.removeHandler(AGENT_VOICE_MODEL) }
}
