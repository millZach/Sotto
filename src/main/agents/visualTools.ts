import { z } from 'zod'
import { checkVisualInput, VISUALS_PER_THREAD_MAX, VISUALS_PER_TURN_MAX, visualInputSchema, type VisualInput } from '../../shared/visuals'
import { MAX_DIAGRAM_SOURCE_LENGTH } from '../../shared/diagramSource'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'
import type { VisualAddition } from './workspace'

/** The one name every client addresses the visual tool by (ADR-0055). */
export const VISUAL_MCP_SERVER = 'sotto_visual'
export const VISUALIZE_TOOL = 'visualize'

const DESCRIPTION = [
  'Draw a diagram in this thread, where the user reads your replies, to show how something works: a flow, an architecture, a state machine, a sequence of calls between parts.',
  'Use it when a picture explains better than words, and whenever the user asks for a diagram or a visual.',
  `Send a title, kind "diagram" and Mermaid source for a flowchart, sequence, state, class or entity relationship diagram, up to ${MAX_DIAGRAM_SOURCE_LENGTH.toLocaleString('en-US')} characters, with no init directives or configuration.`,
  'Add an intro of a sentence or two, and up to 12 steps that walk through the diagram one part at a time.',
  'A step\'s highlight names the parts it is about: flowchart node ids, subgraph ids and edges written A->B; state ids; class or entity names; for a sequence diagram, participant names and arrow numbers counted from 1. Unknown names are ignored.',
  `A turn can draw up to ${VISUALS_PER_TURN_MAX} visuals and a thread up to ${VISUALS_PER_THREAD_MAX}.`,
  'The visual appears under your last message, so carry on from it in your reply rather than repeating its steps.',
].join(' ')
const INSTRUCTIONS = 'visualize draws a diagram in this thread, under your last message. It changes nothing outside the thread and asks the user nothing. Use it to show how something works, or when the user asks for a visual. If a call is refused, nothing was drawn: explain in text instead.'
export const visualizeDefinition: ThreadToolDefinition = { name: VISUALIZE_TOOL, description: DESCRIPTION, inputSchema: z.toJSONSchema(visualInputSchema, { io: 'input' }) as Record<string, unknown> }

/** What the tool asks of Sotto for the thread that called. */
export interface VisualToolHandlers {
  /** Let agents draw visuals in threads, read at every launch and every call. */
  enabled(): boolean
  /** Whether this Sotto thread may draw one: a project thread on this computer, on a provider that offers Sotto's tools. */
  admits(threadId: string): boolean
  add(threadId: string, input: VisualInput): Promise<VisualAddition>
}

const NOTHING = 'Nothing was drawn.'
const INSTEAD = 'Explain in text instead.'
const REFUSALS: Record<Extract<VisualAddition, { added: false }>['reason'], string> = {
  'unknown-thread': `This thread cannot show visuals. ${NOTHING} ${INSTEAD}`,
  'history-unavailable': `Sotto could not save this thread's history just now. ${NOTHING} ${INSTEAD}`,
  'turn-limit': `This turn already drew ${VISUALS_PER_TURN_MAX} visuals, the most one turn can draw. ${NOTHING} ${INSTEAD}`,
  'thread-limit': `This thread already holds ${VISUALS_PER_THREAD_MAX} visuals, the most one thread can hold. ${NOTHING} ${INSTEAD}`,
}
const WHERE: Record<Extract<VisualAddition, { added: true }>['anchor'], string> = {
  assistant: 'under your last message', user: 'under the user\'s message', none: 'at the start of the thread',
}

/** "a flowchart", "an entity relationship diagram": the diagram's kind as the reply names it. */
function described(label: string): string {
  const words = label.toLocaleLowerCase('en-US')
  return `${/^[aeiou]/u.test(words) ? 'an' : 'a'} ${words}`
}

/** The sentence a drawn visual answers with: what was shown, where, and what not to do next. */
export function visualShownText(title: string, label: string, steps: number, anchor: Extract<VisualAddition, { added: true }>['anchor']): string {
  const shape = steps > 0 ? `${described(label)} with ${steps} ${steps === 1 ? 'step' : 'steps'}` : described(label)
  return `Shown in the thread as "${title}": ${shape}, ${WHERE[anchor]}.${steps > 0 ? ' Do not repeat the steps in your reply.' : ''}`
}

/**
 * `sotto_visual`: the loopback MCP server through which an agent in a project thread draws a visual in that thread
 * (ADR-0055). Every launch of an admitted thread gets it while Let agents draw visuals in threads is on, and none
 * otherwise; a running session's call is refused once the switch is off. Drawing in the thread changes nothing outside
 * it, so no call asks the user anything.
 */
export class VisualToolServer implements ScopedThreadTools {
  readonly name = VISUAL_MCP_SERVER
  readonly definitions: readonly ThreadToolDefinition[] = [visualizeDefinition]
  private readonly server: ThreadToolServer
  constructor(private readonly handlers: VisualToolHandlers) {
    this.server = new ThreadToolServer({ name: VISUAL_MCP_SERVER, serverName: 'sotto-visual', instructions: INSTRUCTIONS,
      unavailable: `The visual tool is unavailable. ${NOTHING} ${INSTEAD}`, failed: `The visual could not be drawn. ${NOTHING} ${INSTEAD}` },
    this.definitions, (threadId, name, args) => this.invoke(threadId, name, args))
  }
  /** This thread's server while visuals are on and the thread may draw one; undefined otherwise. */
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    if (!this.handlers.enabled() || !this.admits(threadId)) return undefined
    return this.server.mcpServer(threadId)
  }
  call(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> { return this.server.call(threadId, name, args) }
  close(): Promise<void> { return this.server.close() }
  private admits(threadId: string): boolean {
    try { return this.handlers.admits(threadId) } catch { return false }
  }
  private async invoke(threadId: string, _name: string, args: unknown): Promise<ThreadToolResult> {
    const text = (value: string, isError = false): ThreadToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) })
    if (!this.handlers.enabled()) return text(`Visuals are turned off in Sotto's settings. ${NOTHING} ${INSTEAD}`, true)
    if (!this.admits(threadId)) return text(REFUSALS['unknown-thread'], true)
    const check = checkVisualInput(args)
    if (!check.ok) return text(`${check.reason} ${NOTHING} Fix it and call visualize again, or explain in text.`, true)
    const result = await this.handlers.add(threadId, check.input)
    if (!result.added) return text(REFUSALS[result.reason], true)
    return text(visualShownText(result.visual.title, check.label, result.visual.steps?.length ?? 0, result.anchor))
  }
}
