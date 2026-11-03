import { z } from 'zod'

import { applyAgentThreadDetailDelta, isAgentThreadDetailDelta } from '../../../shared/agentThreadDetail'
import type { AgentMessage, AgentProject, AgentState, AgentThreadDetail, AgentThreadDetailUpdate } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'

/** Who the popup is talking to (ADR-0181): a thread, or Watcher while Watcher is on. */
export type PopupTarget = 'thread' | 'watcher'

/**
 * What the popup keeps for next time on this computer: its target, the thread it last used, and the project of the last
 * thread it used or started, where New thread starts the next one.
 */
export interface PopupMemory {
  readonly target: PopupTarget
  readonly threadId: string | null
  readonly projectId: string | null
}

export const POPUP_MEMORY_KEY = 'sotto.popup'
const memorySchema = z.object({ target: z.enum(['thread', 'watcher']), threadId: z.string().min(1).max(6_144).nullable(),
  projectId: z.string().min(1).max(6_144).nullable().catch(null) })
const NO_MEMORY: PopupMemory = { target: 'thread', threadId: null, projectId: null }

export function readPopupMemory(storage: Pick<Storage, 'getItem'> | undefined): PopupMemory {
  try {
    const raw = storage?.getItem(POPUP_MEMORY_KEY)
    if (raw === null || raw === undefined || raw.length > 8_192) return NO_MEMORY
    const parsed = memorySchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : NO_MEMORY
  } catch {
    return NO_MEMORY
  }
}

export function writePopupMemory(storage: Pick<Storage, 'setItem'> | undefined, memory: PopupMemory): void {
  try { storage?.setItem(POPUP_MEMORY_KEY, JSON.stringify(memory)) } catch { /* Not kept: the popup starts on a thread next time. */ }
}

/** The popup's slash commands, in the order the menu lists them. */
export type SlashCommand = 'new' | 'stop' | 'open' | 'watcher' | 'thread'

/** On a thread: a new thread, Stop, Open, and Watcher while it is on. On Watcher, one conversation: back to the thread, and Open. */
export function slashCommands(target: PopupTarget, watcherOffered: boolean): readonly SlashCommand[] {
  if (target === 'watcher') return ['thread', 'open']
  return watcherOffered ? ['new', 'stop', 'open', 'watcher'] : ['new', 'stop', 'open']
}

/** The commands a `/` at the start of the prompt offers: those its letters begin, else those that hold them, five at most. */
export function slashMatches(input: string, commands: readonly SlashCommand[]): readonly SlashCommand[] {
  if (!input.startsWith('/') || /\s/u.test(input)) return []
  const query = input.slice(1).toLowerCase()
  const starts = commands.filter(command => command.startsWith(query))
  return (starts.length > 0 ? starts : commands.filter(command => command.includes(query))).slice(0, 5)
}

/** A prompt that is exactly one of the commands, such as `/new` with nothing after it, runs that command when sent. */
export function slashCommandOf(input: string, commands: readonly SlashCommand[]): SlashCommand | null {
  const word = input.trim()
  if (!word.startsWith('/')) return null
  const name = word.slice(1).toLowerCase()
  return commands.find(command => command === name) ?? null
}

export type PopupKeyAction = 'send' | 'newline' | 'run-command' | 'complete' | 'menu-next' | 'menu-previous' | 'stop' | 'close-menu' | 'hide' | 'open'

export interface PopupKeyContext {
  readonly platform: SottoPlatform
  /** The slash menu is showing. */
  readonly menu: boolean
  /** A thread turn runs, so Escape stops it. Watcher's turn is not stopped from here. */
  readonly canStop: boolean
}

/**
 * What a key in the prompt does (ADR-0181): Return sends and Shift+Return (or Option/Alt+Return) is a new line; with the
 * slash menu open, Return runs the command, Tab completes it and the arrows move. Escape closes the menu, then stops a
 * running thread turn, then hides the popup. Command+O on a Mac, Ctrl+O elsewhere, opens it in the main window.
 */
export function popupKeyAction(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing'>, context: PopupKeyContext): PopupKeyAction | null {
  if (event.isComposing) return null
  const primary = context.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'o') return 'open'
  if (event.key === 'Escape') return context.menu ? 'close-menu' : context.canStop ? 'stop' : 'hide'
  if (context.menu && !event.shiftKey && !event.altKey) {
    if (event.key === 'ArrowDown') return 'menu-next'
    if (event.key === 'ArrowUp') return 'menu-previous'
    if (event.key === 'Tab') return 'complete'
    if (event.key === 'Enter') return 'run-command'
  }
  if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return null
  return event.shiftKey || event.altKey ? 'newline' : 'send'
}

/** A thread's messages as the popup keeps them: no activity, which it never shows. */
export type PopupDetail = Pick<AgentThreadDetail, 'threadId' | 'revision' | 'messages'>

/** A whole detail as kept, or a delta applied to what is kept; null when the delta needs the whole detail read again. */
export function nextPopupDetail(held: PopupDetail | null, update: AgentThreadDetailUpdate): PopupDetail | null {
  if (!isAgentThreadDetailDelta(update)) return { threadId: update.threadId, revision: update.revision, messages: update.messages }
  if (held === null || held.threadId !== update.threadId) return null
  const next = applyAgentThreadDetailDelta(held, { ...update, activityDeltas: [] })
  return next === null ? null : { threadId: next.threadId, revision: next.revision, messages: next.messages }
}

/** The newest messages the card shows: what the user and the agent wrote, no wake-up Sotto sent and no hidden one. */
export const POPUP_MESSAGES_SHOWN = 40

export function shownMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  const shown: AgentMessage[] = []
  for (let index = messages.length - 1; index >= 0 && shown.length < POPUP_MESSAGES_SHOWN; index--) {
    const message = messages[index]!
    if (message.wakeUp === true || message.hiddenWakeUp === true) continue
    if (message.text.trim() === '' && (message.attachments?.length ?? 0) === 0) continue
    shown.push(message)
  }
  return shown.reverse()
}

/**
 * Where New thread starts one (ADR-0181): the project of the last thread the popup used or started while that project is
 * still open, else the project the user last chose in the main window, else the first one.
 */
export function popupProject(shell: Pick<AgentState, 'activeProjectId'> & { readonly host: Pick<AgentState['host'], 'projects'> }, projectId: string | null): AgentProject | null {
  const open = shell.host.projects.filter(project => !project.workspaceSettledAt)
  return open.find(project => project.id === projectId) ?? open.find(project => project.id === shell.activeProjectId) ?? open[0] ?? null
}
