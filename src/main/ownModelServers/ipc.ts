import { t } from '@lingui/core/macro'
import { z } from 'zod'
import {
  addResultSchema, checkResultSchema, OWN_SERVER_WORDS, OWN_SERVERS_ADD, OWN_SERVERS_CHECK, OWN_SERVERS_CHECK_SAVED, OWN_SERVERS_LIST,
  OWN_SERVERS_REMOVE, ownServerListSchema, removeResultSchema,
} from '../../shared/ownModelServers'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { OwnServers } from './service'

/** What the bridge reaches. */
export type OwnServersCalls = Pick<OwnServers, 'list' | 'check' | 'add' | 'checkSaved' | 'remove'>

const FAILED = { status: 'refused', reason: 'failed', message: OWN_SERVER_WORDS.failed } as const
/** A list that could not be read rejects, so the window says so and offers Try again rather than showing none saved. */
export const OWN_SERVERS_UNREAD = 'Sotto could not read your own model servers.'

/**
 * The main window's bridge to the user's own model servers (ADR-0124). The `own-model-servers` Owl answer decides whether
 * the handlers exist: with it off, or OpenCode held, nothing is registered and no renderer can turn it on. Every request
 * is checked by the service's schema, one that fails it or throws answers that nothing was changed rather than echoing
 * what was sent (a list that cannot be read rejects with fixed words instead), and every answer is checked against its schema on the way out, so no key ever crosses back.
 */
export function registerOwnServersIpc(ipc: IpcMainAdapter, calls: OwnServersCalls | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!calls) return () => undefined
  const handle = <T>(channel: string, schema: z.ZodType<T>, run: (request: unknown) => Promise<T>, failed: () => unknown): void => {
    ipc.handle(channel, async (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Manage your own model servers from the main Sotto window.`)
      let answer: unknown
      try { answer = await run(args[0]) } catch { answer = failed() }
      return schema.parse(answer)
    })
  }
  handle(OWN_SERVERS_LIST, ownServerListSchema, () => calls.list(), () => { throw new Error(t`Sotto could not read your own model servers.`) })
  handle(OWN_SERVERS_CHECK, checkResultSchema, request => calls.check(request), () => FAILED)
  handle(OWN_SERVERS_ADD, addResultSchema, request => calls.add(request), () => FAILED)
  handle(OWN_SERVERS_CHECK_SAVED, checkResultSchema, request => calls.checkSaved(request), () => FAILED)
  handle(OWN_SERVERS_REMOVE, removeResultSchema, request => calls.remove(request), () => FAILED)
  const channels = [OWN_SERVERS_LIST, OWN_SERVERS_CHECK, OWN_SERVERS_ADD, OWN_SERVERS_CHECK_SAVED, OWN_SERVERS_REMOVE]
  return () => { for (const channel of channels) ipc.removeHandler(channel) }
}
