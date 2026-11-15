import { z } from 'zod'
import { gitPullRequestUrlSchema } from './gitPullRequests'

/** The one name every client addresses a thread's way to Watcher by (ADR-0073, amendment of November 2, 2026). */
export const TELL_WATCHER_MCP_SERVER = 'sotto_watcher'
export const TELL_WATCHER_TOOL = 'tell_watcher'
/** A worker's READY TO MERGE as a fact Sotto carries rather than words in a reply (#2229). */
export const READY_TO_MERGE_TOOL = 'ready_to_merge'
/** How many READY TO MERGE one thread may send in `TELL_WATCHER_LIMIT_WINDOW_MS`: one per push of a busy branch, and never a flood. */
export const READY_TO_MERGE_LIMIT = 6
/** How much of the worker's words, and of the user's own message, one piece of news carries, in UTF-8 bytes. */
export const TELL_WATCHER_WORDS_BYTES_MAX = 2_048
/** How many messages one thread may send Watcher in `TELL_WATCHER_LIMIT_WINDOW_MS`, so one thread cannot keep waking it. */
export const TELL_WATCHER_LIMIT = 3
export const TELL_WATCHER_LIMIT_WINDOW_MS = 10 * 60_000
/** How long a host waits for the desktop that runs Watcher to say it took a thread's message. */
export const TELL_WATCHER_ANSWER_MS = 15_000

/** The text cut to at most this many UTF-8 bytes, never inside a character. */
export function cutToBytes(text: string, bytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= bytes) return text
  // A character cut in half decodes to the replacement character, which comes off.
  return new TextDecoder().decode(encoded.subarray(0, bytes)).replace(/\ufffd+$/u, '')
}

const words = z.string().min(1).max(TELL_WATCHER_WORDS_BYTES_MAX)
/**
 * The user's own newest message in the thread, read from Sotto's record, never from the worker: `named` says the whole
 * message names Watcher, which is what lets Sotto open a request for it, and `cut` that `words` is not all of it.
 */
export const toldUserMessageSchema = z.object({ id: z.string().min(1).max(512), words, named: z.boolean(), cut: z.boolean() }).strict()
export type ToldUserMessage = z.infer<typeof toldUserMessageSchema>
/** A thread's message for Watcher: the worker's words, and the user's own message when Sotto found one. */
export const tellWatcherAskSchema = z.object({ threadId: z.string().min(1).max(512), words, userMessage: toldUserMessageSchema.optional() }).strict()
export type TellWatcherAsk = z.infer<typeof tellWatcherAskSchema>
/** A full commit ID, as GitHub names a pull request's head. */
export const commitIdSchema = z.string().regex(/^[0-9a-f]{40}$/u, 'Use the full 40-character commit ID.')
/** What a worker's READY TO MERGE says (#2229): which pull request, at which head. No words of the worker's go with it. */
export const readyToMergeSchema = z.object({ pullRequest: gitPullRequestUrlSchema, head: commitIdSchema }).strict()
export type ReadyToMerge = z.infer<typeof readyToMergeSchema>
/** A thread's READY TO MERGE for Watcher, as a host pushes it to a desktop whose hello accepted `watcher-ready`. */
export const readyToMergeAskSchema = z.object({ threadId: z.string().min(1).max(512), ready: readyToMergeSchema }).strict()
export type ReadyToMergeAsk = z.infer<typeof readyToMergeAskSchema>
/** Either kind of ask a host pushes as `watcher-tell-ask`: a READY TO MERGE goes only to a desktop that accepted `watcher-ready`. */
export const watcherTellPushSchema = z.union([tellWatcherAskSchema, readyToMergeAskSchema])
export type WatcherTellPush = z.infer<typeof watcherTellPushSchema>
export const isReadyToMergeAsk = (ask: WatcherTellPush): ask is ReadyToMergeAsk => 'ready' in ask
/** Whether Watcher will hear of it, and whether Sotto opened a request for it. */
export const tellWatcherAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('told'), requestOpened: z.boolean() }).strict(),
  // `no-answer`: the desktop was asked and did not answer, so it may have taken it, and nothing is sent again.
  z.object({ status: z.literal('refused'), reason: z.enum(['no-watcher', 'not-connected', 'no-answer']) }).strict(),
])
export type TellWatcherAnswer = z.infer<typeof tellWatcherAnswerSchema>

/** Words as news carries them: without control characters, which JSON would write at six times their size. Tabs and new lines stay. */
export const plainWords = (text: string): string => [...text].filter(character => {
  const code = character.codePointAt(0)!
  return code === 9 || code === 10 || code === 13 || code >= 32 && code !== 127
}).join('')
/** Whether a message of the user's names Watcher, whichever way it was typed or dictated. */
export const namesWatcher = (text: string): boolean => /\bwatcher\b/iu.test(text)
/** The user's message as one piece of news carries it. */
export function toldUserMessage(id: string, text: string): ToldUserMessage | undefined {
  const trimmed = plainWords(text).trim()
  if (!trimmed) return undefined
  const cut = cutToBytes(trimmed, TELL_WATCHER_WORDS_BYTES_MAX)
  return { id, words: cut, named: namesWatcher(trimmed), cut: cut !== trimmed }
}

/**
 * A request a thread's message opened is rooted in the user's message in that thread, by this prefix, so it is told apart
 * from one a message to Watcher started and so one message opens at most one.
 */
const TOLD_ROOT = 'told:'
/**
 * A request the user's answer on Watcher's own question card opened (#2482) is rooted in that question and the user's
 * request Watcher asked it under, by this prefix, so one answer opens at most one and the request it continues is known
 * after the question is gone. It is told news's kind of request: for starting threads and sending in the one turn the
 * answer's news starts.
 */
const ANSWERED_ROOT = 'answered:'
export const toldRequestRoot = (hostId: string, threadId: string, messageId: string): string => `${TOLD_ROOT}${hostId}:${threadId}:${messageId}`
export const answeredRequestRoot = (questionId: string, askedUnder: string): string => `${ANSWERED_ROOT}${questionId}:${askedUnder}`
/** The question whose answer opened a request, and the user's request it was asked under. Undefined for any other root. */
export function answeredRequestOf(root: string): { readonly questionId: string; readonly askedUnder: string } | undefined {
  if (!root.startsWith(ANSWERED_ROOT)) return undefined
  const [questionId, askedUnder] = root.slice(ANSWERED_ROOT.length).split(':')
  return questionId && askedUnder ? { questionId, askedUnder } : undefined
}
/** Whether news opened this request, a thread's message or the user's answer on a card, rather than a message to Watcher. */
export const isToldRequest = (request: { readonly rootUserMessageId: string }): boolean => request.rootUserMessageId.startsWith(TOLD_ROOT) || request.rootUserMessageId.startsWith(ANSWERED_ROOT)
/** The user's message a told request is rooted in, and its thread. Undefined for any other request's root. */
export function toldRequestMessage(root: string): { readonly threadId: string; readonly messageId: string } | undefined {
  if (!root.startsWith(TOLD_ROOT)) return undefined
  const [, threadId, ...message] = root.slice(TOLD_ROOT.length).split(':')
  return threadId && message.length ? { threadId, messageId: message.join(':') } : undefined
}
