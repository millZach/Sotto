import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { hostEntityKey } from '../../shared/clientIdentity'
import { NEXT_PROMPT_READ, nextPromptEntriesSchema, type NextPromptEntry } from '../../shared/nextPrompt'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])

/** A next prompt as the window names its thread: by host and thread, as every thread the router joins is named. */
export function windowNextPrompt(hostId: string | undefined, entry: NextPromptEntry): NextPromptEntry {
  return { ...entry, threadId: hostEntityKey(hostId, entry.threadId) }
}

/**
 * The main window's read of the next prompts main holds (ADR-0132), for a window that has just loaded; changes reach it
 * on `NEXT_PROMPT_CHANGED`. Where the Owl feature is off main builds no next prompts, so nothing is registered.
 */
export function registerNextPromptIpc(ipc: IpcMainAdapter, nextPrompts: { list(): readonly NextPromptEntry[] } | undefined,
  hostId: () => string | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!nextPrompts) return () => undefined
  ipc.handle(NEXT_PROMPT_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Read next prompts from the main Sotto window.`)
    noArguments.parse(args)
    const id = hostId()
    return nextPromptEntriesSchema.parse(nextPrompts.list().map(entry => windowNextPrompt(id, entry)))
  })
  return () => { ipc.removeHandler(NEXT_PROMPT_READ) }
}
