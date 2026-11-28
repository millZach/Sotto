import { z } from 'zod'
import { parseHostEntityKey } from '../../shared/clientIdentity'
import { SECRET_REQUESTS_ANSWER, secretRequestAnswerSchema, type SecretRequestAnswerResult } from '../../shared/secretRequests'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { SecretRequests } from './secretRequests'

/** Argument tuple built once at module scope (`zodSchemaSites.test.ts`). */
const answerArguments = z.tuple([secretRequestAnswerSchema])

/**
 * The card's own channel (ADR-0219): the values the user typed go from the main window straight to the service that
 * waits for them, and come back as nothing but whether it worked. Nothing here logs, echoes or keeps a value, and a
 * refusal never says what was typed. Registered only while the `secret-requests` Owl feature is on.
 */
export function registerSecretRequestsIpc(ipc: IpcMainAdapter, service: SecretRequests | undefined, senders: () => readonly TrustedIpcSender[], hostId: () => string | undefined): () => void {
  if (!service) return () => undefined
  ipc.handle(SECRET_REQUESTS_ANSWER, async (event, ...args): Promise<SecretRequestAnswerResult> => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) return { ok: false, message: 'Answer the card in the main Sotto window.' }
    const parsed = answerArguments.safeParse(args)
    if (!parsed.success) return { ok: false, message: 'The card could not be read. Nothing was saved; try again.' }
    const [answer] = parsed.data
    // The window names threads by host and thread; a card is only ever this computer's.
    const key = parseHostEntityKey(answer.threadId)
    const local = hostId()
    if (key !== null && key.hostId !== local) return { ok: false, message: 'Answer this card on the computer the thread runs on.' }
    const threadId = key?.id ?? answer.threadId
    try {
      if (answer.answer === 'decline') service.decline(threadId, answer.requestId)
      else await service.save(threadId, answer.requestId, answer.values)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error && error.message ? error.message.slice(0, 500) : 'Nothing was saved. Try again.' }
    }
  })
  return () => { ipc.removeHandler(SECRET_REQUESTS_ANSWER) }
}
