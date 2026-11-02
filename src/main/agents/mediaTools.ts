import { z } from 'zod'
import { MAX_ACTIVITY_MEDIA } from '../../shared/agentActivity'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'
import type { ShownMediaResult } from './workspace'
import type { ShownRefusal } from './shownMedia'

/** The one name every client addresses the media tool by (ADR-0170, request-only amendment). */
export const MEDIA_MCP_SERVER = 'sotto_media'
export const SHOW_IN_THREAD_TOOL = 'show_in_thread'

/** The longest step title an agent gives. */
export const SHOWN_TITLE_MAX = 120

const DESCRIPTION = [
  'Show picture or video files in this thread, where the user reads your replies: a screenshot, a recording or an image file on this computer.',
  'Call it only when the user asked in this conversation to see a picture or video. Do not call it on your own to illustrate your work, to show a page or prototype you can link to, or because a tool or test produced a picture: a link or words are enough there.',
  `Name up to ${MAX_ACTIVITY_MEDIA} files, each relative to the thread's working folder or absolute: PNG, JPEG, GIF or WebP pictures, or MP4, QuickTime or WebM videos.`,
  'Give a short title saying what they show; it heads the pictures in the thread.',
  'The pictures appear in the thread for the user. You are not sent them back, so describe in your reply what the user should look at.',
].join(' ')
const INSTRUCTIONS = 'show_in_thread shows picture or video files in this thread for the user. Call it only when the user asked in this conversation to see a picture or video, never on your own and never for a prototype or page you can link to. It changes nothing outside the thread and asks the user nothing. Where tools are found by search and called through use_tool, search for it first and call it by its full name, sotto_media__show_in_thread.'

const showInputSchema = z.object({
  paths: z.array(z.string().trim().min(1).max(4096)).min(1).max(MAX_ACTIVITY_MEDIA)
    .describe('The picture or video files to show, relative to the thread\'s working folder or absolute.'),
  title: z.string().trim().min(1).max(SHOWN_TITLE_MAX).describe('What the pictures show, in a few words: it heads them in the thread.'),
}).strict()
export type ShowInput = z.infer<typeof showInputSchema>
export const showInThreadDefinition: ThreadToolDefinition = { name: SHOW_IN_THREAD_TOOL, description: DESCRIPTION, inputSchema: z.toJSONSchema(showInputSchema, { io: 'input' }) as Record<string, unknown>,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }

/** What the tool asks of Sotto for the thread that called. */
export interface MediaToolHandlers {
  /** Whether this Sotto thread may show pictures: one this host holds, on a provider that takes Sotto's tools. */
  admits(threadId: string): boolean
  show(threadId: string, input: ShowInput): Promise<ShownMediaResult>
}

const NOTHING = 'Nothing was shown.'
const INSTEAD = 'Tell the user where the files are instead.'
const WHY: Readonly<Record<ShownRefusal, string>> = {
  missing: 'there is no such file',
  'not-media': 'it is not a picture or video Sotto shows',
  'too-large': 'it is too large to show',
  'not-local': 'it is not on this computer',
}
/** "a.png (there is no such file); b.txt (it is not a picture or video Sotto shows)". */
const refusedText = (refused: readonly { readonly path: string; readonly reason: ShownRefusal }[]): string =>
  refused.map(item => `${item.path} (${WHY[item.reason]})`).join('; ')

/**
 * `sotto_media`: the loopback MCP server through which an agent shows picture and video files in its thread when the
 * user asks to see one (ADR-0170, request-only amendment of November 1, 2026). Offered with the Owl feature
 * `inline-media` on, to every thread that takes Sotto's tools, on the desktop and on a headless host. Showing in the
 * thread changes nothing outside it, so no call asks the user anything.
 */
export class MediaToolServer implements ScopedThreadTools {
  readonly name = MEDIA_MCP_SERVER
  readonly definitions: readonly ThreadToolDefinition[] = [showInThreadDefinition]
  private readonly server: ThreadToolServer
  constructor(private readonly handlers: MediaToolHandlers) {
    this.server = new ThreadToolServer({ name: MEDIA_MCP_SERVER, serverName: 'sotto-media', instructions: INSTRUCTIONS,
      unavailable: `The media tool is unavailable. ${NOTHING} ${INSTEAD}`, failed: `The pictures could not be shown. ${NOTHING} ${INSTEAD}` },
    this.definitions, (threadId, _name, args) => this.invoke(threadId, args))
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    return this.admits(threadId) ? this.server.mcpServer(threadId) : undefined
  }
  call(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> { return this.server.call(threadId, name, args) }
  close(): Promise<void> { return this.server.close() }
  private admits(threadId: string): boolean {
    try { return this.handlers.admits(threadId) } catch { return false }
  }
  private async invoke(threadId: string, args: unknown): Promise<ThreadToolResult> {
    const text = (value: string, isError = false): ThreadToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) })
    if (!this.admits(threadId)) return text(`This thread cannot show pictures. ${NOTHING}`, true)
    const input = showInputSchema.safeParse(args)
    if (!input.success) return text(`Name 1 to ${MAX_ACTIVITY_MEDIA} files in "paths" and a "title" of up to ${SHOWN_TITLE_MAX} characters. ${NOTHING}`, true)
    const result = await this.handlers.show(threadId, input.data)
    if (!result.shown) {
      return text(result.reason === 'unknown-thread' ? `This thread cannot show pictures. ${NOTHING}` : `${NOTHING} ${refusedText(result.refused)}.`, true)
    }
    const shown = `Shown in the thread as "${input.data.title}": ${result.count} ${result.count === 1 ? 'file' : 'files'}.`
    return text(result.refused.length ? `${shown} Not shown: ${refusedText(result.refused)}.` : shown)
  }
}
