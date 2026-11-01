import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { hostEntityKey } from '../../shared/clientIdentity'
import { NEXT_PROMPT_READ, NEXT_PROMPT_WATCHER_FIRST, NEXT_PROMPT_WATCHER_FIRST_CANCEL, nextPromptEntriesSchema, nextPromptSchema, type NextPrompt, type NextPromptEntry } from '../../shared/nextPrompt'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])
const watcherFirstArguments = z.tuple([z.string().min(1).max(512)])
const watcherFirstAnswer = nextPromptSchema.nullable()

/** A next prompt as the window names its thread: by host and thread, as every thread the router joins is named. */
export function windowNextPrompt(hostId: string | undefined, entry: NextPromptEntry): NextPromptEntry {
  return { ...entry, threadId: hostEntityKey(hostId, entry.threadId) }
}

/**
 * The main window's read of the next prompts main holds (ADR-0132) and the ones its connected hosts pushed (ADR-0173), for
 * a window that has just loaded; changes reach it on `NEXT_PROMPT_CHANGED`. Where the Owl feature is off nothing is
 * registered. With this computer's own host off, only the hosts' are read.
 */
export function registerNextPromptIpc(ipc: IpcMainAdapter, enabled: boolean, nextPrompts: { list(): readonly NextPromptEntry[] } | undefined,
  hostId: () => string | undefined, senders: () => readonly TrustedIpcSender[], hosts?: { hostNextPrompts(): readonly NextPromptEntry[] },
  /**
   * Watcher's first message, on the model its first-start box picked (ADR-0173); absent, the box is offered none. `signal`
   * stops the side request when a newer ask, the box's cancel or unregistering supersedes it.
   */
  watcherFirst?: (modelId: string, signal: AbortSignal) => Promise<NextPrompt | null>): () => void {
  if (!enabled) return () => undefined
  // The one box asks one thing at a time: a newer ask, its cancel or quitting stops the side request in flight.
  let asking: AbortController | undefined
  const stopAsking = (): void => { asking?.abort(); asking = undefined }
  ipc.handle(NEXT_PROMPT_WATCHER_FIRST, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Ask for Watcher's first message from the main Sotto window.`)
    const [modelId] = watcherFirstArguments.parse(args)
    stopAsking()
    const ask = asking = new AbortController()
    try {
      const answer = await watcherFirst?.(modelId, ask.signal).catch(() => null) ?? null
      // A superseded ask's late answer is not offered.
      return watcherFirstAnswer.parse(ask.signal.aborted ? null : answer)
    } finally { if (asking === ask) asking = undefined }
  })
  ipc.handle(NEXT_PROMPT_WATCHER_FIRST_CANCEL, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Ask for Watcher's first message from the main Sotto window.`)
    noArguments.parse(args)
    stopAsking()
  })
  ipc.handle(NEXT_PROMPT_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Read next prompts from the main Sotto window.`)
    noArguments.parse(args)
    const id = hostId()
    return nextPromptEntriesSchema.parse([...(nextPrompts?.list() ?? []).map(entry => windowNextPrompt(id, entry)), ...hosts?.hostNextPrompts() ?? []].slice(0, 1_000))
  })
  return () => { stopAsking(); ipc.removeHandler(NEXT_PROMPT_READ); ipc.removeHandler(NEXT_PROMPT_WATCHER_FIRST); ipc.removeHandler(NEXT_PROMPT_WATCHER_FIRST_CANCEL) }
}
