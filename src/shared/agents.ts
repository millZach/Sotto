import { scheduledRestartSchema, turnLimitStopSchema } from './limitRestart'
import { watcherOwnChangeSchema, watcherObservedChangesSchema } from './watcherChanges'
import { watcherAsksSchema } from './watcherAsks'
import { z } from 'zod'
import { everyProvider, providerIdSchema, type ProviderId } from './providerIds'
import { providerProfile } from './providerProfile'
import { subagentSummarySchema } from './subagents'
import { agentSkillCatalogSchema, agentSkillReferencesSchema } from './agentSkills'
import { agentFileReferencesSchema } from './agentFiles'
import { agentActivitySchema, MAX_AGENT_ACTIVITIES, type AgentActivity } from './agentActivity'
import { threadUsageSchema } from './threadUsage'
import { agentVisualSchema, VISUAL_MESSAGE_PREFIX, type AgentVisual } from './visuals'
import { compactionSchema } from './compaction'
import { clearThreadsAgeSchema, THREAD_CLEAR_MAX, threadClearKeptReasonSchema, threadClearPreviewSchema, threadClearResultSchema } from './threadClear'
import { agentBackgroundWorkSchema, agentMonitoringSchema } from './agentMonitoring'
import { gitStatusSchema } from './gitStatus'
import { DEFAULT_ULTRACODE_EFFORT, ULTRACODE_EFFORTS } from './ultracode'
import { agentBabysitEndedSchema, agentBabysittingSchema, BABYSITTING_PER_THREAD_MAX } from './babysitting'
import { gitActionProgressSchema, gitStackedActionSchema } from './gitActions'
import { bringBackAwaySchema, bringBackSchema, worktreeMadeFromSchema } from './bringChangesBack'
import type { GitRefsPage, GitRefsRequest } from './gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from './gitChangedFiles'
import { GIT_PULL_REQUEST_LINKS_MAX, gitCommitIdSchema, gitPullRequestActionSchema, gitPullRequestLinkSchema, gitPullRequestMergeMethodSchema, gitPullRequestUrlSchema, type GitPullRequestRead, type GitPullRequestRequest } from './gitPullRequests'
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
/** The words of a started thread's handover, read only when the user asks to read them (#1028). */
export const AGENT_START_HANDOVER = 'sotto:agents:start-handover'
/** One activity record whole, for a remote row whose body its host sent cut (ADR-0025, October 18 amendment). */
export const AGENT_ACTIVITY_BODY = 'sotto:agents:activity-body'
export { everyProvider, providerIdSchema, type ProviderId } from './providerIds'
import type { AgentThreadPrompts, AgentThreadPromptsRequest } from './threadPrompts'
/** How many thread providers Sotto has: the cap on every list that names each provider at most once. */
export const PROVIDER_COUNT = providerIdSchema.options.length
/** Absent on older live snapshots; ordinary threads have the project kind. */
export const agentThreadKindSchema = z.enum(['project', 'watcher', 'watcher-history'])
export type AgentThreadKind = z.infer<typeof agentThreadKindSchema>
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
export type AgentImageMimeType = typeof AGENT_IMAGE_MIME_TYPES[number]
/**
 * Whether an attachment is an image: one of the four raster types a model reads as a picture (ADR-0031). Anything else
 * is an attached file (ADR-0131), whose bytes Sotto never inspects.
 */
export function isImageAttachment(mimeType: string): mimeType is AgentImageMimeType {
  return (AGENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)
}
/** The type a file is staged as when the browser gives it none, or one that is not a well-formed MIME type. */
export const AGENT_GENERIC_FILE_MIME_TYPE = 'application/octet-stream'
/** A well-formed MIME type, `type/subtype`, lowercase, at most 127 characters, with no parameters. */
export const agentMimeTypeSchema = z.string().max(127).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u)
/** The MIME type a file is staged under: the browser's own, lowercased and without parameters, or the generic one. */
export function attachmentMimeType(browserType: string): string {
  const type = browserType.split(';')[0]!.trim().toLowerCase()
  return agentMimeTypeSchema.safeParse(type).success ? type : AGENT_GENERIC_FILE_MIME_TYPE
}
export const AGENT_MAX_ATTACHMENTS = 8
/** The most threads one Dismiss all names; a window with more failed threads sends them in turn. */
export const AGENT_DISMISS_FAILURES_MAX = 500
export const AGENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** The bytes a set's images may hold between them, which keeps a Claude request under its 32 MB cap. */
export const AGENT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** The most one attached file may hold (ADR-0131). */
export const AGENT_MAX_FILE_BYTES = 25 * 1024 * 1024
/** The most a set's images and files may hold between them (ADR-0131). */
export const AGENT_MAX_ATTACHMENTS_TOTAL_BYTES = 50 * 1024 * 1024
/** The most one attachment may hold, by what it is. */
export function attachmentLimitBytes(mimeType: string): number {
  return isImageAttachment(mimeType) ? AGENT_MAX_IMAGE_BYTES : AGENT_MAX_FILE_BYTES
}
// What a screenshot is refused with wherever it is checked: the composer before it reads a file, and staging after.
// The guide gives these limits in MB, so the sentences do too.
export const SCREENSHOT_WRONG_TYPE = 'Only PNG, JPEG, GIF, and WebP screenshots can be attached. Nothing was attached. Choose files of those types.'
export const SCREENSHOT_TOO_LARGE = 'Each screenshot must be 10 MB or smaller. Nothing was attached. Choose a smaller file.'
export const SCREENSHOTS_TOO_LARGE_IN_TOTAL = 'Screenshots must total 20 MB or less. Nothing was attached. Remove an image or choose smaller files.'
export const SCREENSHOT_NOT_ITS_TYPE = 'This screenshot’s content does not match its file type. Nothing was attached. Save it again as PNG, JPEG, GIF, or WebP, then attach it.'
// The same refusals once any file can be attached (ADR-0131). The window says them through its catalogs; these are
// main's and the host's, in English, and match the window's source text.
export const ATTACHMENTS_TOO_MANY = 'Attach up to 8 files at a time. Nothing was attached.'
export const ATTACHED_FILE_TOO_LARGE = 'Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.'
export const ATTACHED_IMAGE_TOO_LARGE = 'Each image must be 10 MB or smaller. Nothing was attached. Choose a smaller image.'
export const ATTACHED_IMAGES_TOO_LARGE_IN_TOTAL = 'Images must total 20 MB or less. Nothing was attached. Remove an image or choose smaller ones.'
export const ATTACHMENTS_TOO_LARGE_IN_TOTAL = 'Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones.'
/** An image on a model that reads none, naming the image. Files go to every model. */
export function imagesNotReadRefusal(name: string): string {
  return `This model does not read images. Choose a model with image support, or remove ${name}.`
}
/**
 * A send that carries an attached file on a thread with no working folder to copy it into (ADR-0131). Checked before
 * the provider hears anything.
 */
export const ATTACHED_FILES_NEED_A_FOLDER = 'This thread has no working folder, so files cannot be attached. Remove them, then send again. Your draft is saved.'
/**
 * The refusal when nothing is connected to act with. Only a send has a draft to keep, so only a send says so. A
 * headless host cannot know the name a desktop saved it under, so it says "this host" and the desktop puts that name
 * in (`nameHostInRefusal`); the desktop's own coordinator names this computer and its own Providers page (#459).
 */
export const NO_PROVIDER_ON_HOST = 'No provider is connected on this host.'
const NO_PROVIDER_HERE = 'No provider is connected on this computer.'
const DRAFT_KEPT = ' Your draft is saved.'
export function noProviderRefusal(where: 'host' | 'desktop', draftKept: boolean): string {
  return (where === 'host' ? `${NO_PROVIDER_ON_HOST} Connect one in Settings > Hosts & phones.` : `${NO_PROVIDER_HERE} Connect one in Settings > Providers.`) + (draftKept ? DRAFT_KEPT : '')
}
/**
 * A host's refusal as the desktop shows it: "this host" and "this machine" become the name the user saved the host
 * under, so a provider's "Sign in to Muse on this machine" never reads as this computer's when it is forge's.
 */
export function nameHostInRefusal(message: string, name: string): string {
  const host = name.trim()
  if (!host) return message
  const named = message.startsWith(NO_PROVIDER_ON_HOST) ? `No provider is connected on ${host}.${message.slice(NO_PROVIDER_ON_HOST.length)}` : message
  return named.replaceAll(' on this machine', () => ` on ${host}`)
}
/** What a host from before staged images (ADR-0031) is refused with when asked to keep one. */
export const HOST_CANNOT_STAGE_SCREENSHOTS = 'This host cannot keep screenshots. Update Sotto there, then attach them again. Nothing was attached.'
/** What a host without `file-staging` is refused with when asked to keep a file that is not an image (ADR-0131). */
export const HOST_CANNOT_STAGE_FILES = 'This host cannot keep files yet. Update Sotto there, then attach them again. Nothing was attached.'
/** What a file is refused with when the host that would keep it is not connected (ADR-0131). */
export const HOST_DISCONNECTED_BEFORE_FILES = 'This host is disconnected. Connect again before attaching files. Nothing was attached.'
/** A file part a host refuses as not the one its upload expects: out of order, from an upload it no longer holds, or too large. */
export const FILE_UPLOAD_INCOMPLETE = 'This file did not reach the host whole. Nothing was attached. Attach it again.'
/** An upload whose parts, put together, are not the file its first part named. */
export const FILE_UPLOAD_MISMATCH = 'This file changed on its way to the host. Nothing was attached. Attach it again.'
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
/**
 * Point at something's feedback, carried by its picture's handle (ADR-0154): the element's `label` and the user's
 * `comment`, which the composer's chip shows, and `context` (the page, the element and where it is outlined), which
 * is written into the message for the provider only when it is sent. Removing the picture removes all of it.
 */
export const agentBrowserFeedbackSchema = z.object({ label: z.string().trim().min(1).max(600), comment: z.string().max(8000), context: z.string().max(4000) }).strict()
export type AgentBrowserFeedback = z.infer<typeof agentBrowserFeedbackSchema>
/** The SHA-256 of a staged image's bytes, as lowercase hex: the content a handle names. */
export const attachmentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
/**
 * A staged image (ADR-0031): what drafts, follow-ups, commands, state and broadcasts carry in place of its bytes.
 * `id` is this attachment's own, `digest` the content's; the same image attached twice is two handles on one content.
 */
export const agentAttachmentHandleSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/iu), name: z.string().trim().min(1).max(255),
  mimeType: agentMimeTypeSchema, sizeBytes: z.number().int().min(1).max(AGENT_MAX_FILE_BYTES), digest: attachmentDigestSchema,
  /** The sizes the composer attached and staged it at, when it knew them (issue #321). */
  dimensions: agentAttachmentDimensionsSchema.optional(),
  /** Set when the image is Point at something's picture (ADR-0154): what travels with it until the message is sent. */
  browserFeedback: agentBrowserFeedbackSchema.optional(),
}).strict().refine(handle => handle.sizeBytes <= attachmentLimitBytes(handle.mimeType), 'An image must be no larger than 10 MiB.')
export type AgentAttachmentHandle = z.infer<typeof agentAttachmentHandleSchema>
/** The bytes a set of staged attachments holds between them: what the 50 MiB total is measured on. */
export function attachmentHandlesBytes(items: readonly Pick<AgentAttachmentHandle, 'sizeBytes'>[]): number {
  return items.reduce((sum, item) => sum + item.sizeBytes, 0)
}
/** The bytes a set's images hold between them: what the 20 MiB image total is measured on. */
export function attachmentImagesBytes(items: readonly Pick<AgentAttachmentHandle, 'sizeBytes' | 'mimeType'>[]): number {
  return attachmentHandlesBytes(items.filter(item => isImageAttachment(item.mimeType)))
}
export const agentAttachmentHandlesSchema = z.array(agentAttachmentHandleSchema).max(AGENT_MAX_ATTACHMENTS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Attachment IDs must be unique.')
  .refine(items => attachmentImagesBytes(items) <= AGENT_MAX_ATTACHMENT_BYTES, 'Images must total no more than 20 MiB.')
  .refine(items => attachmentHandlesBytes(items) <= AGENT_MAX_ATTACHMENTS_TOTAL_BYTES, 'Attachments must total no more than 50 MiB.')
const imageBytes = (limit: number) => z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= limit,
  'Choose a PNG, JPEG, GIF or WebP image no larger than 10 MiB.')
const attachmentBytes = z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= AGENT_MAX_FILE_BYTES,
  'Choose a file no larger than 25 MiB.')
/**
 * The window hands an attachment's bytes to main once; the handle comes back. `threadId` picks the host that runs it.
 * An image holds at most 10 MiB and any other file at most 25 MiB; whether this build keeps files at all is main's to say.
 */
export const agentAttachmentStageRequestSchema = z.object({
  threadId: id.nullable(), name: z.string().trim().min(1).max(255), mimeType: agentMimeTypeSchema, bytes: attachmentBytes,
  dimensions: agentAttachmentDimensionsSchema.optional(),
}).strict().refine(request => request.bytes.byteLength <= attachmentLimitBytes(request.mimeType), 'Choose a PNG, JPEG, GIF or WebP image no larger than 10 MiB.')
export type AgentAttachmentStageRequest = z.infer<typeof agentAttachmentStageRequestSchema>
/** What a host is handed to stage: the image without the thread the window routed it by. */
export type AgentAttachmentUpload = Omit<AgentAttachmentStageRequest, 'threadId'>
/** A staged image's bytes, for a composer restoring a chip it holds no copy of. A file draws no chip, so none is read. */
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
  /** Point at something's picture (ADR-0154), whose feedback went to the provider in a note Sotto reads back off. */
  pointed: z.literal(true).optional(),
})
export type AgentAttachmentReference = z.infer<typeof agentAttachmentReferenceSchema>
/**
 * The references a message records for its attachments: each one's ID, name, type and size, whether it was Point at
 * something's picture, and nothing more.
 */
export function attachmentReferences(attachments: readonly (Pick<AgentAttachmentReference, 'id' | 'name' | 'mimeType' | 'sizeBytes'> & { readonly browserFeedback?: unknown })[]): AgentAttachmentReference[] {
  return attachments.map(({ id, name, mimeType, sizeBytes, browserFeedback }) => ({ id, name, mimeType, sizeBytes, ...(browserFeedback ? { pointed: true as const } : {}) }))
}
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
export const agentSpeedSchema = z.enum(['fast', 'ultrafast'])
export type AgentSpeed = z.infer<typeof agentSpeedSchema>
export const agentModelSpeedSchema = z.object({ id: agentSpeedSchema, name: z.string().min(1).max(100), description: z.string().max(300).optional() })
export type AgentModelSpeed = z.infer<typeof agentModelSpeedSchema>
export const agentThreadOptionsSchema = z.object({ modelId: providerEntityId.optional(), reasoningEffort: z.string().min(1).max(64).optional(),
  runtimeMode: agentRuntimeModeSchema.optional(), providerMode: providerEntityId.optional(),
  /** Compatibility alias for speed fast; an explicit speed takes precedence (ADR-0143). */
  fastMode: z.boolean().optional(),
  /** Null selects standard speed; fastMode is the compatibility alias for fast (ADR-0143). */
  speed: agentSpeedSchema.nullable().optional() })
export type AgentThreadOptions = z.infer<typeof agentThreadOptionsSchema>
/**
 * A model's fast mode (ADR-0143): faster output at a higher price. Present only on a model whose provider offers it,
 * Claude Code from its catalog's `supportsFastMode` and Codex from a `priority` service tier. `description` is the
 * provider's own line about what it costs, where it gives one (Codex's tier description).
 */
export const agentModelFastModeSchema = z.object({ description: z.string().max(300).optional() })
export type AgentModelFastMode = z.infer<typeof agentModelFastModeSchema>
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
  /** Compatibility metadata for Fast, retained for older clients (ADR-0143). */
  fastMode: agentModelFastModeSchema.optional(),
  /** The offered speeds, in the provider's own names and descriptions; Standard is always available. */
  speeds: z.array(agentModelSpeedSchema).max(2).optional(),
  /**
   * Where the model runs, for a provider that offers models from several companies under one sign-in: OpenCode's
   * **model source**, such as OpenCode Zen or Anthropic (ADR-0087). The picker may group by it; `provider` stays the
   * thread provider's own label, so a model from Anthropic on OpenCode never reads as Claude Code.
   */
  source: id.optional(),
})
/** The model source OpenCode's free models come from (ADR-0087); the model menu says so on its row. */
export const OPENCODE_ZEN_SOURCE = 'OpenCode Zen'
export const agentProjectSchema = z.object({ hostId: z.uuid().optional(), id: providerEntityId, providerId: providerIdSchema.optional(), title: id, path: z.string().max(4_096), workspaceSettledAt: z.string().datetime().nullable().optional() })
/** How many pages one question carries at most (ADR-0085). */
export const QUESTION_PAGES_MAX = 8
/**
 * A page Sotto found for a question in its words or the agent's message before it (ADR-0085): an HTML file in the thread's
 * folder, or a page the agent serves on this machine's loopback. The host that runs the thread serves it under the token,
 * at `/page/<token>/<start>`; `name` is what its row shows, the file's name or the address's host and port.
 */
export const questionPageSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32}$/u), kind: z.enum(['file', 'server']), name: z.string().min(1).max(512), start: z.string().max(4_096),
})
export type QuestionPage = z.infer<typeof questionPageSchema>
/**
 * A thread's prototype waiting for review (ADR-0108). `source` is `reply:<message ID>` for the newest reply that named the
 * pages, or `request:<request ID>` for a waiting question; `pages` are the ones that opened when Sotto looked.
 */
export const prototypeReadySchema = z.object({
  source: z.string().min(1).max(1_024), pages: z.array(questionPageSchema).min(1).max(QUESTION_PAGES_MAX),
}).strict()
export type PrototypeReady = z.infer<typeof prototypeReadySchema>
export const agentRequestSchema = z.object({
  id, kind: z.enum(['question', 'permission']), text,
  /** The pages Sotto found for a question, which every client offers to open (ADR-0085). The host adds them; no provider does. */
  pages: z.array(questionPageSchema).max(QUESTION_PAGES_MAX).optional(),
  /** A question about a prototype that still names no page that opens after Sotto sent its thread back for one (ADR-0108).
   * The host adds it; no provider does. */
  linkMissing: z.literal(true).optional(),
  options: z.array(z.object({ id, label: text })).default([]),
  questions: z.array(z.object({ id, question: text, header: text.optional(), options: z.array(z.object({ id, label: text, description: text.optional(), preview: text.optional() })), multiSelect: z.boolean(), allowFreeText: z.boolean(), required: z.boolean().optional(), unavailableReason: text.optional() })).max(100).optional(),
  permissionChoices: z.array(z.object({ id, label: text, kind: z.enum(['allow-once', 'allow-session', 'allow-always', 'deny', 'cancel']), description: text.optional() })).optional(),
  context: z.object({ toolName: text.optional(), toolCallId: id.optional(), command: text.optional(), cwd: text.optional(), details: text.optional(),
    /** A plan the agent asks the user to accept, in its parts (Cursor's `cursor/create_plan`, ADR-0128); `steps` is Markdown. */
    plan: z.object({ name: text.optional(), overview: text.optional(), steps: text.optional() }).strict().optional() }).optional(),
  /** A question the user may skip: its provider takes a decline and the turn goes on (ADR-0135, October 27, 2026). The
   * adapter adds it; a request without it, from any host that predates it, offers no Skip. */
  skippable: z.literal(true).optional(),
  delivery: z.literal('uncertain').optional(),
  answerRetryReady: z.literal(true).optional(),
  /** When the host's coordinator first showed this request (ADR-0135), so a client can say how long it has waited.
   * The host adds it; no provider does. Absent from hosts that predate it, which say no wait at all. */
  since: z.string().datetime().optional(),
})
export const agentQuestionAnswersSchema = z.record(id, z.object({ optionIds: z.array(id).max(100), text: text.optional() }).strict())
export type AgentQuestionAnswers = z.infer<typeof agentQuestionAnswersSchema>
const handoverCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/**
 * What a **handover** carried and left out, as counts only, never any of the words (CONTEXT.md): the messages it carried
 * of the thread's total, those too long to carry, those that did not fit, the attachments, visuals and tool-call records it
 * never carries, whether Keep local history was on, and whether the latest request had an answer.
 */
export const handoverCountsSchema = z.object({ total: handoverCount, carried: handoverCount, tooLong: handoverCount, notCarried: handoverCount,
  images: handoverCount, files: handoverCount, visuals: handoverCount, toolRecords: handoverCount, historyKept: z.boolean(), answered: z.boolean() }).strict()
export type HandoverCounts = z.infer<typeof handoverCountsSchema>
/** The handover a user message carried ahead of the user's own words: its words as sent, and the provider of the thread it came from. */
export const agentMessageHandoverSchema = z.object({ text: z.string(), provider: providerIdSchema, counts: handoverCountsSchema }).strict()
export type AgentMessageHandover = z.infer<typeof agentMessageHandoverSchema>
/**
 * Text-free proof that a continued thread's first message began with a handover of the thread it continues (ADR-0089):
 * how many characters were the handover and their digest, and what it carried, never any of the words. Every
 * user-facing copy shows the handover apart from the user's words by this record alone.
 */
export const threadHandoverProofSchema = z.object({ prefixLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  prefixDigest: z.string().regex(/^[0-9a-f]{64}$/u), counts: handoverCountsSchema,
  /** The first message's Sotto message ID, once its send said it: the only message a copy without the words may split. */
  messageId: id.optional() }).strict()
export type ThreadHandoverProof = z.infer<typeof threadHandoverProofSchema>
/**
 * The thread a **continued thread** continues (ADR-0089): its Sotto thread ID, its provider, when, and the proof of the
 * handover its first message carried, once that message was sent.
 */
export const threadContinuedFromSchema = z.object({ threadId: id, provider: providerIdSchema, at: z.string().datetime(),
  handover: threadHandoverProofSchema.optional(),
  /** A thread moved here from another machine (#1178): that machine's host ID, as the desktop that moved it names it. Read leniently. */
  host: z.string().min(1).max(512).optional().catch(undefined) }).strict()
export type ThreadContinuedFrom = z.infer<typeof threadContinuedFromSchema>
/**
 * One thread that continues this one on another provider (ADR-0089), or on another machine (#1178): its Sotto thread ID,
 * its provider and when, and for a move the host ID of the machine it went to. `host` is read leniently.
 */
export const threadContinuedInSchema = z.object({ threadId: id, provider: providerIdSchema, at: z.string().datetime(),
  host: z.string().min(1).max(512).optional().catch(undefined) }).strict()
export type ThreadContinuedIn = z.infer<typeof threadContinuedInSchema>
/** The most continuations a thread's record names, the newest kept, so a record cannot grow without end. */
export const THREAD_CONTINUED_IN_MAX = 100
/**
 * Where a thread began when it began from another thread rather than empty (#1028): one of that thread's agents continued
 * as a thread of its own (`agent`), or that thread forked at one of its replies (`turn`). The source is named by its Sotto
 * thread ID alone (ADR-0002). A `fork` is the provider's own copy of the conversation, bound to this thread when it was
 * made; a `handover` goes ahead of this thread's first message, and `handover.sent` names that message once it has gone.
 */
export const agentThreadStartSchema = z.object({
  threadId: id,
  from: z.enum(['agent', 'turn']),
  route: z.enum(['fork', 'handover']),
  at: z.string().datetime(),
  /** The agent's title as its roster showed it, for an agent. */
  agentTitle: z.string().max(240).optional(),
  /** The agent's observational identity and the assignment a handover carries, for an agent. Never a provider address. */
  agentId: id.optional(), assignmentId: id.optional(),
  /** The reply a fork carries the conversation up to, for a turn. */
  messageId: id.optional(),
  /** What a handover carries, as counts only: `thin` when it holds an agent's task and result alone. */
  handover: z.object({ thin: z.boolean(), counts: handoverCountsSchema,
    sent: z.object({ messageId: id, prefixLength: z.number().int().positive(), prefixDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional() }).strict().optional(),
}).strict()
export type AgentThreadStart = z.infer<typeof agentThreadStartSchema>
export const agentMessageSchema = z.object({
  // A projected message combines bounded events and can exceed any one event's limit.
  id, role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.string(),
  commandId: z.string().optional(),
  /** The Sotto user message that began this reply's turn, proved by the adapter while it was live. */
  turnMessageId: z.string().min(1).max(512).optional().catch(undefined),
  attachments: z.array(agentAttachmentReferenceSchema).optional(),
  watcherOwnChange: watcherOwnChangeSchema.optional().catch(undefined),
  watcherObservedChanges: watcherObservedChangesSchema.optional().catch(undefined),
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
  /**
   * Set beside `wakeUp` on a wake-up that carried only news of the thread's delegations (ADR-0081, October 19, 2026), from
   * the host's own record of the send. The agent read it; no window or phone shows it. An older reader drops the field and
   * shows the wake-up as Sotto's.
   */
  hiddenWakeUp: z.literal(true).optional().catch(undefined),
  /**
   * Set on a Watcher wake-up whose news said watched threads waited on the user (ADR-0073, answering in Watcher's
   * conversation): which thread's which request, text-free, from the host's own record of the send, put on as `wakeUp`
   * is so it survives the history being read again and a restart. Watcher's pane shows each request's card from it. An
   * older reader drops the field and shows no card.
   */
  watcherAsks: watcherAsksSchema.optional().catch(undefined),
  /**
   * Set on Watcher's first message after a provider change when the user chose to continue with a handover of the last
   * Watcher (ADR-0073): the message's text is then the user's words, and this is the handover that went ahead of them in
   * the same message, told apart by its recorded provenance rather than its words. An older reader drops the field and
   * shows the user's words alone.
   */
  handover: agentMessageHandoverSchema.optional().catch(undefined),
})
/**
 * What the sidebar reads about a thread's history without holding that history. The shell stream
 * carries it in place of `messages`; a thread whose messages are present derives the same facts.
 */
export const AGENT_THREAD_EXCERPT_MAX = 2_000
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
/**
 * What Delete thread… shows before it asks (ADR-0140): why the thread is kept, or null when it may go, and, for a thread
 * with a worktree folder of its own, what removing that folder would take, so the window can List and tick ignored items
 * and nested work the way Remove worktree does (ADR-0041). Null when the thread has no folder of its own.
 */
export const threadDeletePreviewSchema = z.object({ threadId: z.string().min(1).max(512), kept: threadClearKeptReasonSchema.nullable(), worktree: worktreeReclaimPreviewSchema.nullable() }).strict()
export type ThreadDeletePreview = z.infer<typeof threadDeletePreviewSchema>
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
  /** A worker started from a thread's branch (#1033): the move's incoming ref this worktree was made from, removed with
   * the worktree (ADR-0082 decision 3). */
  incomingRef: z.string().max(512).optional(),
  /** A worker started from a thread's branch (#1033): that thread, so this worktree's commits can be brought back to its
   * branch (#1030). Absent for any other worktree, and from older hosts. */
  madeFrom: worktreeMadeFromSchema.optional().catch(undefined),
  /** A check's thread (#1312, third part): its working copy is the machine's one check worktree for the repository, moved to
   * the check's commit, unless that could not be taken and it got a worktree of its own. `install` is `running` while
   * `npm ci` runs there first, and `failed` when it did not finish; the check's first message waits for it. */
  check: z.object({ install: z.enum(['running', 'failed']).optional() }).strict().optional().catch(undefined),
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
  /** Optional phone projection mark; absent unless the client accepts watcher-phone. */
  watchedByWatcher: z.boolean().optional(),
  hostLabel: z.string().max(80).optional(), remoteHost: z.boolean().optional(), clientConnected: z.boolean().optional(),
  /** Set by the desktop while this thread's host restarts for an update and the desktop reconnects to it (ADR-0040). */
  clientReconnecting: z.boolean().optional(),
  hostId: z.uuid().optional(),
  id, providerId: providerIdSchema.optional(), projectId: providerEntityId, title: id, modelId: z.string(),
  kind: agentThreadKindSchema.optional(),
  /**
   * The thread that delegated work to this one (ADR-0081), by its Sotto thread ID and nothing else. Sotto's record, kept on
   * the thread's own record so it survives a restart; absent on every thread no other thread started, and from older hosts.
   */
  delegatedBy: id.optional(),
  /** Live swarm membership, supplied by its owner only while worker-swarms is on. */
  swarm: z.object({ id, leadThreadId: id, index: z.number().int().nonnegative().optional(), count: z.number().int().positive(),
    synthesisDone: z.boolean().optional(), stopped: z.boolean().optional(), done: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), queued: z.number().int().nonnegative(),
    state: z.enum(['planned', 'queued', 'working', 'background', 'answered', 'failed', 'stopped', 'paused', 'unknown', 'refused']).optional() }).strict().optional(),
  /**
   * The thread this one continues on another provider (ADR-0089), and the threads that continue this one, newest last.
   * Sotto's record, kept on each thread's own record so the links survive a restart; absent on every other thread, and
   * from older hosts. A value this build cannot read drops the link rather than the thread.
   */
  continuedFrom: threadContinuedFromSchema.optional().catch(undefined),
  continuedIn: z.array(threadContinuedInSchema).max(THREAD_CONTINUED_IN_MAX).optional().catch(undefined),
  /**
   * The thread this one began from, when it was an agent continued as its own thread or a fork at a reply (#1028). Sotto's
   * record, kept on the thread's own record; absent on every other thread, and from older hosts.
   */
  startedFrom: agentThreadStartSchema.optional().catch(undefined),
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
  /**
   * Compatibility alias for speed fast (ADR-0143). A named speed takes precedence; absent on older hosts and at Standard.
   */
  fastMode: z.boolean().optional(),
  speed: agentSpeedSchema.nullable().optional(),
  status: z.enum(['idle', 'running', 'error']),
  workingDirectory: z.string().optional(), worktree: agentWorktreeSchema.optional(),
  /** The last stacked Git action run on this thread's folder, as it runs and once it is over (ADR-0027). */
  gitAction: gitActionProgressSchema.optional(),
  /**
   * What the last Bring changes to <branch> press did here (#1030): the merge-commit question it holds, or its outcome.
   * Sotto's record, never saved. A value this build cannot read drops the field rather than the thread; absent from older hosts.
   */
  bringBack: bringBackSchema.optional().catch(undefined),
  /**
   * What the last bring-back of a thread on another machine did to this thread's branch (#1030): the question it holds or
   * its outcome, naming that thread in `from`. Kept here because this thread's host ran Git. Never saved, as `bringBack`.
   */
  broughtBack: bringBackSchema.optional().catch(undefined),
  /** The pull requests linked to this thread: the one its Git action created, ones linked by hand, one checked out
   * from the branch picker. Newest last; the Pull request surface lists them (ADR-0027). */
  pullRequests: z.array(gitPullRequestLinkSchema).max(GIT_PULL_REQUEST_LINKS_MAX).optional(),
  /** The pull requests this thread babysits: which, who started each and since when (ADR-0061 decision 10). The
   * host keeps what the thread was last told; clients get only this. Absent when it babysits none, and from older hosts. */
  babysitting: z.array(agentBabysittingSchema).max(BABYSITTING_PER_THREAD_MAX).optional(),
  /** Why babysitting each of its pull requests last ended, where it ended on its own or with the switch, newest last; one per
   * pull request, gone when that pull request is babysat again. Read, never sent by a client: a reason this build does
   * not know drops the field rather than the thread. Absent from older hosts. */
  babysitEnded: z.array(agentBabysitEndedSchema).max(BABYSITTING_PER_THREAD_MAX).optional().catch(undefined),
  /** The newest wake-ups babysitting sent this thread, by message ID, oldest first (ADR-0061 decision 8): the host's own
   * record of what it sent, never read from a message's text, so a row can say Sotto sent its last message. */
  wakeUpMessageIds: z.array(id).max(WAKE_UP_MESSAGE_IDS_MAX).optional(),
  /** Which of those wake-ups carried only delegation news, which no window or phone shows (ADR-0081, October 19, 2026),
   * from the same record. A row never quotes one. Absent when there are none, and from older hosts. */
  hiddenWakeUpMessageIds: z.array(id).max(WAKE_UP_MESSAGE_IDS_MAX).optional(),
  /** A restart Sotto has scheduled for this thread, which a usage limit stopped while it worked (ADR-0144). The host's
   * coordinator sets and clears it; absent otherwise, on stable, and from older hosts. Read, never sent by a client. */
  scheduledRestart: scheduledRestartSchema.optional().catch(undefined),
  /** Sotto organization only: does not close native work or suppress attention. */
  workspaceSettledAt: z.string().datetime().nullable().optional(),
  /** False only before Sotto dispatches native creation. Unknown is conservatively locked. */
  nativeSessionStarted: z.boolean().optional(),
  /** The thread's provider session is open on its host now: its client is running and holds the session, so the next
   * send does not start it. Absent while it is stopped or not started yet, and from hosts that predate it. Never saved. */
  providerSessionOpen: z.literal(true).optional(),
  /** The thread's provider client builds its session without Sotto's tool servers: a Muse client that did not grant
   * session tool servers (ADR-0079), or an OpenCode thread's server that refused them or did not connect them (ADR-0087).
   * Absent otherwise, and from hosts that predate it. Never saved. */
  sottoToolsWithheld: z.literal(true).optional(),
  /** A Devin thread whose host gives Devin Sotto's tool servers, from Devin CLI 3000.11.92 (#1040). Absent from hosts that
   * predate it, whose Devin threads have none, so a Devin thread without it is read as having none. Never saved. */
  sottoToolsGiven: z.literal(true).optional(),
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
  /** A prototype the thread made waits for the user to review (ADR-0108): the pages its newest reply or a waiting question
   * names that open, found and served as a question's are (ADR-0085). `source` names that reply or question. The host's
   * coordinator sets it and clears it once the user opens one of the pages or replies; absent otherwise, and from older hosts. */
  prototypeReady: prototypeReadySchema.optional().catch(undefined),
  /** The thread's last turn failed and a client has shown it since, or the user dismissed it (ADR-0092): its row reads Done.
   * The host's coordinator sets and clears it; absent otherwise, and from hosts that predate it. */
  failureSeen: z.literal(true).optional(),
  /** The host's own name for the failure a thread in error stands in (ADR-0092), so Dismiss all can name the failure a row
   * showed and a later one is not marked seen in its place. Absent while the thread stands in none, and from older hosts. */
  failureId: z.string().max(64).optional(),
  /** Why that failure happened, as the failed turn's own record says, cut to its first 600 characters; absent when it says
   * nothing, and from older hosts. The pane reads it to tell the thread's own failure from the provider's other errors. */
  failureReason: z.string().max(600).optional(),
  /** When the coordinator named the failure `failureId` names (ADR-0135), so a client can say how long it has stood.
   * Absent while the thread stands in none, for a failure named before the moment was kept, and from older hosts. */
  failureSince: z.string().datetime().optional(),
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
  lastTurn: z.object({ id: z.string(), status: z.enum(['running', 'completed', 'interrupted', 'failed']),
    /** Exact Sotto user anchor when an adapter's native turn ID differs from its activity ID, as Claude's does. */
    messageId: z.string().optional(),
    /** A failed turn its provider stopped at a usage limit, with the reset when it said (ADR-0144). Its adapter sets it, only
     * while that Owl feature is on, and the host's coordinator reads it; absent otherwise and from older hosts. */
    limitStop: turnLimitStopSchema.optional().catch(undefined) }).optional(),
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
  /** Muse only, while connected: whether its running `muse serve` hosts were started without the shell sandbox. */
  sandboxDisabled: z.boolean().optional(),
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
 * new version, `install-step` when mise installed Grok Build but its package's own install step did not finish,
 * `not-listed` when mise's version list did not have the published version even after Sotto cleared mise's cache of it
 * and either held another build of it, so nothing was installed, or installing it anyway failed, and `installer` for anything else the installer refused.
 */
export const clientUpdateFailureSchema = z.enum(['download', 'install-step', 'installer', 'not-listed'])
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
  clientUpdates: z.array(providerClientUpdateSchema).max(PROVIDER_COUNT).optional(), clientUpdateRun: clientUpdateRunSchema.optional(),
  /** The host lists `pull-request-babysit`: the Pull request surface offers Babysit pull request on its threads (ADR-0061 decision 11). */
  pullRequestBabysit: z.literal(true).optional(),
  /** The host deletes its settled threads when asked: it lists `thread-delete` (ADR-0140 decision 7). Absent, Delete thread… is off. */
  threadDelete: z.literal(true).optional(),
  /** Where a new project goes on this host, in its own format, for Settings → Threads' row per computer (ADR-0074). */
  projectsDirectory: z.string().max(4_096).optional(),
  /** Whether this host lets this computer answer, so a permission default that grants applies there (ADR-0074). */
  mayAnswer: z.boolean().optional(),
  /**
   * This computer's own entry only, for Settings > Providers: the providers it has turned on, whether it checks for client
   * updates, whether its Muse starts without the shell sandbox, and the model its agent setting starts new threads on, its
   * open row's "Agent setting" in Settings > Providers, and the effort its Claude Code runs Ultracode at (ADR-0148).
   */
  enabledProviders: z.array(providerIdSchema).max(PROVIDER_COUNT).optional(), checkClientUpdates: z.boolean().optional(), museDisableSandbox: z.boolean().optional(),
  agentModelId: z.string().max(512).optional(), claudeUltracodeEffort: z.enum(ULTRACODE_EFFORTS).optional() })
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
  /** Muse only, while connected: whether its running `muse serve` hosts were started without the shell sandbox. */
  sandboxDisabled: z.boolean().optional(),
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

/** A provider's fresh read cannot erase Sotto's metadata or reassign a reply whose turn was already proved. */
export function withKeptMessageMetadata(message: AgentMessage, kept: AgentMessage | undefined): AgentMessage {
  const ownChange = message.watcherOwnChange === undefined ? kept?.watcherOwnChange : undefined
  const observed = message.watcherObservedChanges === undefined ? kept?.watcherObservedChanges : undefined
  const owner = message.role === 'assistant' && kept?.role === 'assistant' ? kept.turnMessageId : undefined
  return ownChange || observed || owner !== undefined && owner !== message.turnMessageId
    ? { ...message, ...(ownChange ? { watcherOwnChange: ownChange } : {}), ...(observed ? { watcherObservedChanges: observed } : {}),
      ...(owner === undefined ? {} : { turnMessageId: owner }) } : message
}
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
    /** As on `agentModelSchema.fastMode`: present only when the model offers fast mode. */
    fastMode: agentModelFastModeSchema.optional(),
    speeds: z.array(agentModelSpeedSchema).max(2).optional(),
  })),
  defaultModelId: z.string().optional(), allowCustomModel: z.boolean().optional(),
})
export type SubscriptionAccount = z.infer<typeof subscriptionAccountSchema>
export function isSubscriptionReasoning(provider: string): provider is SubscriptionProvider {
  return provider === 'codex' || provider === 'claude' || provider === 'grok'
}

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build', devin: 'Devin', muse: 'Muse', opencode: 'OpenCode', cursor: 'Cursor', deepseek: 'DeepSeek Harness',
}
const THREAD_PROVIDERS_CONNECTED = 'Thread providers connected'
/** The bounded success vocabulary old hosts use, including a default provider discovered during connect. */
export const PROVIDER_CONNECTION_NOTICES: readonly string[] = [
  ...Object.values(PROVIDER_LABELS).map(label => `${label} connected`), THREAD_PROVIDERS_CONNECTED,
]
/** Sotto's connect success text; a remote desktop may suppress only this feedback, never an error. */
export function providerConnectionNotice(state: Pick<AgentState, 'host' | 'configuration'>, provider?: ProviderId): string {
  return provider ? `${PROVIDER_LABELS[provider]} connected` : state.host.providers ? THREAD_PROVIDERS_CONNECTED : `${PROVIDER_LABELS[state.configuration.provider]} connected`
}
/** The provider a model's `provider` label names, by the provider's id or its name in any case; undefined for any other label. */
export function providerIdOfLabel(label: string): ProviderId | undefined {
  const name = label.trim().toLowerCase()
  return providerIdSchema.options.find(id => id === name || PROVIDER_LABELS[id].toLowerCase() === name)
}
export const agentConfigurationSchema = z.object({
  provider: providerIdSchema.default('codex'),
  enabledProviders: z.array(providerIdSchema).max(PROVIDER_COUNT).refine(ids => new Set(ids).size === ids.length, 'Choose each provider once.').optional(),
  /**
   * The providers the user turned off: each one disconnected by name, or left out of a changed enabled set, and not
   * connected again since. A headless host connects every other provider that is installed and signed in when it
   * starts, so this is what keeps a turned-off one off across restarts; `enabledProviders` alone cannot tell
   * "never asked" from "turned off" (ADR-0036). Absent until the user turns one off.
   */
  disconnectedProviders: z.array(providerIdSchema).max(PROVIDER_COUNT).refine(ids => new Set(ids).size === ids.length, 'Choose each provider once.').optional(),
  enabled: z.boolean(),
  projectsDirectory: z.string().max(4_096),
  defaultModelId: z.string().max(6_144),
  reasoning: z.enum(['none', 'codex', 'claude', 'grok', 'openrouter', 'openai']),
  reasoningModel: z.string().max(512),
  reasoningEffort: z.string().max(64).default(''),
  checkClientUpdates: z.boolean().default(true),
  /**
   * Whether Muse's `muse serve` hosts on this machine start with `--disable-sandbox` (ADR-0079 amendment).
   * Off unless turned on in Settings → Providers → Muse, for a machine where Muse's sandbox cannot be
   * set up. Captured when Muse connects; a change applies on the next connect, never mid-host.
   */
  museDisableSandbox: z.boolean().default(false),
  /**
   * The effort a Claude thread on Ultracode runs at on this machine (ADR-0148), Extra high unless changed in Settings →
   * Providers → Claude Code. Read at every launch and every send, so a change reaches a thread with its next message.
   */
  claudeUltracodeEffort: z.enum(ULTRACODE_EFFORTS).default(DEFAULT_ULTRACODE_EFFORT),
  /**
   * What a new thread in a project starts on, apart from the coordinator's reasoning model and effort
   * (issue #347): the model a create-thread that leaves one unset takes, empty until chosen so an existing
   * install keeps following the reasoning-based default (`defaultThreadModelId`). `newThreadReasoningEffort`
   * is empty the same way, meaning the chosen model's own default; `newThreadRuntimeMode` is absent the same
   * way, meaning the provider's own starting mode. Settings → Threads' "New threads start with" row is the
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
  reasoning: 'none', reasoningModel: '', reasoningEffort: '', checkClientUpdates: true, museDisableSandbox: false, claudeUltracodeEffort: DEFAULT_ULTRACODE_EFFORT,
  newThreadModelId: '', newThreadReasoningEffort: '',
})

export const MAX_DELIVERED_DRAFTS = 128
export const agentThreadDraftSchema = z.object({
  threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentHandlesSchema, skills: agentSkillReferencesSchema.optional(),
  files: agentFileReferencesSchema.optional(),
  requestId: id.nullable(), updatedAt: z.string().datetime(),
})
export type AgentThreadDraft = z.infer<typeof agentThreadDraftSchema>
/**
 * The follow-up queue's items: the user's own follow-ups, independent of dispatched outbox intent, and
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
  // A queue Watcher's stop holds for the user's review (ADR-0073) is paused by Watcher, and says so.
  pausedBy: z.literal('watcher').optional().catch(undefined),
})
export type AgentFollowup = z.infer<typeof agentFollowupSchema>
export const agentDeliverySchema = z.object({
  threadId: id, draftId: z.uuid(),
  status: z.enum(['queued', 'submitting', 'accepted', 'failed', 'uncertain']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  commandId: id.optional(), messageId: id.optional(),
  /** The exact stable Send packet this delivery belongs to; evidence, never authority. */
  packetDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  /** The user released the composer; the original delivery is still unconfirmed. */
  setAside: z.boolean().optional(),
  /** A later explicit prompt was confirmed; normal automatic updates may resume without replaying this one. */
  updatesResumed: z.boolean().optional(),
  localFeedbackMs: z.number().nonnegative().optional(), providerLatencyMs: z.number().nonnegative().optional(),
})
export type AgentDelivery = z.infer<typeof agentDeliverySchema>
export const agentDeliveryReceiptsSchema = z.array(z.object({ threadId: id, draftId: z.uuid() })).max(MAX_DELIVERED_DRAFTS)
export const providerUpgradeSchema = z.object({ recoveryPath: z.string(), migratedAt: z.number() })
export const agentStateSchema = z.object({
  legacyManagement: z.boolean().optional(),
  worktreeReclaimPreview: worktreeReclaimPreviewSchema.optional(),
  /** The answers of `preview-delete-thread`, `preview-clear-threads` and `clear-threads` (ADR-0140), on that reply alone. */
  threadDeletePreview: threadDeletePreviewSchema.optional(),
  threadClearPreview: threadClearPreviewSchema.optional(),
  threadClearResult: threadClearResultSchema.optional(),
  clientScoped: z.boolean().optional(),
  connections: z.array(z.object({ hostId: z.uuid(), name: z.string(), kind: z.enum(['local', 'remote']), connected: z.boolean() })).optional(),
  hostId: z.uuid().optional(),
  configuration: agentConfigurationSchema,
  skillCatalogs: z.array(agentSkillCatalogSchema).optional(),
  providerUpgrade: providerUpgradeSchema.nullable().optional(),
  clientUpdates: z.array(providerClientUpdateSchema).max(PROVIDER_COUNT).optional(),
  clientUpdateRun: clientUpdateRunSchema.optional(),
  /** The card stays down until the next check finds something else. */
  clientUpdatesDismissedAt: z.string().optional(),
  /**
   * The thread clients the last Connect providers press found installed on this machine: presence only, no sign-in.
   * Absent until a press looks, and on a machine that cannot look. Setup reads it to tell Not installed from off.
   */
  installedProviders: z.array(providerIdSchema).max(PROVIDER_COUNT).optional(),
  connection: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  host: agentHostSnapshotSchema,
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
  /**
   * The one global lane is occupied: a command with no thread, or one that moves
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
/**
 * `host.threads` as it crosses the `AGENT_STATE` broadcast (issue #1330, ADR-0028's October 22 amendment): the thread
 * records that changed since the last broadcast the window was sent, not every one. `base` names the broadcast these
 * changes are measured from; a window that holds another one cannot apply them and reads `AGENT_GET` instead, which
 * also tells main to send the next broadcast complete. A complete one has a null `base` and every record in `changed`,
 * in order. Like the catalogs, nothing parses this shape: the page puts the whole ordered array back
 * (`src/renderer/src/agents/agentStateThreads.ts`) before any reader sees the state.
 */
export interface AgentThreadsBroadcast {
  /** Names this broadcast's threads, for the next one to be measured from. Main's counter only advances. */
  revision: number
  /** The broadcast these changes are measured from, or null when `changed` is every thread. */
  base: number | null
  /** Each thread record new or changed since `base`, whole; every record, in order, when `base` is null. */
  changed: AgentThread[]
  /** The Sotto thread IDs of threads `base` had and this broadcast does not. Absent when none went. */
  removed?: string[]
  /** Every thread's Sotto ID in order, when the order or the threads differ from `base`'s. Absent when they do not. */
  order?: string[]
}
export type AgentHostSnapshotBroadcast = Omit<AgentHostSnapshot, 'models' | 'clientHosts' | 'threads'> & {
  models: AgentModelCatalogBroadcast
  clientHosts?: AgentClientHostBroadcast[]
  threads: AgentThreadsBroadcast
}
/**
 * What actually crosses `sotto:agents:state`: `AgentState` with its catalogs replaced by `AgentModelCatalogBroadcast`
 * and its threads by `AgentThreadsBroadcast`.
 */
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
 * titles. A `visual:` message without a visual it can read (a shape this reader does not know, or a
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
export function summarizeThread(thread: { readonly messages: readonly AgentMessage[]; readonly activities?: readonly AgentActivity[] | undefined }): AgentThreadSummary {
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
 * list; Muse cannot yet disable every tool in one (ADR-0079). Those threads, and a provider's that has not said it
 * writes them, keep their first-message title or stand-in and are offered no Regenerate that could do nothing.
 * OpenCode writes them through its stateless generation route (ADR-0087); a model source that refuses it, as OpenCode
 * Zen's free models do, writes nothing, and its threads keep their stand-ins.
 */
export function providerWritesShortText(providerId: ProviderId | undefined): boolean {
  return providerId === undefined || providerProfile(providerId)?.writesShortText === true
}
/**
 * Whether this provider can receive Sotto's tool servers, as its profile says. Older unlabelled local hosts retain their
 * tools. Devin's threads take them only where their host says it gives them (`threadTakesSottoTools`).
 */
export function providerTakesSottoTools(providerId: ProviderId | undefined): boolean {
  return providerId === undefined || providerProfile(providerId)?.takesSottoTools === true
}
/**
 * Whether this thread's agent gets Sotto's tool servers. Every provider whose profile says so takes them: Muse when its client grants
 * session tool servers (ADR-0079), Devin from CLI 3000.11.92, which attaches the servers a session is opened with
 * (ADR-0056), and OpenCode when its thread's server connects every one (ADR-0087). A client that cannot take them marks
 * its threads `sottoToolsWithheld`, and a Devin thread counts only when
 * its host says it gives them (`sottoToolsGiven`).
 */
export function threadTakesSottoTools(thread: Pick<AgentThread, 'providerId' | 'sottoToolsWithheld' | 'sottoToolsGiven'> | undefined): boolean {
  if (!providerTakesSottoTools(thread?.providerId) || thread?.sottoToolsWithheld === true) return false
  // A host older than Devin taking Sotto's tools never says either way, and its Devin threads have none (#1086).
  return thread?.providerId !== 'devin' || thread.sottoToolsGiven === true
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
  // `newThreadRuntimeMode: null` puts the default back to the provider's own: unlike undefined, JSON carries it to a host.
  // `hostId` is the desktop window's alone: the connected host whose own settings the patch changes, which the router
  // reads and never sends on (ADR-0074). Without it a patch goes to the selected host, and new-thread defaults to this computer.
  z.object({ type: z.literal('configure'), patch: agentConfigurationSchema.partial().extend({ provider: providerIdSchema.optional(), reasoningEffort: z.string().max(64).optional(), checkClientUpdates: z.boolean().optional(), museDisableSandbox: z.boolean().optional(), newThreadReasoningEffort: z.string().max(64).optional(),
    claudeUltracodeEffort: z.enum(ULTRACODE_EFFORTS).optional(), newThreadRuntimeMode: agentRuntimeModeSchema.nullable().optional() }), hostId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('credential'), slot: z.enum(['reasoning']), value: z.string().max(16_384) }).strict(),
  // Setup and Settings show connection status themselves; this can only suppress the Threads notice.
  // `hostId` on a provider command is the desktop window's alone, like Update all's: Settings > Providers names this
  // computer, so its buttons never reach whichever host is selected for new work. The router reads it and never sends it on.
  z.object({ type: z.literal('connect'), provider: providerIdSchema.optional(), notice: z.literal(false).optional(), hostId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('disconnect'), provider: providerIdSchema.optional(), hostId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('refresh'), provider: providerIdSchema.optional(), hostId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('refresh-thread-skills'), threadId: id, forceReload: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('check-reasoning'), provider: subscriptionProviderSchema }).strict(),
  z.object({ type: z.literal('check-client-updates'), hostId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('update-client'), provider: providerIdSchema, force: z.boolean().optional(), hostId: z.uuid().optional() }).strict(),
  /**
   * Puts clients in the machine's one-at-a-time update line and answers at once; each client's reading says how it went.
   * `hostId` names the machine for Update all (ADR-0077), which need not be the selected one; the desktop's router reads it
   * and never sends it on.
   */
  z.object({ type: z.literal('queue-client-updates'), providers: z.array(providerIdSchema).min(1).max(PROVIDER_COUNT), hostId: z.uuid().optional() }).strict(),
  /** Takes clients that are still waiting out of the update line. One already running is left to finish. */
  z.object({ type: z.literal('cancel-client-updates'), providers: z.array(providerIdSchema).min(1).max(PROVIDER_COUNT) }).strict(),
  z.object({ type: z.literal('dismiss-client-updates') }).strict(),
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
  z.object({ type: z.literal('set-aside-send'), threadId: id, draftId: z.uuid() }).strict(),
  z.object({ type: z.literal('manual-send'), threadId: id, text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional(), draftId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal('queue-followup'), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('edit-followup'), threadId: id, itemId: z.uuid(), text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('steer-followup'), threadId: id, itemId: z.uuid() }).strict(),
  z.object({ type: z.literal('remove-followup'), threadId: id, itemId: z.uuid() }).strict(),
  z.object({ type: z.literal('reorder-followups'), threadId: id, itemIds: z.array(z.uuid()).max(100) }).strict(),
  z.object({ type: z.literal('resume-followups'), threadId: id }).strict(),
  z.object({ type: z.literal('steer'), threadId: id, draftId: z.uuid(), text, attachments: agentAttachmentHandlesSchema.optional(), skills: agentSkillReferencesSchema.optional(), files: agentFileReferencesSchema.optional() }).strict(),
  z.object({ type: z.literal('cancel-draft') }).strict(),
  z.object({ type: z.literal('create-project'), provider: providerIdSchema.optional(), title: id, path: z.string().max(4_096).optional(), useExisting: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('select-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('settle-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('restore-project'), projectId: providerEntityId }).strict(),
  z.object({ type: z.literal('settle-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('restore-thread'), threadId: id }).strict(),
  /**
   * Clearing settled threads (ADR-0140), an Owl feature. `preview-delete-thread` says whether one settled thread may be
   * deleted and what its own worktree would take; `delete-thread` deletes it, with the same confirmations Remove worktree
   * takes for its folder. `preview-clear-threads` lists this computer's settled threads quiet longer than `olderThanDays`
   * (0 is any age) that would go and those kept; `clear-threads` deletes those of `threadIds` that still qualify. Each is
   * checked again as it is deleted, and nothing can be taken back. Unlike Remove worktree, `delete-thread` takes no answer
   * to uncommitted changes: a thread whose worktree has them is kept (ADR-0140 decision 3).
   */
  z.object({ type: z.literal('preview-delete-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('delete-thread'), threadId: id, confirmedIgnored: z.array(z.string()).optional(), confirmedItems: z.array(z.object({ path: z.string(), fileCount: z.number().int().nonnegative() }).strict()).optional(), confirmedRepositories: z.array(z.object({ path: z.string(), changeCount: z.number().int().nonnegative(), unpushedCommitCount: z.number().int().nonnegative().optional(), kind: z.enum(['worktree', 'repository']) }).strict()).optional() }).strict(),
  z.object({ type: z.literal('preview-clear-threads'), olderThanDays: clearThreadsAgeSchema }).strict(),
  z.object({ type: z.literal('clear-threads'), olderThanDays: clearThreadsAgeSchema, threadIds: z.array(id).min(1).max(THREAD_CLEAR_MAX) }).strict(),
  /** A pure Sotto-side edit of the thread's name; the trimmed title must not be empty. */
  z.object({ type: z.literal('rename-thread'), threadId: id, title: z.string().max(512) }).strict(),
  /** Ask the thread's own provider for its name again, on the side, replacing a generated or stand-in one. */
  z.object({ type: z.literal('regenerate-thread-title'), threadId: id }).strict(),
  z.object({ type: z.literal('create-thread'), projectId: providerEntityId, title: id, modelId: providerEntityId,
    /** `user` when the title is the one the user typed, `default` when it is Sotto's stand-in name. */
    titleSource: z.enum(['user', 'default']).optional(),
    /** The Sotto thread ID the window already minted and is showing. Absent from older callers, which let main mint one. */
    threadId: z.uuid().optional(),
    workingCopy: z.enum(['independent', 'shared']).optional(),
    baseBranch: z.string().min(1).max(512).optional(), startFromOrigin: z.boolean().optional(), existingWorktreePath: z.string().min(1).max(4096).optional(),
    /** A worker started from a thread's branch (#1033): the move that landed it in this project's incoming ref, which the
     * thread's new worktree is made from. Watcher's and delegation's own starts only; a person's create-thread is refused. */
    startFromMove: z.uuid().optional(),
    /** With `startFromMove`, the thread whose branch it was, kept on the new worktree so its commits can be brought back to
     * that branch (#1030). Watcher's own starts only. */
    madeFrom: worktreeMadeFromSchema.optional(),
    /** A check its machine's queue started (#1312): a new worktree it gets is the machine's one check worktree for the
     * repository, moved to the check's commit. Watcher's and delegation's own starts only; a person's create-thread is refused. */
    check: z.literal(true).optional(),
    reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional(), providerMode: providerEntityId.optional(),
    speed: agentSpeedSchema.nullable().optional(), fastMode: z.boolean().optional() }).strict(),
  /**
   * One of a thread's agents continued as a thread of its own (#1028). `threadId` is the agent's thread, so the command goes
   * to that thread's host, and `newThreadId` the thread to make, which the window mints. A Codex agent is forked by Codex
   * itself; a Claude Code agent, or a Codex agent with `handover`, starts from a thin handover of its task and result that
   * goes with the new thread's first message. Nothing is sent to any provider until that message.
   */
  z.object({ type: z.literal('continue-agent'), threadId: id, agentId: id, newThreadId: z.uuid(), modelId: providerEntityId.optional(),
    handover: z.literal(true).optional(), workingCopy: z.enum(['independent', 'shared']).optional(),
    baseBranch: z.string().min(1).max(512).optional(), startFromOrigin: z.boolean().optional() }).strict(),
  /**
   * Fork from here (#1028, E5b): a new thread with `threadId`'s conversation up to its reply `messageId`. Codex and Claude
   * Code copy it themselves; any other provider starts the new thread from a handover of it that goes with its first
   * message. `newThreadId` is the thread to make, which the window mints. Nothing is sent to any provider until then.
   */
  z.object({ type: z.literal('fork-thread'), threadId: id, messageId: id, newThreadId: z.uuid(), modelId: providerEntityId.optional(),
    workingCopy: z.enum(['independent', 'shared']).optional(), baseBranch: z.string().min(1).max(512).optional(), startFromOrigin: z.boolean().optional() }).strict(),
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
  /**
   * Bring this thread's commits to the branch of the thread it began from (#1030): fast-forward that branch, or make a merge
   * commit on it. Without `mergeCommit` a needed merge commit is asked about and nothing changes; `mergeCommit` names the
   * question it answers yes to, by that press's `actionId`. A conflict or uncommitted work is refused.
   */
  z.object({ type: z.literal('bring-changes-back'), threadId: id, actionId: z.uuid(), mergeCommit: z.uuid().optional(),
    /**
     * Only from a desktop, to the host of the thread the commits go to, for a child on another machine: `threadId` then
     * names that thread, and the child's branch is already in the incoming ref of `away.moveId` there.
     */
    away: bringBackAwaySchema.optional() }).strict(),
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
    method: gitPullRequestMergeMethodSchema.optional(),
    /**
     * From a paired client, the confirmation receipt its host gave for this very press (#1691): a merge, a close or an
     * auto-merge without one is refused. The desktop's router asks for one after the user confirms in the window, and a
     * window never names one itself.
     */
    confirmation: z.uuid().optional(),
    /**
     * From the desktop's window only: the read ID of the reading of the pull request the window showed when the user
     * pressed, which its router names when it asks a paired host for a confirmation receipt, and never sends on (#1691).
     */
    readId: z.uuid().optional(),
    /**
     * Set only by the host's own socket server, from a receipt: the head commit the pull request must still be on, which
     * `gh pr merge --match-head-commit` holds GitHub to. A paired client that sends it is refused.
     */
    matchHeadCommit: gitCommitIdSchema.optional() }).strict(),
  /** Link a pull request to the thread by a GitHub URL or `#42`, or take the link away again. */
  z.object({ type: z.literal('git-link-pull-request'), threadId: id, reference: z.string().min(1).max(2_048) }).strict(),
  z.object({ type: z.literal('git-unlink-pull-request'), threadId: id, url: gitPullRequestUrlSchema }).strict(),
  /** The user's Babysit pull request and Stop babysitting, on a pull request the thread knows (ADR-0061 decision 3). */
  z.object({ type: z.literal('babysit-pull-request'), threadId: id, url: gitPullRequestUrlSchema }).strict(),
  z.object({ type: z.literal('stop-babysitting'), threadId: id, url: gitPullRequestUrlSchema }).strict(),
  /** The user's Don't restart on a thread's scheduled restart (ADR-0144): Sotto drops it and the thread waits for them. */
  z.object({ type: z.literal('cancel-restart'), threadId: id }).strict(),
  /** T3's Checkout pull request: `local` checks it out in the thread's folder with `gh pr checkout`; `worktree` fetches its
   * head as a branch a draft's new worktree takes on first send. */
  z.object({ type: z.literal('git-checkout-pull-request'), threadId: id, reference: z.string().min(1).max(2_048), mode: z.enum(['local', 'worktree']) }).strict(),
  agentThreadOptionsSchema.extend({ type: z.literal('configure-thread'), threadId: id }).strict()
    .refine(value => value.modelId !== undefined || value.reasoningEffort !== undefined || value.runtimeMode !== undefined || value.providerMode !== undefined
      || value.fastMode !== undefined || value.speed !== undefined, 'Choose a thread setting to change.'),
  z.object({ type: z.literal('select-thread'), threadId: id }).strict(),
  /** `shownThreadIds`: which of them the client shows now, where that is fewer; the socket server says so for the paired
   * desktops whose windows are behind another app (ADR-0092). Absent, every observed thread is shown. A paired client
   * cannot send it: it is not on the remote allow-list. */
  z.object({ type: z.literal('observe-threads'), threadIds: z.array(id).max(100), shownThreadIds: z.array(id).max(100).optional() }).strict(),
  /** Dismiss all: each named thread reads as seen, as if a client had shown it, when it still stands in the failure its
   * row showed (ADR-0092); one that failed again since is left as news. It answers no request and grants nothing; a
   * thread waiting on a permission or a question is never one of them. `failure` is the thread's `failureId`, empty
   * for a host that names none. */
  z.object({ type: z.literal('dismiss-failures'), failures: z.array(z.object({ threadId: id, failure: z.string().max(64) }).strict())
    .min(1).max(AGENT_DISMISS_FAILURES_MAX) }).strict(),
  /** Widen one thread's loaded window by another twenty turns, because the pane asked for earlier messages. */
  z.object({ type: z.literal('load-earlier-messages'), threadId: id, throughMessageId: id.optional() }).strict(),
  /** Early start: the user began typing in this thread's composer, so its provider session is started now rather than
   * inside the next send. Starts nothing a send would not, creates no provider session, worktree or branch, sends no
   * prompt, and says nothing when it cannot start: the send reports its own error (#769). */
  z.object({ type: z.literal('start-thread-session'), threadId: id }).strict(),
  z.object({ type: z.literal('interrupt'), threadId: id }).strict(),
  z.object({ type: z.literal('compact-thread'), threadId: id }).strict(),
  z.object({ type: z.literal('answer'), threadId: id, requestId: id, answer: text, approved: z.boolean().optional(), questionAnswers: agentQuestionAnswersSchema.optional(), permissionChoice: id.optional(),
    /** The user skipped a `skippable` question: its provider is told so and the turn goes on without an answer. */
    skipped: z.literal(true).optional() }).strict(),
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
  /** One record of a remote thread whole, for a row whose body its host sent cut; null for this computer's threads. */
  activityBody?(request: AgentActivityBodyRequest): Promise<AgentActivity | null>
  /** Every message the user sent above the window a pane holds, for the message scrubber (ADR-0109); null when the host cannot say. */
  threadPrompts?(request: AgentThreadPromptsRequest): Promise<AgentThreadPrompts | null>
  /** Whole details and the deltas between them; a delta the window cannot apply sends it back to `threadDetail`. */
  onThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
  /**
   * The words of the handover a thread that began from another goes with on its first message, as its provider will read
   * them, or null once it has none (#1028). Read on the thread's own host, and only when the user asks.
   */
  startHandover?(threadId: string): Promise<AgentStartHandover | null>
}
export const agentStartHandoverSchema = z.object({ text: z.string() }).strict()
/** A window's request for one record whole: the thread by the window's own key, and the record's ID. */
export const agentActivityBodyRequestSchema = z.object({ threadId: id, activityId: z.string().min(1).max(512) }).strict()
export type AgentActivityBodyRequest = z.infer<typeof agentActivityBodyRequestSchema>
export type AgentStartHandover = z.infer<typeof agentStartHandoverSchema>

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
const INSTALLED_PROVIDER_ORDER = everyProvider(['codex', 'claude', 'grok', 'devin', 'muse', 'opencode', 'cursor', 'deepseek'])
/**
 * What Connect providers turns on: every thread client installed on this machine, Devin included, except one the user
 * turned off, added to the ones already on, as a headless host connects them all (ADR-0036). A client already on stays
 * on even when it is not found, since one being updated can be missing for a moment. When the default's own client is
 * not installed, the default moves to the first of Codex, Claude Code, Grok Build and Devin that is, and the on set
 * becomes the installed clients, so the missing default is not tried again. Returns null when that changes nothing, or
 * when no client is installed and on.
 */
export function selectInstalledProviders(configuration: AgentConfiguration, installed: readonly ProviderId[]): Pick<AgentConfiguration, 'provider' | 'enabledProviders'> | null {
  const present = new Set(installed)
  const off = new Set(configuration.disconnectedProviders ?? [])
  const found: ProviderId[] = INSTALLED_PROVIDER_ORDER.filter(id => present.has(id) && !off.has(id))
  const keepDefault = found.includes(configuration.provider)
  const provider = keepDefault ? configuration.provider : found[0]
  if (!provider) return null
  const enabled = enabledThreadProviders(configuration)
  const enabledProviders = keepDefault ? [...new Set([...enabled.filter(id => !off.has(id)), ...found])] : found
  if (provider === configuration.provider && enabled.length === enabledProviders.length && enabledProviders.every(id => enabled.includes(id))) return null
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
/** A thread's provider as a host holds it: its own, or for a thread that names none, its model's public identity's. */
export function threadProviderOf(thread: Pick<AgentThread, 'providerId' | 'modelId'>): ProviderId | undefined {
  return thread.providerId ?? parsePublicProviderEntityId(thread.modelId)?.provider
}
/** The provider, kind and native value a public ID names, or null for any other ID or one whose value will not decode. */
export function parsePublicProviderEntityId(id: string): { readonly provider: ProviderId; readonly kind: 'model' | 'project'; readonly value: string } | null {
  const match = /^native:([a-z]+):(model|project):(.*)$/u.exec(id)
  // Most IDs that pass through here are not public ones; asking the schema about them builds a ZodError each time.
  if (!match) return null
  const provider = providerIdSchema.safeParse(match[1])
  if (!provider.success) return null
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
 * The model a new thread in a project starts on (issue #347): the model chosen in Settings → Threads' "New
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
