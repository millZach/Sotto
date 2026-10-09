import { z } from 'zod'
import { subagentSummarySchema } from './subagents'
import { agentSkillCatalogSchema, agentSkillReferencesSchema } from './agentSkills'
import { agentFileReferencesSchema } from './agentFiles'
import { agentActivitySchema, MAX_AGENT_ACTIVITIES } from './agentActivity'
import { threadUsageSchema } from './threadUsage'
import { agentVisualSchema, VISUAL_MESSAGE_PREFIX, type AgentVisual } from './visuals'
import { compactionSchema } from './compaction'
import { agentBackgroundWorkSchema, agentMonitoringSchema } from './agentMonitoring'
import { gitStatusSchema } from './gitStatus'
import { agentBabysittingSchema, BABYSITTING_PER_THREAD_MAX } from './babysitting'
import { gitActionProgressSchema, gitStackedActionSchema } from './gitActions'
import type { GitRefsPage, GitRefsRequest } from './gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from './gitChangedFiles'
import { GIT_PULL_REQUEST_LINKS_MAX, gitPullRequestActionSchema, gitPullRequestLinkSchema, gitPullRequestMergeMethodSchema, gitPullRequestUrlSchema, type GitPullRequestRead, type GitPullRequestRequest } from './gitPullRequests'
import type { HostFoldersClientRequest, HostFoldersResult } from './hostFolders'

export const AGENT_GET = 'sotto:agents:get'
export const AGENT_CHOOSE_PROJECT_DIRECTORY = 'sotto:agents:choose-project-directory'
export const AGENT_COMMAND = 'sotto:agents:command'
export const AGENT_STATE = 'sotto:agents:state'
export const AGENT_E2E = 'sotto:e2e:agents'
export const AGENT_ATTACHMENT_PREVIEW = 'sotto:agents:attachment-preview'
/** The window stages an image's bytes once and gets its handle back, or reads a staged image back for a chip (ADR-0031). */
export const AGENT_ATTACHMENT_STAGE = 'sotto:agents:stage-attachment'
export const AGENT_ATTACHMENT_CONTENT = 'sotto:agents:attachment-content'
/** Pushed per thread: the messages of a thread the window is actually looking at. */
export const AGENT_THREAD_DETAIL = 'sotto:agents:thread-detail'
/** Asked for by the window when it opens a thread whose detail it has not been sent. */
export const AGENT_THREAD_DETAIL_GET = 'sotto:agents:thread-detail-get'
export const providerIdSchema = z.enum(['codex', 'claude', 'grok', 'devin'])
export type ProviderId = z.infer<typeof providerIdSchema>
/**
 * Why a provider is not connected, as a stable code the Hosts page's tiles decide on (ADR-0037): its client is not
 * there, is older than Sotto supports, is there but not signed in, or is there and could not be started or checked.
 * The sentence in `error` says the same in words; a window never reads meaning out of the sentence.
 */
export const providerProblemSchema = z.enum(['not-installed', 'too-old', 'signed-out', 'cannot-start'])
export type ProviderProblem = z.infer<typeof providerProblemSchema>
/** The account kind a connected provider is signed in with, such as "ChatGPT" or "Claude Max": a plan, never an address. */
const providerAccountSchema = z.string().min(1).max(80)

const id = z.string().min(1).max(512)
/** How many of a thread's newest wake-ups its record names (`wakeUpMessageIds`). */
export const WAKE_UP_MESSAGE_IDS_MAX = 50
// Scoped public model/project IDs include an encoded native identifier.
const providerEntityId = z.string().min(1).max(6_144)
/** The longest text a message, a prompt or a follow-up carries. */
export const AGENT_TEXT_MAX = 100_000
const text = z.string().max(AGENT_TEXT_MAX)
export const AGENT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const AGENT_MAX_ATTACHMENTS = 8
export const AGENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const AGENT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
// What a screenshot is refused with wherever it is checked: the composer before it reads a file, and staging after.
// The guide gives these limits in MB, so the sentences do too.
export const SCREENSHOT_WRONG_TYPE = 'Only PNG, JPEG, GIF, and WebP screenshots can be attached. Nothing was attached. Choose files of those types.'
export const SCREENSHOT_TOO_LARGE = 'Each screenshot must be 10 MB or smaller. Nothing was attached. Choose a smaller file.'
export const SCREENSHOTS_TOO_LARGE_IN_TOTAL = 'Screenshots must total 20 MB or less. Nothing was attached. Remove an image or choose smaller files.'
export const SCREENSHOT_NOT_ITS_TYPE = 'This screenshot’s content does not match its file type. Nothing was attached. Save it again as PNG, JPEG, GIF, or WebP, then attach it.'
/**
 * The refusal when nothing is connected to act with. Only a send has a draft to keep, so only a send says so. A
 * headless host cannot know the name a desktop saved it under, so it says "this host" and the desktop puts that name
 * in (`nameHostInRefusal`); the desktop's own coordinator names this computer and its own Providers page (#459).
 */
export const NO_PROVIDER_ON_HOST = 'No provider is connected on this host.'
const NO_PROVIDER_HERE = 'No provider is connected on this computer.'
const DRAFT_KEPT = ' Your draft is saved.'
export function noProviderRefusal(where: 'host' | 'desktop', draftKept: boolean): string {
  return (where === 'host' ? `${NO_PROVIDER_ON_HOST} Connect one in Settings > Hosts.` : `${NO_PROVIDER_HERE} Connect one in Settings > Providers.`) + (draftKept ? DRAFT_KEPT : '')
}
/** A host's refusal as the desktop shows it: "this host" becomes the name the user saved the host under. */
export function nameHostInRefusal(message: string, name: string): string {
  return message.startsWith(NO_PROVIDER_ON_HOST) && name.trim() ? `No provider is connected on ${name.trim()}.${message.slice(NO_PROVIDER_ON_HOST.length)}` : message
}
/** What a host from before staged images (ADR-0031) is refused with when asked to keep one. */
export const HOST_CANNOT_STAGE_SCREENSHOTS = 'This host cannot keep screenshots. Update Sotto there, then attach them again. Nothing was attached.'
export const agentRuntimeModeSchema = z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
export type AgentRuntimeMode = z.infer<typeof agentRuntimeModeSchema>
export function attachmentSizeBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
}
/** An image's size in whole pixels, 1 to 65,535 on each side. The composer's resizer trusts no size this refuses. */
export const agentImageSizeSchema = z.object({ width: z.number().int().min(1).max(65_535), height: z.number().int().min(1).max(65_535) }).strict()
export type AgentImageSize = z.infer<typeof agentImageSizeSchema>
/**
 * An image's size in pixels as the user attached it and as it is sent, which differ only when the composer
 * scaled it down to the screenshot bound. Sizes only, never image content.
 */
export const agentAttachmentDimensionsSchema = z.object({ original: agentImageSizeSchema, sent: agentImageSizeSchema }).strict()
export type AgentAttachmentDimensions = z.infer<typeof agentAttachmentDimensionsSchema>
export const agentAttachmentSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/iu), name: z.string().trim().min(1).max(255),
  mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), dataUrl: z.string().max(14_000_000),
  dimensions: agentAttachmentDimensionsSchema.optional(),
}).strict().refine(attachment => {
  const prefix = `data:${attachment.mimeType};base64,`
  if (!attachment.dataUrl.startsWith(prefix)) return false
  const base64 = attachment.dataUrl.slice(prefix.length)
  return base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(base64)
    && attachmentSizeBytes(attachment.dataUrl) > 0 && attachmentSizeBytes(attachment.dataUrl) <= AGENT_MAX_IMAGE_BYTES
}, 'Choose a valid PNG, JPEG, GIF or WebP image no larger than 10 MiB.')
export const agentAttachmentsSchema = z.array(agentAttachmentSchema).max(AGENT_MAX_ATTACHMENTS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Attachment IDs must be unique.')
  .refine(items => items.reduce((size, item) => size + attachmentSizeBytes(item.dataUrl), 0) <= AGENT_MAX_ATTACHMENT_BYTES, 'Images must total no more than 20 MiB.')
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>
/** Whether a header (bytes as Latin-1 characters) opens the raster format its MIME type names; never SVG or HTML. */
function rasterHeaderMatches(mimeType: string, header: string): boolean {
  return mimeType === 'image/png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : mimeType === 'image/jpeg' ? header.startsWith('\xff\xd8\xff')
      : mimeType === 'image/gif' ? /^(GIF87a|GIF89a)/u.test(header)
        : mimeType === 'image/webp' && header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
}
/** Signature check shared by preview validation and older inline images; never accepts SVG/HTML. */
export function hasRasterImageSignature(attachment: Pick<AgentAttachment, 'mimeType' | 'dataUrl'>): boolean {
  let header: string
  try { header = atob(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1, attachment.dataUrl.indexOf(',') + 25)) }
  catch { return false }
  return rasterHeaderMatches(attachment.mimeType, header)
}
/** The same check on the bytes themselves, which is what staging an image runs. */
export function bytesHaveRasterSignature(mimeType: string, bytes: Uint8Array): boolean {
  return rasterHeaderMatches(mimeType, String.fromCharCode(...bytes.subarray(0, 16)))
}
/** The SHA-256 of a staged image's bytes, as lowercase hex: the content a handle names. */
export const attachmentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
/**
 * A staged image (ADR-0031): what drafts, follow-ups, commands, state and broadcasts carry in place of its bytes.
 * `id` is this attachment's own, `digest` the content's; the same image attached twice is two handles on one content.
 */
export const agentAttachmentHandleSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/iu), name: z.string().trim().min(1).max(255),
  mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), sizeBytes: z.number().int().min(1).max(AGENT_MAX_IMAGE_BYTES), digest: attachmentDigestSchema,
  /** The sizes the composer attached and staged it at, when it knew them (issue #321). */
  dimensions: agentAttachmentDimensionsSchema.optional(),
}).strict()
export type AgentAttachmentHandle = z.infer<typeof agentAttachmentHandleSchema>
/** The bytes a set of staged images holds between them: what the 20 MiB total is measured on. */
export function attachmentHandlesBytes(items: readonly Pick<AgentAttachmentHandle, 'sizeBytes'>[]): number {
  return items.reduce((sum, item) => sum + item.sizeBytes, 0)
}
export const agentAttachmentHandlesSchema = z.array(agentAttachmentHandleSchema).max(AGENT_MAX_ATTACHMENTS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Attachment IDs must be unique.')
  .refine(items => attachmentHandlesBytes(items) <= AGENT_MAX_ATTACHMENT_BYTES, 'Images must total no more than 20 MiB.')
const imageBytes = (limit: number) => z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= limit,
  'Choose a PNG, JPEG, GIF or WebP image no larger than 10 MiB.')
/** The window hands an image's bytes to main once; the handle comes back. `threadId` picks the host that runs it. */
export const agentAttachmentStageRequestSchema = z.object({
  threadId: id.nullable(), name: z.string().trim().min(1).max(255), mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), bytes: imageBytes(AGENT_MAX_IMAGE_BYTES),
  dimensions: agentAttachmentDimensionsSchema.optional(),
}).strict()
export type AgentAttachmentStageRequest = z.infer<typeof agentAttachmentStageRequestSchema>
/** What a host is handed to stage: the image without the thread the window routed it by. */
export type AgentAttachmentUpload = Omit<AgentAttachmentStageRequest, 'threadId'>
/** A staged image's bytes, for a composer restoring a chip it holds no copy of. */
export const agentAttachmentContentRequestSchema = z.object({ threadId: id.nullable(), digest: attachmentDigestSchema }).strict()
export type AgentAttachmentContentRequest = z.infer<typeof agentAttachmentContentRequestSchema>
export const agentAttachmentContentSchema = z.object({ mimeType: z.enum(AGENT_IMAGE_MIME_TYPES), bytes: imageBytes(AGENT_MAX_IMAGE_BYTES) }).strict()
export type AgentAttachmentContent = z.infer<typeof agentAttachmentContentSchema>
export const agentAttachmentContentResultSchema = agentAttachmentContentSchema.nullable()
/** Preview bytes themselves: an unsent draft's own image, or one main hands back on request. */
export const agentAttachmentPreviewDataSchema = z.object({ dataUrl: z.string().max(14_000_000) }).strict().refine(preview => {
  const parsed = agentAttachmentSchema.safeParse({ id: 'preview', name: 'preview',
    mimeType: preview.dataUrl.slice(5, preview.dataUrl.indexOf(';')), dataUrl: preview.dataUrl })
  return parsed.success && hasRasterImageSignature(parsed.data)
}, 'Choose a valid raster image preview.')
/** Published state carries the marker alone; the window asks for the bytes when it draws the image. */
const agentAttachmentPreviewMarkerSchema = z.object({ available: z.literal(true) }).strict()
export const agentAttachmentPreviewSchema = z.union([agentAttachmentPreviewDataSchema, agentAttachmentPreviewMarkerSchema])
export type AgentAttachmentPreview = z.infer<typeof agentAttachmentPreviewSchema>
export const agentAttachmentPreviewRequestSchema = z.object({ threadId: id, messageId: id, attachmentId: id }).strict()
export type AgentAttachmentPreviewRequest = z.infer<typeof agentAttachmentPreviewRequestSchema>
export const agentAttachmentPreviewResultSchema = agentAttachmentPreviewDataSchema.nullable()
export type AgentAttachmentPreviewResult = z.infer<typeof agentAttachmentPreviewResultSchema>
export const agentAttachmentReferenceSchema = z.object({ id, name: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative(),
  /** Supplied by Sotto for submitted images; never a filesystem path or a provider URL. */
  preview: agentAttachmentPreviewSchema.optional(),
})
export type AgentAttachmentReference = z.infer<typeof agentAttachmentReferenceSchema>
/**
 * A permission setting a provider names itself, for providers whose own modes are not Sotto's four. `name`
 * and `description` are the provider's words; `asks` is Sotto's, and says what it will still put to the
 * user while the mode is set -- the one sentence that keeps a mode called "Bypass Permissions" from
 * implying Sotto stops asking when it does not (ADR-0022). `allows` is the mode's allowance, what it lets the
 * provider do unasked; a mode without one is treated as allowing something, never as asking about everything.
 */
export const agentProviderModeSchema = z.object({ id: providerEntityId, name: id, description: text.optional(), asks: text.optional(),
  allows: z.enum(['nothing', 'edits', 'everything']).optional() }).strict()
export type AgentProviderMode = z.infer<typeof agentProviderModeSchema>
export const agentThreadOptionsSchema = z.object({ modelId: providerEntityId.optional(), reasoningEffort: z.string().min(1).max(64).optional(),
  runtimeMode: agentRuntimeModeSchema.optional(), providerMode: providerEntityId.optional() })
export type AgentThreadOptions = z.infer<typeof agentThreadOptionsSchema>
export const agentModelSchema = z.object({ id: providerEntityId, provider: id, providerId: providerIdSchema.optional(), name: id, ready: z.boolean(),
  /**
   * The provider's own ids in Sotto's order, least to most thorough, so the last is the highest level.
   * The adapter puts them in that order (`orderReasoningEfforts`); a provider that lists them highest
   * first, as Grok does, is turned round there and nowhere else.
   */
  reasoningEfforts: z.array(z.string()).optional(), defaultReasoningEffort: z.string().optional(),
  runtimeModes: z.array(agentRuntimeModeSchema).optional(), supportsImages: z.boolean().optional(),
  /**
   * Offered in place of `runtimeModes` by a provider whose permission modes are its own, not Sotto's four.
   * The first is the one a thread starts on when none is chosen, so it is what every control shows unchosen.
   */
  providerModes: z.array(agentProviderModeSchema).max(20).optional(),
  /** The provider names one of its own models as the one to reach for; the picker keeps it at the top. */
  recommended: z.boolean().optional(),
})
export const agentProjectSchema = z.object({ hostId: z.uuid().optional(), id: providerEntityId, providerId: providerIdSchema.optional(), title: id, path: z.string().max(4_096), workspaceSettledAt: z.string().datetime().nullable().optional() })
export const agentRequestSchema = z.object({
  id, kind: z.enum(['question', 'permission']), text,
  options: z.array(z.object({ id, label: text })).default([]),
  questions: z.array(z.object({ id, question: text, header: text.optional(), options: z.array(z.object({ id, label: text, description: text.optional(), preview: text.optional() })), multiSelect: z.boolean(), allowFreeText: z.boolean(), required: z.boolean().optional(), unavailableReason: text.optional() })).max(100).optional(),
  permissionChoices: z.array(z.object({ id, label: text, kind: z.enum(['allow-once', 'allow-session', 'allow-always', 'deny', 'cancel']), description: text.optional() })).optional(),
  context: z.object({ toolName: text.optional(), toolCallId: id.optional(), command: text.optional(), cwd: text.optional(), details: text.optional() }).optional(),
  delivery: z.literal('uncertain').optional(),
  answerRetryReady: z.literal(true).optional(),
})
export const agentQuestionAnswersSchema = z.record(id, z.object({ optionIds: z.array(id).max(100), text: text.optional() }).strict())
export type AgentQuestionAnswers = z.infer<typeof agentQuestionAnswersSchema>
export const agentMessageSchema = z.object({
  // A projected message combines bounded events and can exceed any one event's limit.
  id, role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.string(),
  commandId: z.string().optional(),
  attachments: z.array(agentAttachmentReferenceSchema).optional(),
  /**
   * Set on a message Sotto made for a visual an agent drew (ADR-0056), whose ID starts `visual:` and whose text is the
   * visual's words. A visual this reader cannot read is dropped and the text stands in; an older reader drops the field.
   * Either way the message is then its words alone: `isVisualMessage` says no.
   */
  visual: agentVisualSchema.optional().catch(undefined),
  /**
   * Set on a wake-up babysitting sent (ADR-0061 decision 8), from the host's own record of the send rather than the
   * message's text, so it survives the history being read again from the provider. An older reader drops the field and
   * shows the message as the user's.
   */
  wakeUp: z.literal(true).optional().catch(undefined),
})
/**
 * What the sidebar reads about a thread's history without holding that history. The shell stream
 * carries it in place of `messages`; a thread whose messages are present derives the same facts.
 */
const AGENT_THREAD_EXCERPT_MAX = 2_000
const excerpt = z.string().max(AGENT_THREAD_EXCERPT_MAX)
const threadExcerptSchema = z.object({ id, text: excerpt, createdAt: z.string() }).strict()
const agentThreadSummarySchema = z.object({
  messageCount: z.number().int().nonnegative(),
  /** The newest `createdAt` across every message, so a row's clock survives without them. */
  lastMessageAt: z.string().optional(),
  lastUser: threadExcerptSchema.optional(),
  lastAssistant: threadExcerptSchema.optional(),
  activityCount: z.number().int().nonnegative().default(0),
  /** When the run on screen began, for a row that no longer carries the turn record itself. */
  runningTurnStartedAt: z.string().optional(),
}).strict()
export type AgentThreadSummary = z.infer<typeof agentThreadSummarySchema>
export const worktreeReclaimPreviewSchema = z.object({
  path: z.string(), branch: z.string().optional(), dirty: z.boolean(), ignored: z.array(z.string()),
  repositories: z.array(z.object({ path: z.string(), changeCount: z.number().int().nonnegative(), unpushedCommitCount: z.number().int().nonnegative().optional(), kind: z.enum(['worktree', 'repository']) })),
  items: z.array(z.object({ path: z.string(), bytes: z.number().nonnegative(), fileCount: z.number().int().nonnegative() })),
  untracked: z.array(z.string()),
  outsideLink: z.string().optional(),
}).strict()
export type WorktreeReclaimPreview = z.infer<typeof worktreeReclaimPreviewSchema>
export const agentWorktreeSchema = z.object({
  mode: z.enum(['independent', 'shared']), status: z.enum(['pending', 'ready', 'error']),
  path: z.string().optional(), repositoryRoot: z.string().optional(), branch: z.string().optional(),
  baseCommit: z.string().optional(), error: z.string().optional(), dirty: z.boolean().optional(),
  projectRelativePath: z.string().optional(),
  baseBranch: z.string().optional(), startFromOrigin: z.boolean().optional(),
  /** What Start from origin found when the worktree was allocated: origin's branch was fetched, origin did not have
   * the branch so the local one was used, or the project has no origin remote so nothing was fetched. */
  originBase: z.enum(['fetched', 'not-on-origin', 'no-origin']).optional(),
  existingWorktreePath: z.string().optional(), reused: z.boolean().optional(), temporaryBranch: z.boolean().optional(),
  /** The folder's Git status as the host last read it: branch, upstream, ahead and behind, dirty, the pull request. */
  git: gitStatusSchema.optional(),
  /** The branch this worktree was on when Sotto last sent to the thread. Absent before the first send,
   * and for a detached HEAD. The pane compares it with `branch` to show the branch-changed notice. */
  sentBranch: z.string().optional(),
  /** When Sotto reclaimed this worktree's folder. The branch and the thread stay; the next send puts
   * the folder back on that branch (ADR-0041). Absent while the folder is there. */
  reclaimedAt: z.string().optional(),
  /** The worktree checks `branch` out as it stands instead of cutting a new branch from the base: a pull request
   * checked out into a worktree of its own, whose branch the first send puts in the new folder. */
  checkoutBranch: z.boolean().optional(),
})
export type AgentWorktree = z.infer<typeof agentWorktreeSchema>
export const agentWorkingCopySelectionSchema = z.object({
  workingCopy: z.enum(['independent', 'shared']), baseBranch: z.string().min(1).max(512).optional(),
  startFromOrigin: z.boolean().optional(), existingWorktreePath: z.string().min(1).max(4096).optional(),
}).strict()
export type AgentWorkingCopySelection = z.infer<typeof agentWorkingCopySelectionSchema>
export const agentWorkingCopyOptionsSchema = z.object({
  isGit: z.boolean(), currentBranch: z.string().nullable(), branches: z.array(z.string()),
  worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable() })),
}).strict()
export type AgentWorkingCopyOptions = z.infer<typeof agentWorkingCopyOptionsSchema>
export const AGENT_WORKING_COPY_OPTIONS = 'sotto:agents:working-copy-options'
export const agentWorkingCopyOptionsRequestSchema = z.string().min(1).max(512)

export const agentThreadSchema = z.object({
  hostLabel: z.string().max(80).optional(), remoteHost: z.boolean().optional(), clientConnected: z.boolean().optional(),
  /** Set by the desktop while this thread's host restarts for an update and the desktop reconnects to it (ADR-0040). */
  clientReconnecting: z.boolean().optional(),
  hostId: z.uuid().optional(),
  id, providerId: providerIdSchema.optional(), projectId: providerEntityId, title: id, modelId: z.string(),
  /** Who named this thread: the user by hand, Sotto through the thread's own provider, or the stand-in/provider name.
   * Absent on threads saved before Sotto recorded it, which counts as `default`. */
  titleSource: z.enum(['user', 'default', 'generated']).optional(),
  /**
   * The title is a first-message title: the opening words of the thread's first message, held until its generated
   * title lands. Its `titleSource` stays `default`, the value host protocol v1 carries for it; this optional field
   * is what keeps a provider's own name from overwriting it.
   */
  titledFromFirstMessage: z.boolean().optional(),
  reasoningEffort: z.string().optional(), runtimeMode: agentRuntimeModeSchema.optional(),
  /** The provider's own permission mode this thread is set to, where the provider names its own. */
  providerMode: providerEntityId.optional(),
  status: z.enum(['idle', 'running', 'error']),
  workingDirectory: z.string().optional(), worktree: agentWorktreeSchema.optional(),
  /** The last stacked Git action run on this thread's folder, as it runs and once it is over (ADR-0027). */
  gitAction: gitActionProgressSchema.optional(),
  /** The pull requests linked to this thread: the one its Git action created, ones linked by hand, one checked out
   * from the branch picker. Newest last; the Pull request surface lists them (ADR-0027). */
  pullRequests: z.array(gitPullRequestLinkSchema).max(GIT_PULL_REQUEST_LINKS_MAX).optional(),
  /** The pull requests this thread babysits: which, who started each and since when (ADR-0061 decision 10). The
   * host keeps what the thread was last told; clients get only this. Absent when it babysits none, and from older hosts. */
  babysitting: z.array(agentBabysittingSchema).max(BABYSITTING_PER_THREAD_MAX).optional(),
  /** The newest wake-ups babysitting sent this thread, by message ID, oldest first (ADR-0061 decision 8): the host's own
   * record of what it sent, never read from a message's text, so a row can say Sotto sent its last message. */
  wakeUpMessageIds: z.array(id).max(WAKE_UP_MESSAGE_IDS_MAX).optional(),
  /** Sotto organization only: does not close native work or suppress attention. */
  workspaceSettledAt: z.string().datetime().nullable().optional(),
  /** False only before Sotto dispatches native creation. Unknown is conservatively locked. */
  nativeSessionStarted: z.boolean().optional(),
  /** The thread's provider session is open on its host now: its client is running and holds the session, so the next
   * send does not start it. Absent while it is stopped or not started yet, and from hosts that predate it. Never saved. */
  providerSessionOpen: z.literal(true).optional(),
  /** Provider activity time; omitted when unknown, never the time Sotto observed the thread. */
  updatedAt: z.string().optional(),
  /** Explicit lifecycle metadata. Null clears a prior value; omission means unknown. */
  settledAt: z.string().nullable().optional(), archivedAt: z.string().nullable().optional(),
  settledOverride: z.enum(['settled', 'active']).nullable().optional(),
  messages: z.array(agentMessageSchema), requests: z.array(agentRequestSchema),
  /** Present on the shell stream, where `messages` is empty; absent when the messages themselves are here. */
  summary: agentThreadSummarySchema.optional(),
  /** The thread finished its work while no client showed it, and no client has shown it since (ADR-0046). The host's
   * coordinator sets and clears it; absent otherwise, and from hosts that predate it. */
  finishedUnread: z.literal(true).optional(),
  /** The newest message of the user's the provider's adapter has recorded, whether or not `messages` still
   * holds it. A send names it back so the adapter can refuse one that raced the user's own input; a window
   * the adapter put away and took back up carries none of the older messages, so it cannot say. */
  lastUserMessageId: z.string().optional(),
  /** True when the thread store holds messages older than the window `messages` carries (issue #119). */
  earlierAvailable: z.boolean().optional(),
  activities: z.array(agentActivitySchema).max(MAX_AGENT_ACTIVITIES).optional(),
  /** Ephemeral provider-confirmed watches; never reconstructed from saved activity. */
  monitoring: agentMonitoringSchema.optional(),
  /** Ephemeral provider-confirmed agent work still running for this thread; never reconstructed from saved activity. */
  backgroundWork: agentBackgroundWorkSchema.optional(),
  /** Tiny current counts; the retained roster is read through its own paged bridge. */
  subagentSummary: subagentSummarySchema.optional(),
  usage: threadUsageSchema.optional(),
  compaction: compactionSchema.optional(),
  manualCompactionSupported: z.boolean().optional(),
  resumeCompactionDismissed: z.boolean().optional(),
  /** Native outcome evidence for queue admission; never an authority to replay work. */
  lastTurn: z.object({ id: z.string(), status: z.enum(['running', 'completed', 'interrupted', 'failed']) }).optional(),
  /** Omitted by providers that already supply history; absence means ready. */
  historyStatus: z.enum(['loading', 'ready', 'error']).optional(), historyError: z.string().optional(),
  historySaveNotice: z.string().max(600).optional(),
  /** A native request refused because Sotto could not show it; never a pending request or an approval. */
  requestNotice: z.string().max(600).optional(),
  /** Changes only on a confirmed native rewind; cached activity must not cross it. */
  historyEpoch: z.string().optional(),
})
export const agentCapabilitiesSchema = z.object({
  projects: z.boolean(), threads: z.boolean(), submit: z.boolean(),
  observe: z.boolean(), questions: z.boolean(), permissions: z.boolean(),
  interrupt: z.boolean(), messageOrigin: z.boolean(), reconcile: z.boolean(),
  configureThread: z.boolean().optional(), skills: z.boolean().optional(),
  /** False when a started thread can change only its permission mode, not its model or reasoning. */
  configureThreadModel: z.boolean().optional(),
  steer: z.boolean().optional(),
  compact: z.boolean().optional(),
})
export const agentProviderStatusSchema = z.object({
  id: providerIdSchema, connection: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  name: z.string(), version: z.string(), error: z.string().optional(), capabilities: agentCapabilitiesSchema,
  /** Set when the connected client is newer than the version Sotto's adapter was checked against. */
  verifiedVersion: z.string().max(64).optional(),
  /** Why it is not connected, when its last connect failed for a reason the adapter could name (ADR-0037). */
  problem: providerProblemSchema.optional(),
  /** With `too-old`: the oldest version Sotto accepts, when the adapter's floor is a version (ADR-0035). */
  requiredVersion: z.string().max(64).optional(),
  /** What it is signed in with, while connected, when its client says. */
  account: providerAccountSchema.optional(),
})
export type AgentProviderStatus = z.infer<typeof agentProviderStatusSchema>
/**
 * What main answers when the provider refused an action outright: it answered, and it did not take it. Nothing
 * is left waiting to reconcile, so a window may say that nothing changed; the option chips read this exact sentence.
 */
export const PROVIDER_REJECTED_ACTION = 'The provider rejected this action. Check its current permissions and account status.'
/** What main answers when the provider did not say whether it took an action; Sotto keeps it and checks it later. */
export const PROVIDER_RESULT_UNCONFIRMED = 'The provider did not confirm the result. Sotto will reconcile the existing action when reconnected; it will not resend it.'
/** What main answers when a folder sent as existing is not there, so nothing was added and no folder was made. */
export const PROJECT_FOLDER_MISSING = 'That folder no longer exists. Nothing was added. Choose another folder.'
/** What main answers when the provider took a settings change its thread does not show yet; Sotto keeps it and checks it later. */
export const THREAD_SETTINGS_UNRECONCILED = 'The provider has not confirmed these thread settings in its state. Refresh to reconcile the existing save; it will not be replayed.'
/** What main answers when Restore branch needs the user's word first; the pane opens its confirmation on this exact sentence. */
export const RESTORE_BRANCH_NEEDS_CONFIRMATION = 'This folder has uncommitted changes. They move with the switch, so confirm it first.'
/** What main answers when reclaiming a worktree would discard uncommitted work; the pane opens its confirmation on this exact sentence. */
export const RECLAIM_WORKTREE_NEEDS_CONFIRMATION = 'This folder has uncommitted changes. Removing it loses them, so confirm it first.'

/**
 * What Sotto knows about one installed client: the version it connected to, the version its own
 * install channel publishes, and what a press would run. `canInstall` is false when the channel
 * is one Sotto names but will not drive, so the card shows the command instead of a button.
 */
export const clientChannelSchema = z.enum(['npm', 'self-update', 'mise', 'devin-app', 'unknown'])
export type ClientChannel = z.infer<typeof clientChannelSchema>
/**
 * Why an update did not finish, as a code the tile words for itself: `download` when the installer could not fetch the
 * new version, `install-step` when mise installed Grok Build but its package's own install step did not finish, and
 * `installer` for anything else the installer refused.
 */
export const clientUpdateFailureSchema = z.enum(['download', 'install-step', 'installer'])
export type ClientUpdateFailure = z.infer<typeof clientUpdateFailureSchema>
export const providerClientUpdateSchema = z.object({
  id: providerIdSchema,
  installed: z.string().max(64),
  published: z.string().max(64).optional(),
  behind: z.boolean(),
  channel: clientChannelSchema,
  command: z.string().max(300).optional(),
  canInstall: z.boolean(),
  checkedAt: z.string(),
  /** `queued` waits in the machine's one-at-a-time line behind the update that is running. */
  state: z.enum(['idle', 'queued', 'updating', 'updated', 'unchanged', 'failed']).default('idle'),
  error: z.string().max(600).optional(),
  /** When the last update of this client finished, so a press that ran is told from one refused before it did. */
  ranAt: z.string().max(64).optional(),
  /** How many steps a press runs: two for Grok Build under mise, the upgrade and then its package's install step. */
  steps: z.number().int().min(1).max(4).optional(),
  /** The step running while `updating`, or the one that did not finish when `failed`, counted from 1. */
  step: z.number().int().min(1).max(4).optional(),
  failure: clientUpdateFailureSchema.optional(),
  /** The command to run on the machine by hand, a line each: for a failed update, and for a channel Sotto will not drive. */
  byHand: z.array(z.string().min(1).max(300)).max(4).optional(),
  /** The last lines the installer printed when it failed, with home folders taken out. */
  printed: z.string().max(1200).optional(),
})
export type ProviderClientUpdate = z.infer<typeof providerClientUpdateSchema>
/**
 * The client updates a machine is running one at a time: how many were asked for since its line was last empty, and
 * how many of those have finished. Absent while the line is empty.
 */
export const clientUpdateRunSchema = z.object({ total: z.number().int().min(1).max(64), done: z.number().int().min(0).max(64),
  /** The clients still waiting, in the order they will run, after the one running. */
  line: z.array(providerIdSchema).max(8).optional() })
export type ClientUpdateRun = z.infer<typeof clientUpdateRunSchema>
/** One connected host's catalog, as the desktop keeps it apart from the others when it combines threads. */
export const agentClientHostSchema = z.object({ hostId: z.uuid(), connected: z.boolean(), models: z.array(agentModelSchema),
  capabilities: agentCapabilitiesSchema, providers: z.array(agentProviderStatusSchema).optional(),
  /** The host's client updates and its update line, sent only from a host that offers `client-updates` (ADR-0042). */
  clientUpdates: z.array(providerClientUpdateSchema).max(4).optional(), clientUpdateRun: clientUpdateRunSchema.optional(),
  /** The host lists `pull-request-babysit`: the Pull request surface offers Babysit pull request on its threads (ADR-0061 decision 11). */
  pullRequestBabysit: z.literal(true).optional() })
export type AgentClientHost = z.infer<typeof agentClientHostSchema>

export const agentHostSnapshotSchema = z.object({
  /** Desktop projection only: catalogs stay with their host when a window combines threads. */
  clientHosts: z.array(agentClientHostSchema).optional(),
  hostId: z.uuid().optional(),
  providers: z.array(agentProviderStatusSchema).optional(),
  connected: z.boolean(), name: z.string(), version: z.string(),
  /** Set when the connected client is newer than the version this adapter was checked against. */
  verifiedVersion: z.string().max(64).optional(),
  error: z.string().optional(),
  /** One adapter's own snapshot: why it is not connected, and what it is signed in with (ADR-0037). */
  problem: providerProblemSchema.optional(),
  requiredVersion: z.string().max(64).optional(),
  account: providerAccountSchema.optional(),
  capabilities: agentCapabilitiesSchema,
  models: z.array(agentModelSchema), projects: z.array(agentProjectSchema),
  threads: z.array(agentThreadSchema),
})
export type AgentModel = z.infer<typeof agentModelSchema>
export type AgentProject = z.infer<typeof agentProjectSchema>
export type AgentRequest = z.infer<typeof agentRequestSchema>
export type AgentMessage = z.infer<typeof agentMessageSchema>
export type AgentThread = z.infer<typeof agentThreadSchema>
/**
 * What a thread says about its provider only while the host that said it is connected: its monitors, its background
 * work and whether its provider session is open. Gone wherever a thread outlives that connection (a disconnect, a
 * provider a snapshot no longer reaches, the window's startup cache), and never saved.
 */
export const NO_LIVE_THREAD_STATE = { monitoring: undefined, backgroundWork: undefined, providerSessionOpen: undefined } as const
/** Drop a thread's live state in place: see `NO_LIVE_THREAD_STATE`. */
export function dropLiveThreadState(thread: AgentThread): void {
  delete thread.monitoring; delete thread.backgroundWork; delete thread.providerSessionOpen
}
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>
export function supportsAgentSupervision(capabilities: AgentCapabilities): boolean {
  return capabilities.observe && capabilities.questions && capabilities.permissions
    && capabilities.messageOrigin && capabilities.reconcile
}
export type AgentHostSnapshot = z.infer<typeof agentHostSnapshotSchema>

export const subscriptionProviderSchema = z.enum(['codex', 'claude', 'grok'])
export type SubscriptionProvider = z.infer<typeof subscriptionProviderSchema>
export const subscriptionAccountSchema = z.object({
  provider: subscriptionProviderSchema, label: z.string(), installed: z.boolean(), ready: z.boolean(),
  detail: z.string(),
  /** Why it is not ready, when the client could say (ADR-0037), and the plan it is signed in with when it is. */
  problem: providerProblemSchema.optional(), account: providerAccountSchema.optional(),
  models: z.array(z.object({
    id: z.string(), name: z.string(),
    /** Least to most thorough, the last being the highest level, as on `agentModelSchema.reasoningEfforts`. */
    reasoningEfforts: z.array(z.string()).optional(),
    defaultReasoningEffort: z.string().optional(),
  })),
  defaultModelId: z.string().optional(), allowCustomModel: z.boolean().optional(),
})
export type SubscriptionAccount = z.infer<typeof subscriptionAccountSchema>
export function isSubscriptionReasoning(provider: string): provider is SubscriptionProvider {
  return provider === 'codex' || provider === 'claude' || provider === 'grok'
}

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', devin: 'Devin',
}
export const agentConfigurationSchema = z.object({
  provider: providerIdSchema.default('codex'),
  enabledProviders: z.array(providerIdSchema).max(4).refine(ids => new Set(ids).size === ids.length, 'Choose each provider once.').optional(),
  /**
   * The providers the user turned off: each one disconnected by name, or left out of a changed enabled set, and not
   * connected again since. A headless host connects every other provider that is installed and signed in when it
   * starts, so this is what keeps a turned-off one off across restarts; `enabledProviders` alone cannot tell
   * "never asked" from "turned off" (ADR-0036). Absent until the user turns one off.
   */
  disconnectedProviders: z.array(providerIdSchema).max(4).refine(ids => new Set(ids).size === ids.length, 'Choose each provider once.').optional(),
  enabled: z.boolean(),
  projectsDirectory: z.string().max(4_096),
  defaultModelId: z.string().max(6_144),
  followupLimit: z.number().int().min(0).max(100),
  reasoning: z.enum(['none', 'codex', 'claude', 'grok', 'openrouter', 'openai']),
  reasoningModel: z.string().max(512),
  reasoningEffort: z.string().max(64).default(''),
  checkClientUpdates: z.boolean().default(true),
  /**
   * What a new thread in a project starts on, apart from the coordinator's reasoning model and effort
   * (issue #347): the model a create-thread that leaves one unset takes, empty until chosen so an existing
   * install keeps following the reasoning-based default (`defaultThreadModelId`). `newThreadReasoningEffort`
   * is empty the same way, meaning the chosen model's own default; `newThreadRuntimeMode` is absent the same
   * way, meaning the provider's own starting mode. Settings → Agents' "New threads start with" row is the
   * only place that sets them; a provider that does not offer the chosen mode or effort starts on the
   * nearest one it does (`src/shared/newThreadDefaults.ts`).
   */
  newThreadModelId: z.string().max(6_144),
  newThreadReasoningEffort: z.string().max(64).default(''),
  newThreadRuntimeMode: agentRuntimeModeSchema.optional(),
}).strict()
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>
export const defaultAgentConfiguration = (): AgentConfiguration => ({
  provider: 'codex',
  enabled: false, projectsDirectory: '', defaultModelId: '',
  followupLimit: 5, reasoning: 'none', reasoningModel: '', reasoningEffort: '', checkClientUpdates: true,
  newThreadModelId: '', newThreadReasoningEffort: '',
})

export const agentAssignmentSchema = z.object({
  threadId: id, mode: z.enum(['managed', 'manual']), instruction: text,
  followups: z.number().int().nonnegative(), paused: z.boolean(),
  seenMessageIds: z.array(z.string()), ownMessageIds: z.array(z.string()),
  handledRequestIds: z.array(z.string()), lastFailure: z.string(),
  contextUpdatedAt: z.number().default(0),
  /** ISO time the assignment began (assign or create-thread). Empty for assignments saved before it was recorded. */
  startedAt: z.string().default(''),
  /** How the current instruction reached the thread: a spoken "send it", a typed Send, or not yet known. */
  origin: z.enum(['voice', 'typed', 'unknown']).default('unknown'),
  /** Why Sotto stopped managing on its own; 'none' while managing or after a user pause. Cleared by resume. */
  stopReason: z.enum(['none', 'limit', 'repeat', 'error']).default('none'),
  /** ISO time of that stop; empty when stopReason is 'none'. */
  stoppedAt: z.string().default(''),
})
export type AgentAssignment = z.infer<typeof agentAssignmentSchema>
export const agentQueueItemSchema = z.object({
  id, threadId: id, kind: z.enum(['ready', 'question', 'permission', 'blocked']),
  text, requestId: z.string().optional(), createdAt: z.string(), deferred: z.boolean(),
})
export type AgentQueueItem = z.infer<typeof agentQueueItemSchema>
export const MAX_DELIVERED_DRAFTS = 128
export const agentThreadDraftSchema = z.object({
  threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentHandlesSchema, skills: agentSkillReferencesSchema.optional(),
  files: agentFileReferencesSchema.optional(),
  requestId: id.nullable(), updatedAt: z.string().datetime(),
})
export type AgentThreadDraft = z.infer<typeof agentThreadDraftSchema>
/**
 * The follow-up queue's items: the user's own follow-ups, independent of attention and dispatched outbox intent, and
 * at most one of Sotto's own, a `wakeUp` babysitting is holding until the thread is ready (ADR-0061 decision 8), after
 * the user's items, removable and never editable. Its draft ID is its own, so an older reader still reads the queue;
 * no draft or delivery receipt goes with it.
 */
export const agentFollowupSchema = z.object({
  id: z.uuid(), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentHandlesSchema, skills: agentSkillReferencesSchema.optional(),
  files: agentFileReferencesSchema.optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  status: z.enum(['queued', 'dispatching', 'uncertain', 'failed', 'paused']),
  error: z.string().optional(), commandId: id.optional(), messageId: id.optional(), resumeAfterTurnId: id.optional(),
  wakeUp: z.literal(true).optional().catch(undefined),
})
export type AgentFollowup = z.infer<typeof agentFollowupSchema>
export const agentDeliverySchema = z.object({
  threadId: id, draftId: z.uuid(),
  status: z.enum(['queued', 'submitting', 'accepted', 'failed', 'uncertain']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  commandId: id.optional(), messageId: id.optional(),
  /** The exact stable Send packet this delivery belongs to; evidence, never authority. */
  packetDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  localFeedbackMs: z.number().nonnegative().optional(), providerLatencyMs: z.number().nonnegative().optional(),
})
export type AgentDelivery = z.infer<typeof agentDeliverySchema>
export const agentDeliveryReceiptsSchema = z.array(z.object({ threadId: id, draftId: z.uuid() })).max(MAX_DELIVERED_DRAFTS)
export const providerUpgradeSchema = z.object({ recoveryPath: z.string(), migratedAt: z.number() })
export const agentStateSchema = z.object({
  legacyManagement: z.boolean().optional(),
  worktreeReclaimPreview: worktreeReclaimPreviewSchema.optional(),
  clientScoped: z.boolean().optional(),
  connections: z.array(z.object({ hostId: z.uuid(), name: z.string(), kind: z.enum(['local', 'remote']), connected: z.boolean() })).optional(),
  hostId: z.uuid().optional(),
  configuration: agentConfigurationSchema,
  skillCatalogs: z.array(agentSkillCatalogSchema).optional(),
  providerUpgrade: providerUpgradeSchema.nullable().optional(),
  clientUpdates: z.array(providerClientUpdateSchema).max(4).optional(),
  clientUpdateRun: clientUpdateRunSchema.optional(),
  /** The card stays down until the next check finds something else. */
  clientUpdatesDismissedAt: z.string().optional(),
  connection: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  host: agentHostSnapshotSchema,
  assignments: z.array(agentAssignmentSchema), queue: z.array(agentQueueItemSchema),
  activeThreadId: z.string().nullable(), activeProjectId: z.string().nullable(),
  draft: text, draftThreadId: z.string().nullable(), composing: z.boolean(),
  draftAttachments: agentAttachmentHandlesSchema.optional(),
  deliveredDrafts: agentDeliveryReceiptsSchema.optional(),
  /** Exact revisions superseded or explicitly cleared. This is not native delivery evidence. */
  obsoleteDrafts: agentDeliveryReceiptsSchema.optional(),
  threadDrafts: z.array(agentThreadDraftSchema).optional(),
  /** Main-only, ephemeral evidence for these exact revisions, including empty draft clears.
   * Missing evidence never confirms persistence. It is rebuilt from disk on startup. */
  threadDraftPersistence: z.array(z.object({
    threadId: id, draftId: z.uuid(), status: z.enum(['saved', 'saving', 'unsaved']),
  })).optional(),
  deliveries: z.array(agentDeliverySchema).optional(),
  followups: z.array(agentFollowupSchema).optional(),
  followupReceipts: agentDeliveryReceiptsSchema.optional(),
  draftRequestId: z.string().nullable(),
  pendingRequest: z.string().max(20_000),
  /**
   * The one global lane is occupied: a command with no thread, or one that moves assignment authority,
   * the composer draft or a whole project. It says nothing about any thread's own lane — the provider
   * and configuration surfaces are what read it.
   */
  globalLaneBusy: z.boolean(), notice: z.string(), error: z.string().nullable(),
  /**
   * The threads whose own lane is running a command right now. A command that names one thread waits
   * only on that thread, so `globalLaneBusy` cannot say which threads are working: a thread's own
   * surfaces read this instead. Absent when no thread lane is running.
   */
  busyThreadIds: z.array(id).max(1_000).optional(),
  /**
   * The thread settings changes whose result the provider never gave: main keeps each one until the thread shows
   * it or the provider says otherwise, and takes no other action on the thread meanwhile. Absent when there are none.
   */
  unconfirmedSettings: z.array(agentThreadOptionsSchema.extend({ threadId: id })).max(1_000).optional(),
  credentials: z.object({ reasoning: z.boolean(), secure: z.boolean() }),
  reasoningAccounts: z.array(subscriptionAccountSchema).default([]),
  /** Whether the user keeps local history; the window persists its startup shell only when true. */
  historyEnabled: z.boolean().optional(),
  /** True only for the shell the window painted from its own cache before main answered. */
  stale: z.boolean().optional(),
})
export type AgentState = z.infer<typeof agentStateSchema>

/**
 * A model catalog as it may cross the `AGENT_STATE` broadcast on `sotto:agents:state` (issue #286): the
 * full array, tagged with the revision it represents, or that revision alone when the window it is going
 * to was already sent it. Only the coalesced broadcast in `src/main/index.ts` ever sends a catalog in full
 * this way, and it omits one only after a send it knows reached that window. The revision is what keeps
 * an omission from ever being read as an empty catalog: a window missing the one it names — fresh,
 * reloaded, or a message it never saw — asks `AGENT_GET` for the whole state instead of showing no
 * models. Nothing parses this shape: the preload forwards it to the page unparsed (contextBridge would
 * otherwise copy a catalog it just put back together a second time crossing back), and the page's own
 * reassembly reads it structurally, the same way `trustedState` does for the rest of this channel. See
 * ADR-0028 and `src/renderer/src/agents/agentStateCatalogs.ts`.
 */
export type AgentModelCatalogBroadcast =
  | { revision: number; models: AgentModel[] }
  | AgentModelCatalogRevision
export type AgentClientHostBroadcast = Omit<AgentClientHost, 'models'> & { models: AgentModelCatalogBroadcast }
export type AgentHostSnapshotBroadcast = Omit<AgentHostSnapshot, 'models' | 'clientHosts'> & {
  models: AgentModelCatalogBroadcast
  clientHosts?: AgentClientHostBroadcast[]
}
/** What actually crosses `sotto:agents:state`: `AgentState` with its catalogs replaced by `AgentModelCatalogBroadcast`. */
export type AgentStateBroadcast = Omit<AgentState, 'host'> & { host: AgentHostSnapshotBroadcast }

const PRIMARY_CATALOG_KEY = '__primary__'

/**
 * The key main's catalog revisions and the page's catalog cache both file `host.models` under (ADR-0028).
 * A broadcast, a command receipt and the page's recovery all resolve by it, so the two sides must agree.
 * The primary host has no host ID and takes a fixed key.
 */
export function hostCatalogKey(hostId: string | undefined): string {
  return `host:${hostId ?? PRIMARY_CATALOG_KEY}`
}

/** The key for one `host.clientHosts[]` entry's catalog, kept apart from `hostCatalogKey` (see `AgentStateBroadcaster`). */
export function clientCatalogKey(hostId: string): string {
  return `client:${hostId}`
}

/**
 * A catalog named by its catalog revision alone. The broadcast sends one in place of a catalog the window
 * was already sent, and a command receipt always does (issue #323).
 */
export const agentModelCatalogRevisionSchema = z.object({ revision: z.number().int().nonnegative(), omitted: z.literal(true) }).strict()
export type AgentModelCatalogRevision = z.infer<typeof agentModelCatalogRevisionSchema>

/**
 * What `AGENT_COMMAND` answers the window with (issue #323, ADR-0028's September 26 amendment): the shell
 * after the command, with its outcome (`error`, `notice`), its evidence (`threadDraftPersistence` for the
 * draft revision saved, `configuration` for the effective settings) and every other field of the shell whole,
 * changed or not, but each model catalog named by its catalog revision instead of listed. The revisions come from the same
 * counter as the broadcast's, so the page resolves a receipt from the catalogs the broadcast already sent
 * it and recovers through `AGENT_GET` when it holds a different revision.
 */
export const agentCommandReceiptSchema = agentStateSchema.extend({
  host: agentHostSnapshotSchema.extend({
    models: agentModelCatalogRevisionSchema,
    clientHosts: z.array(agentClientHostSchema.extend({ models: agentModelCatalogRevisionSchema })).optional(),
  }),
})
export type AgentCommandReceipt = z.infer<typeof agentCommandReceiptSchema>

/**
 * One viewed thread's history, pushed and fetched apart from the shell stream: its messages and the
 * activity beside them. Activity is the larger half by far — a working thread reports hundreds of
 * records — and, like the messages, only the open pane draws it.
 */
export const agentThreadDetailSchema = z.object({
  threadId: id, revision: z.number().int().nonnegative(), messages: z.array(agentMessageSchema),
  activities: z.array(agentActivitySchema).max(MAX_AGENT_ACTIVITIES).optional(),
  /** True when older messages are still in the thread store; the pane offers Show earlier messages. */
  earlierAvailable: z.boolean().optional(),
}).strict()
export type AgentThreadDetail = z.infer<typeof agentThreadDetailSchema>
export const agentThreadDetailResultSchema = agentThreadDetailSchema.nullable()
export const agentThreadDetailRequestSchema = id
/**
 * What changed in one viewed thread since the revision the window already holds, sent in place of the
 * whole detail while an agent streams into it: a message that grew by a chunk costs the chunk, not the
 * thread. A message delta is a whole message — new, or changed in a way an append cannot say — or the
 * suffix a streaming message grew by; an activity delta is one record as it now stands, or its removal.
 * The window applies one only when `baseRevision` is the revision it holds, and asks for the whole
 * detail when it is not. The full form remains for first delivery and for that resync.
 */
export const agentMessageDeltaSchema = z.union([
  z.object({ message: agentMessageSchema }).strict(),
  z.object({ id, appendText: z.string() }).strict(),
])
export type AgentMessageDelta = z.infer<typeof agentMessageDeltaSchema>
export const agentActivityDeltaSchema = z.union([
  z.object({ record: agentActivitySchema }).strict(),
  z.object({ id: z.string(), removed: z.literal(true) }).strict(),
])
export type AgentActivityDelta = z.infer<typeof agentActivityDeltaSchema>
export const agentThreadDetailDeltaSchema = z.object({
  threadId: id, baseRevision: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  messageDeltas: z.array(agentMessageDeltaSchema),
  activityDeltas: z.array(agentActivityDeltaSchema).max(MAX_AGENT_ACTIVITIES),
}).strict()
export type AgentThreadDetailDelta = z.infer<typeof agentThreadDetailDeltaSchema>
export const agentThreadDetailUpdateSchema = z.union([agentThreadDetailSchema, agentThreadDetailDeltaSchema])
export type AgentThreadDetailUpdate = z.infer<typeof agentThreadDetailUpdateSchema>

/**
 * Whether a message is a visual an agent drew (ADR-0056): Sotto's own `visual:` message, carrying the visual. This is
 * the one test for it. A visual message is never the final reply, never folds, and is left out of summaries, search,
 * titles and supervision. A `visual:` message without a visual it can read (a shape this reader does not know, or a
 * socket client's copy, which never carries one) is its words alone, and counts as a reply everywhere. The `visual`
 * field is asked first, so a pass over a long history reads no other message's ID.
 */
export function isVisualMessage<T extends Pick<AgentMessage, 'id' | 'visual'>>(message: T): message is T & { visual: AgentVisual } {
  return message.visual !== undefined && message.id.startsWith(VISUAL_MESSAGE_PREFIX)
}
/** The newest message that is not a visual: the last thing the agent or the user wrote. */
export function lastWrittenMessage<T extends Pick<AgentMessage, 'id' | 'visual'>>(messages: readonly T[]): T | undefined {
  return messages.findLast(message => !isVisualMessage(message))
}
/**
 * The sidebar's facts about a thread's history, derived from the history itself. A visual's message is Sotto's, not the
 * agent's words, so it is left out: sidebar rows and search keep what the agent wrote.
 */
export function summarizeThread(thread: Pick<AgentThread, 'messages' | 'activities'>): AgentThreadSummary {
  const { activities = [] } = thread
  const messages = thread.messages.some(isVisualMessage) ? thread.messages.filter(message => !isVisualMessage(message)) : thread.messages
  const cut = (message: AgentMessage): z.infer<typeof threadExcerptSchema> =>
    ({ id: message.id, text: message.text.slice(0, AGENT_THREAD_EXCERPT_MAX), createdAt: message.createdAt })
  const lastUser = messages.findLast(message => message.role === 'user')
  const lastAssistant = messages.findLast(message => message.role === 'assistant')
  let latestAt = Number.NaN
  let lastMessageAt: string | undefined
  for (const message of messages) {
    const at = Date.parse(message.createdAt)
    if (Number.isFinite(at) && (lastMessageAt === undefined || at > latestAt)) {
      latestAt = at
      lastMessageAt = message.createdAt
    }
  }
  const running = activities.filter(record => record.kind === 'turn' && record.status === 'running')
    .sort((first, second) => first.sequence - second.sequence).at(-1)
  return { messageCount: messages.length, activityCount: activities.length,
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(lastUser === undefined ? {} : { lastUser: cut(lastUser) }),
    ...(lastAssistant === undefined ? {} : { lastAssistant: cut(lastAssistant) }),
    ...(running?.startedAt === undefined ? {} : { runningTurnStartedAt: running.startedAt }) }
}
/**
 * Whether a thread's provider writes Sotto's short text for it: its title, its branch name and its Git
 * drafts, each in a side call (ADR-0026). Devin has no one-off call that keeps out of its own session
 * list, so a Devin thread keeps its first-message title or stand-in and is offered no Regenerate that could do nothing.
 */
export function providerWritesShortText(providerId: ProviderId | undefined): boolean {
  return providerId !== 'devin'
}
/** The same facts, from the summary the shell carries or from the history a full state holds. */
export function threadSummaryOf(thread: Pick<AgentThread, 'messages' | 'activities' | 'summary'>): AgentThreadSummary {
  return thread.summary ?? summarizeThread(thread)
}
/** The user's newest message as the adapter recorded it, which a send names for the stale-reply check. A
 * host that does not say yet (an older remote host) leaves the window's newest user message to stand in. */
export function lastUserMessageIdOf(thread: Pick<AgentThread, 'messages' | 'lastUserMessageId'>): string | null {
  return thread.lastUserMessageId ?? thread.messages.findLast(message => message.role === 'user')?.id ?? null
}
/** One thread on the shell stream: summaries with message excerpts and pending requests, without full message lists. */
function threadShell(thread: AgentThread): AgentThread {
  return { ...thread, messages: [], ...(thread.activities === undefined ? {} : { activities: [] }), summary: threadSummaryOf(thread) }
}
/** The published state with every thread's history replaced by its summary. */
export function agentShell(state: AgentState): AgentState {
  return { ...state, host: { ...state.host, threads: state.host.threads.map(threadShell) } }
}
export const agentCommandSchema = z.discriminatedUnion('type', [
  // Re-extend defaulted fields: Zod 4 applies defaults through partial(), resetting omitted settings.
  z.object({ type: z.literal('configure'), patch: agentConfigurationSchema.partial().extend({ provider: providerIdSchema.optional(), reasoningEffort: z.string().max(64).optional(), checkClientUpdates: z.boolean().optional(), newThreadReasoningEffort: z.string().max(64).optional() }) }).strict(),
  z.object({ type: z.literal('credential'), slot: z.enum(['reasoning']), value: z.string().max(16_384) }).strict(),
  z.object({ type: z.literal('connect'), provider: providerIdSchema.optional() }).strict(),
  z.object({ type: z.literal('disconnect'), provider: providerIdSchema.optional() }).strict(),
  z.object({ type: z.literal('refresh'), provider: providerIdSchema.optional() }).strict(),
  z.object({ type: z.literal('refresh-thread-skills'), threadId: id, forceReload: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('check-reasoning'), provider: subscriptionProviderSchema }).strict(),
  z.object({ type: z.literal('check-client-updates') }).strict(),
  z.object({ type: z.literal('update-client'), provider: providerIdSchema, force: z.boolean().optional() }).strict(),
  /** Puts clients in the machine's one-at-a-time update line and answers at once; each client's reading says how it went. */
  z.object({ type: z.literal('queue-client-updates'), providers: z.array(providerIdSchema).min(1).max(4) }).strict(),
  /** Takes clients that are still waiting out of the update line. One already running is left to finish. */
  z.object({ type: z.literal('cancel-client-updates'), providers: z.array(providerIdSchema).min(1).max(4) }).strict(),
  z.object({ type: z.literal('dismiss-client-updates') }).strict(),
  z.object({ type: z.literal('utterance'), text }).strict(),
  z.object({ type: z.literal('compose'), threadId: id.optional(), draftId: z.uuid().optional(), text, attachments: agentAttachmentHandlesSchema.optional() }).strict(),
  z.object({ type: z.literal('save-thread-draft'), threadId: id, draftId: z.uuid(), expectedDraftId: z.uuid().nullable().optional(), text,
    attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional(), requestId: id.nullable().optional(),
    questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), composer: z.literal('manual').optional() }).strict()
    .refine(value => value.questionsDigest === undefined || Boolean(value.requestId), 'Use the original question ID with its form digest.'),
  z.object({ type: z.literal('recover-draft'), threadId: id }).strict(),
  z.object({ type: z.literal('send'), draft: z.object({ threadId: id, draftId: z.uuid().optional(), text,
    attachments: agentAttachmentHandlesSchema.optional(),
    binding: z.object({ requestId: id.nullable(), questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable() }).strict()
      .refine(value => (value.requestId === null) === (value.questionsDigest === null), 'Use a question ID with its form digest, or neither.').optional(),
  }).strict().optional() }).strict(),
  z.object({ type: z.literal('manual-send'), threadId: id, text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional(), draftId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('queue-followup'), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('edit-followup'), threadId: id, itemId: z.uuid(), text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('steer-followup'), threadId: id, itemId: z.uuid() }).strict(),
  z.object({ type: z.literal('remove-followup'), threadId: id, itemId: z.uuid() }).strict(),
  z.object({ type: z.literal('reorder-followups'), threadId: id, itemIds: z.array(z.uuid()).max(100) }).strict(),
  z.object({ type: z.literal('resume-followups'), threadId: id }).strict(),
  z.object({ type: z.literal('steer'), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('cancel-draft') }).strict(),
  z.object({ type: z.literal('pause-draft') }).strict(),
  z.object({ type: z.literal('resume-draft'), threadId: id }).strict(),
  z.object({ type: z.literal('cancel-request') }).strict(),
  z.object({ type: z.literal('create-project'), provider: providerIdSchema.optional(), title: id, path: z.string().max(4_096).optional(), useExisting: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('select-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('settle-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('restore-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('settle-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('restore-thread'), threadId: id }).strict(),
  /** A pure Sotto-side edit of the thread's name; the trimmed title must not be empty. */
  z.object({ type: z.literal('rename-thread'), threadId: id, title: z.string().max(512) }).strict(),
  /** Ask the thread's own provider for its name again, on the side, replacing a generated or stand-in one. */
  z.object({ type: z.literal('regenerate-thread-title'), threadId: id }).strict(),
  z.object({ type: z.literal('create-thread'), projectId: providerEntityId, title: id, modelId: providerEntityId,
    /** `user` when the title is the one the user typed, `default` when it is Sotto's stand-in name. */
    titleSource: z.enum(['user', 'default']).optional(),
    /** The Sotto thread ID the window already minted and is showing. Absent from voice and older callers, which let main mint one. */
    threadId: z.uuid().optional(),
    workingCopy: z.enum(['independent', 'shared']).optional(),
    baseBranch: z.string().min(1).max(512).optional(), startFromOrigin: z.boolean().optional(), existingWorktreePath: z.string().min(1).max(4096).optional(),
    reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional(), providerMode: providerEntityId.optional(), managed: z.boolean().optional() }).strict(),
  z.object({ type: z.enum(['retry-thread-worktree', 'open-thread-folder']), threadId: id }).strict(),
  /** Read the thread's folder again, remote and all. `background` is a read the window made on its own (it regained focus,
   * a draft began), which asks GitHub only as the timer would: never while its rate limit is paused or below the reserve (#820). */
  z.object({ type: z.literal('refresh-thread-worktree'), threadId: id, background: z.boolean().optional() }).strict(),
  /** Switch the thread's worktree back to the branch of its last send. `withUncommittedChanges` is the
   * user's answer to the confirmation; without it a worktree with uncommitted work is left alone. */
  z.object({ type: z.literal('restore-thread-branch'), threadId: id, withUncommittedChanges: z.boolean().optional() }).strict(),
  /** Remove the thread's own worktree folder and keep its branch (ADR-0041). `withUncommittedChanges`
   * is the user's answer to the confirmation; without it a folder with uncommitted work is left alone. */
  z.object({ type: z.literal('preview-reclaim-thread-worktree'), threadId: id }).strict(),
  z.object({ type: z.literal('reclaim-thread-worktree'), threadId: id, withUncommittedChanges: z.boolean().optional(), confirmedIgnored: z.array(z.string()).optional(), confirmedItems: z.array(z.object({ path: z.string(), fileCount: z.number().int().nonnegative() }).strict()).optional(), confirmedRepositories: z.array(z.object({ path: z.string(), changeCount: z.number().int().nonnegative(), unpushedCommitCount: z.number().int().nonnegative().optional(), kind: z.enum(['worktree', 'repository']) }).strict()).optional() }).strict(),
  agentWorkingCopySelectionSchema.extend({ type: z.literal('configure-thread-working-copy'), threadId: id }).strict(),
  /** T3's stacked Git action on the thread's folder: commit, push, create the pull request, or a prefix of the three (ADR-0027).
   * `filePaths` limits the commit to those files; `featureBranch` commits on a new `feature/` branch first; `allowDefaultBranch`
   * is the client's word that pushing from the default branch was confirmed. */
  z.object({ type: z.literal('git-action'), threadId: id, actionId: z.uuid(), action: gitStackedActionSchema,
    commitMessage: z.string().max(10_000).optional(), featureBranch: z.boolean().optional(),
    filePaths: z.array(z.string().min(1).max(4_096)).max(2_000).optional(), allowDefaultBranch: z.boolean().optional() }).strict(),
  /** `git pull --ff-only` on the thread's folder; a diverged branch is refused. */
  z.object({ type: z.literal('git-pull'), threadId: id }).strict(),
  /** Check out a branch in the thread's folder, creating it from HEAD when `create` is set; a remote ref gets a tracking branch. */
  z.object({ type: z.literal('git-switch-branch'), threadId: id, ref: z.string().min(1).max(512), create: z.boolean().optional() }).strict(),
  /** `git init` in a thread's folder that is not a repository yet. */
  z.object({ type: z.literal('git-init'), threadId: id }).strict(),
  /** Publish the thread's repository to GitHub through `gh`, adding `origin` and pushing (GitHub only, ADR-0027). */
  z.object({ type: z.literal('git-publish'), threadId: id, repository: z.string().min(3).max(200), visibility: z.enum(['private', 'public']) }).strict(),
  /** A press on the Pull request surface, run through `gh` on the host's own sign-in: merge with a method, ready or draft,
   * close or reopen, update the branch (`method` rebase for Update with rebase), or turn auto-merge on or off. Only for a
   * pull request the thread knows: its branch's own or one linked to it. */
  z.object({ type: z.literal('git-pull-request-action'), threadId: id, url: gitPullRequestUrlSchema, action: gitPullRequestActionSchema,
    method: gitPullRequestMergeMethodSchema.optional() }).strict(),
  /** Link a pull request to the thread by a GitHub URL or `#42`, or take the link away again. */
  z.object({ type: z.literal('git-link-pull-request'), threadId: id, reference: z.string().min(1).max(2_048) }).strict(),
  z.object({ type: z.literal('git-unlink-pull-request'), threadId: id, url: gitPullRequestUrlSchema }).strict(),
  /** The user's Babysit pull request and Stop babysitting, on a pull request the thread knows (ADR-0061 decision 3). */
  z.object({ type: z.literal('babysit-pull-request'), threadId: id, url: gitPullRequestUrlSchema }).strict(),
  z.object({ type: z.literal('stop-babysitting'), threadId: id, url: gitPullRequestUrlSchema }).strict(),
  /** T3's Checkout pull request: `local` checks it out in the thread's folder with `gh pr checkout`; `worktree` fetches its
   * head as a branch a draft's new worktree takes on first send. */
  z.object({ type: z.literal('git-checkout-pull-request'), threadId: id, reference: z.string().min(1).max(2_048), mode: z.enum(['local', 'worktree']) }).strict(),
  agentThreadOptionsSchema.extend({ type: z.literal('configure-thread'), threadId: id }).strict()
    .refine(value => value.modelId !== undefined || value.reasoningEffort !== undefined || value.runtimeMode !== undefined || value.providerMode !== undefined, 'Choose a thread setting to change.'),
  z.object({ type: z.literal('select-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('observe-threads'), threadIds: z.array(id).max(100) }).strict(),
  /** Widen one thread's loaded window by another twenty turns, because the pane asked for earlier messages. */
  z.object({ type: z.literal('load-earlier-messages'), threadId: id }).strict(),
  /** Early start: the user began typing in this thread's composer, so its provider session is started now rather than
   * inside the next send. Starts nothing a send would not, creates no provider session, worktree or branch, sends no
   * prompt, and says nothing when it cannot start: the send reports its own error (#769). */
  z.object({ type: z.literal('start-thread-session'), threadId: id }).strict(),
  z.object({ type: z.literal('select-attention'), itemId: id }).strict(),
  z.object({ type: z.literal('assign'), threadId: id, instruction: text.optional(), expectedDraftId: z.uuid().nullable().optional() }).strict(),
  z.object({ type: z.literal('unassign'), threadId: id }).strict(),
  z.object({ type: z.literal('resume'), threadId: id, expectedDraftId: z.uuid().nullable().optional() }).strict(),
  z.object({ type: z.literal('pause'), threadId: id }).strict(),
  z.object({ type: z.literal('interrupt'), threadId: id }).strict(),
  z.object({ type: z.literal('compact-thread'), threadId: id }).strict(),
  z.object({ type: z.enum(['next', 'later']) }).strict(),
  z.object({ type: z.literal('answer'), threadId: id, requestId: id, answer: text, approved: z.boolean().optional(), questionAnswers: agentQuestionAnswersSchema.optional(), permissionChoice: id.optional() }).strict(),
])
export type AgentCommand = z.infer<typeof agentCommandSchema>
/** The desktop exposes host-qualified client keys here. The preload decodes them before host IPC. */
export interface AgentBridge {
  workingCopyOptions?(projectId: string): Promise<AgentWorkingCopyOptions>
  /** The branches a thread's folder offers, for the picker; the thread is the window's client-scoped one. */
  gitRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  /** The changed files of a thread's folder with their line counts, for the commit dialog. */
  gitChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  /** One pull request of a thread's, with its checks and what the surface may do; null when the thread has none. */
  gitPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestRead>
  /** One folder's subfolders on a named host, for the Add project dialog's folder browser. */
  hostFolders?(request: HostFoldersClientRequest): Promise<HostFoldersResult>
  chooseProjectDirectory?(): Promise<string | null>
  get(): Promise<AgentState>
  /** The bytes behind one published `preview: { available: true }` marker, or null when nothing is eligible. */
  attachmentPreview?(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult>
  /** Stages an image once on the host that runs `threadId` (the selected host when null) and answers with its handle (ADR-0031). */
  stageAttachment?(request: AgentAttachmentStageRequest): Promise<AgentAttachmentHandle>
  /** A staged image's bytes, for a chip this window holds no copy of; null once its host no longer keeps it. */
  attachmentContent?(request: AgentAttachmentContentRequest): Promise<AgentAttachmentContent | null>
  command(command: AgentCommand): Promise<AgentState>
  onState(listener: (state: AgentState) => void): () => void
  /** One viewed thread's messages, for a thread the window opened before main pushed them. */
  threadDetail?(threadId: string): Promise<AgentThreadDetail | null>
  /** Whole details and the deltas between them; a delta the window cannot apply sends it back to `threadDetail`. */
  onThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
}

/**
 * The agent bridge as the preload exposes it (`window.sotto.agents`): what
 * crosses from main before the page puts the model catalogs back (ADR-0028). A broadcast may omit a catalog
 * the window was already sent, and a command answers with a receipt that names every catalog by revision.
 * `wrapAgentBridge` in `src/renderer/src/agents/agentStateCatalogs.ts` turns it into the `AgentBridge` every
 * consumer reads; nothing else should read a catalog from it.
 */
export interface AgentWireBridge extends Omit<AgentBridge, 'command' | 'onState'> {
  command(command: AgentCommand): Promise<AgentCommandReceipt>
  onState(listener: (state: AgentStateBroadcast) => void): () => void
}

export const EMPTY_AGENT_HOST: AgentHostSnapshot = {
  connected: false, name: 'Codex', version: '', projects: [], threads: [], models: [],
  capabilities: { projects: false, threads: false, submit: false, observe: false,
    questions: false, permissions: false, interrupt: false, messageOrigin: false, reconcile: false },
}

/** Legacy installations retain their selected native provider until explicitly changed. */
export function enabledThreadProviders(configuration: AgentConfiguration): ProviderId[] {
  return [...(configuration.enabledProviders ?? [configuration.provider])]
}
export function hostForThread(host: AgentHostSnapshot, thread: Pick<AgentThread, 'hostId'>): AgentHostSnapshot {
  const source = host.clientHosts?.find(item => item.hostId === thread.hostId)
  return source ? { ...host, ...source, providers: source.providers } : host
}
const INSTALLED_PROVIDER_ORDER = ['codex', 'claude', 'grok'] as const
/**
 * The clients to connect when the current selection is not installed.
 * Codex remains the default when its CLI is present; otherwise Claude Code, then Grok Build.
 * A provider the user turned off stays off. Devin is included only when it was already enabled and its CLI is present.
 * Returns null when the current selection can already connect, or when every installed client was turned off.
 */
export function selectInstalledProviders(configuration: AgentConfiguration, installed: readonly ProviderId[]): Pick<AgentConfiguration, 'provider' | 'enabledProviders'> | null {
  const present = new Set(installed)
  const enabled = enabledThreadProviders(configuration)
  if (present.has(configuration.provider) && enabled.some(id => present.has(id))) return null
  const off = new Set(configuration.disconnectedProviders ?? [])
  const enabledProviders: ProviderId[] = INSTALLED_PROVIDER_ORDER.filter(id => present.has(id) && !off.has(id))
  if (enabled.includes('devin') && present.has('devin') && !off.has('devin')) enabledProviders.push('devin')
  const provider = enabledProviders[0]
  if (!provider) return null
  if (provider === configuration.provider && enabled.length === enabledProviders.length && enabled.every((id, index) => id === enabledProviders[index])) return null
  return { provider, enabledProviders }
}
export function capabilitiesForThread(host: AgentHostSnapshot, thread: AgentThread): AgentCapabilities {
  host = hostForThread(host, thread)
  if (!host.providers || !thread.providerId) return host.capabilities
  return host.providers.find(provider => provider.id === thread.providerId)?.capabilities ?? EMPTY_AGENT_HOST.capabilities
}
/** Public model and project IDs; only the provider boundary reverses them. */
export function publicProviderEntityId(provider: ProviderId, kind: 'model' | 'project', value: string): string {
  return `native:${provider}:${kind}:${encodeURIComponent(value)}`
}
/** The provider, kind and native value a public ID names, or null for any other ID or one whose value will not decode. */
export function parsePublicProviderEntityId(id: string): { readonly provider: ProviderId; readonly kind: 'model' | 'project'; readonly value: string } | null {
  const match = /^native:([a-z]+):(model|project):(.*)$/u.exec(id)
  const provider = providerIdSchema.safeParse(match?.[1])
  if (!match || !provider.success) return null
  try { return { provider: provider.data, kind: match[2] as 'model' | 'project', value: decodeURIComponent(match[3]!) } } catch { return null }
}
/**
 * New threads inherit the native agent selected in Settings. Keep its explicit or account-default
 * model even while unavailable, so the caller can explain what needs to connect instead of changing
 * providers. Without a native agent (none or an API account), use a ready thread provider. The old
 * separate defaultModelId preference no longer participates in this choice.
 */
export function defaultThreadModelId(configuration: AgentConfiguration, models: readonly AgentModel[], accounts: readonly SubscriptionAccount[] = []): string {
  if (isSubscriptionReasoning(configuration.reasoning)) {
    const provider = configuration.reasoning
    const nativeModelId = configuration.reasoningModel || accounts.find(account => account.provider === provider)?.defaultModelId
    if (nativeModelId) return publicProviderEntityId(provider, 'model', nativeModelId)
    const candidates = models.filter(model => model.providerId === provider)
    return (candidates.find(model => model.ready) ?? candidates[0])?.id ?? ''
  }
  const ready = models.filter(model => model.ready)
  return (ready.find(model => model.providerId === configuration.provider) ?? ready[0])?.id ?? ''
}
/**
 * The model a new thread in a project starts on (issue #347): the model chosen in Settings → Agents' "New
 * threads start with" row, or, unset, the coordinator's reasoning-based default
 * (`defaultThreadModelId`), which is today's behaviour for an install made before the setting existed.
 */
export function defaultNewThreadModelId(configuration: AgentConfiguration, models: readonly AgentModel[], accounts: readonly SubscriptionAccount[] = []): string {
  // Keeps an explicit choice even while the catalog does not list it verbatim, the same as the reasoning
  // model above: a long-context variant the catalog answers from its base model's entry (`modelCatalog.ts`)
  // resolves through the caller, which is catalog-aware; this module cannot import it without a cycle.
  if (configuration.newThreadModelId) return configuration.newThreadModelId
  return defaultThreadModelId(configuration, models, accounts)
}
/**
 * Whether this thread's own lane is running a command right now. Every control that acts on one thread
 * asks this about the thread it shows, so work on one thread never dims or locks another thread's pane.
 */
export function isThreadBusy(state: { readonly busyThreadIds?: readonly string[] | undefined }, threadId: string | null | undefined): boolean {
  return threadId ? state.busyThreadIds?.includes(threadId) === true : false
}
export function isThreadProviderConnected(host: AgentHostSnapshot, thread: AgentThread): boolean {
  if (thread.clientConnected !== undefined) return thread.clientConnected
  if (!host.providers || !thread.providerId) return host.connected
  return host.providers.some(provider => provider.id === thread.providerId && provider.connection === 'connected')
}
