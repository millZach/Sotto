import { z } from 'zod'
import { hostEntityKey } from './clientIdentity'

/**
 * A to-do: what only the user's hands can do (ADR-0188). Each computer keeps its own and a client joins them, as it does
 * threads. It is not a request: checking one off answers nothing and approves nothing. Owl only (`to-do-list`).
 */
export const TO_DO_MCP_SERVER = 'sotto_to_do'
export const TO_DO_TOOL = 'add_to_do'
/** The most items one computer holds. */
export const TO_DOS_MAX = 100
export const TO_DO_TITLE_MAX = 200
export const TO_DO_WHY_MAX = 500
export const TO_DO_LINK_LABEL_MAX = 60
export const TO_DO_URL_MAX = 2_048
export const TO_DO_STEPS_MAX = 20
export const TO_DO_STEP_MAX = 400
/** How much the user may say when it did not work. */
export const TO_DO_NOTE_MAX = 2_000
/** How many one thread may add in `TO_DO_LIMIT_WINDOW_MS`, so one thread cannot flood the list. */
export const TO_DO_LIMIT = 10
export const TO_DO_LIMIT_WINDOW_MS = 10 * 60_000
/** How long a client holds a check-off before it sends it, with Undo showing. */
export const TO_DO_UNDO_MS = 5_000

const webAddress = z.string().trim().min(1).max(TO_DO_URL_MAX).refine(value => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}, 'Give a web address.')
const title = z.string().trim().min(1).max(TO_DO_TITLE_MAX)

export const toDoLinkSchema = z.object({ label: z.string().trim().min(1).max(TO_DO_LINK_LABEL_MAX), url: webAddress }).strict()
export type ToDoLink = z.infer<typeof toDoLinkSchema>

/** What a thread or Watcher gives `add_to_do`, as its tool reads it. */
export const toDoAddSchema = z.object({
  title: title.describe('What the user has to do, as a short instruction, such as "Hand test links on a paired host".'),
  why: z.string().trim().min(1).max(TO_DO_WHY_MAX).optional().describe('One plain line on why it is on their list.'),
  link: toDoLinkSchema.optional().describe('One web address to open, with the few words its button says, such as "Open #2127".'),
  steps: z.array(z.string().trim().min(1).max(TO_DO_STEP_MAX)).min(1).max(TO_DO_STEPS_MAX).optional().describe('The steps, in order, when there is more than one.'),
  waits: z.boolean().default(false).describe('True only when this thread cannot go on until the user has done it. Sotto then tells this thread when they check it off, or say it did not work. False for anything else, so a check-off starts no turn.'),
}).strict()
export type ToDoAddInput = z.input<typeof toDoAddSchema>

export const toDoSchema = z.object({
  id: z.string().min(1).max(64),
  title,
  why: z.string().min(1).max(TO_DO_WHY_MAX).optional(),
  link: toDoLinkSchema.optional(),
  steps: z.array(z.string().min(1).max(TO_DO_STEP_MAX)).max(TO_DO_STEPS_MAX).optional(),
  /** The thread that added it. Absent on the user's own, on Watcher's, and where this client is not sent that thread. */
  threadId: z.string().min(1).max(512).optional(),
  /** Who added it. A prototype waiting for review is Sotto's, made from its thread's mark and never saved (ADR-0188, decision 10). */
  by: z.enum(['thread', 'watcher', 'user', 'prototype']),
  waits: z.boolean(),
  /** Whether anyone has opened the list since it was added: one fact on this computer, whichever client opened it. */
  seen: z.boolean(),
  addedAt: z.string().min(1).max(40),
}).strict()
export type ToDo = z.infer<typeof toDoSchema>
export const toDoListSchema = z.array(toDoSchema).max(TO_DOS_MAX + 256)

/** A press on one computer's list. `didNotWork` carries the user's own words for the thread that waits on it. */
export const toDoRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), title }).strict(),
  z.object({ kind: z.literal('check'), id: z.string().min(1).max(64), didNotWork: z.string().trim().min(1).max(TO_DO_NOTE_MAX).optional() }).strict(),
  z.object({ kind: z.literal('seen') }).strict(),
])
export type ToDoRequest = z.infer<typeof toDoRequestSchema>
export const toDoReceiptSchema = z.object({ ok: z.literal(true) }).strict()

/** One computer's list as the window reads it, by the window's keys for its threads. */
export const machineToDosSchema = z.object({
  hostId: z.string().min(1).max(128),
  thisComputer: z.boolean(),
  items: toDoListSchema,
}).strict()
export type MachineToDos = z.infer<typeof machineToDosSchema>
/** The item as the window names it: its thread by the window's key. */
export const toDoForWindow = (hostId: string | undefined, item: ToDo): ToDo => item.threadId === undefined ? item : { ...item, threadId: hostEntityKey(hostId, item.threadId) }
export const toDosViewSchema = z.object({ machines: z.array(machineToDosSchema).max(256) }).strict()
export type ToDosView = z.infer<typeof toDosViewSchema>
export const toDoWindowRequestSchema = z.object({ hostId: z.string().min(1).max(128), request: toDoRequestSchema }).strict()
export type ToDoWindowRequest = z.infer<typeof toDoWindowRequestSchema>

/** The switch main hands the window, as the Owl list answers at start (ADR-0072). */
export const TO_DOS_RENDERER_ARGUMENT = '--sotto-to-dos'
export const TO_DOS_READ = 'sotto:to-dos:read'
export const TO_DOS_CHANGED = 'sotto:to-dos:changed'
export const TO_DOS_REQUEST = 'sotto:to-dos:request'

export interface ToDosBridge {
  read(): Promise<ToDosView>
  request(request: ToDoWindowRequest): Promise<void>
  onChanged(listener: (view: ToDosView) => void): () => void
}

/** The news a waiting thread takes when the user checks off its to-do (ADR-0188, decision 6). */
export const toDoNewsSchema = z.object({
  source: z.literal('to-do'),
  /** Oldest first, one for each to-do it checked off while the thread had not heard yet. */
  items: z.array(z.object({
    title,
    /** The user's own words, when they said it did not work. */
    didNotWork: z.string().min(1).max(TO_DO_NOTE_MAX).optional(),
  }).strict()).min(1).max(TO_DOS_MAX),
}).strict()
export type ToDoNews = z.infer<typeof toDoNewsSchema>
