import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { SIGN_IN_INTERFACE_WORDS } from '../../shared/interfaceWords'
import {
  modelSourcesSchema, OPENCODE_SIGN_IN_BROWSER, OPENCODE_SIGN_IN_CANCEL, OPENCODE_SIGN_IN_EXTERNAL, OPENCODE_SIGN_IN_FINISH, OPENCODE_SIGN_IN_KEY,
  OPENCODE_SIGN_IN_REOPEN, OPENCODE_SIGN_IN_WAIT, OPENCODE_SIGN_OUT, OPENCODE_SOURCES_READ, signInDoneSchema, signInResultSchema,
  signInStartSchema, signInWaitSchema,
} from '../../shared/opencodeSignIn'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { OpenCodeSignIn } from './opencodeSignIn'

/** What the bridge reaches: this computer's OpenCode sign-in, or nothing while OpenCode is held off this run. */
export type OpenCodeSignInCalls = Pick<OpenCodeSignIn, 'sources' | 'signInWithKey' | 'startBrowserSignIn' | 'useExternalSignIn' | 'wait' | 'finish' | 'reopenPage' | 'cancel' | 'signOut'>

/** Written as it is answered, so it is in the interface language shown now (ADR-0123). */
const notRunning = () => ({ status: 'refused', message: SIGN_IN_INTERFACE_WORDS.notRunning() }) as const

/**
 * The main window's bridge to OpenCode's sign-in (#1104). OpenCode's Owl answer decides whether the handlers exist:
 * stable registers nothing, and no renderer can turn it on. Every request is checked by the service's schema, a request
 * that fails it answers that OpenCode is not running rather than echoing what was sent, and every answer is checked
 * against its schema on the way out, so nothing but a source's name, methods, sign-in and model count reaches the window.
 */
export function registerOpenCodeSignInIpc(ipc: IpcMainAdapter, calls: OpenCodeSignInCalls | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!calls) return () => undefined
  const handle = <T>(channel: string, schema: z.ZodType<T>, run: (request: unknown) => Promise<T>): void => {
    ipc.handle(channel, async (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Sign in to model sources from the main Sotto window.`)
      const request: unknown = args[0]
      let answer: unknown
      try { answer = await run(request) } catch { answer = notRunning() }
      return schema.parse(answer)
    })
  }
  handle(OPENCODE_SOURCES_READ, modelSourcesSchema, () => calls.sources())
  handle(OPENCODE_SIGN_IN_KEY, signInResultSchema, request => calls.signInWithKey(request))
  handle(OPENCODE_SIGN_IN_BROWSER, signInStartSchema, request => calls.startBrowserSignIn(request))
  handle(OPENCODE_SIGN_IN_EXTERNAL, signInResultSchema, request => calls.useExternalSignIn(request))
  handle(OPENCODE_SIGN_IN_WAIT, signInWaitSchema, request => calls.wait(request))
  handle(OPENCODE_SIGN_IN_FINISH, signInWaitSchema, request => calls.finish(request))
  handle(OPENCODE_SIGN_IN_REOPEN, signInDoneSchema, request => calls.reopenPage(request))
  handle(OPENCODE_SIGN_IN_CANCEL, signInDoneSchema, request => calls.cancel(request))
  handle(OPENCODE_SIGN_OUT, signInResultSchema, request => calls.signOut(request))
  const channels = [OPENCODE_SOURCES_READ, OPENCODE_SIGN_IN_KEY, OPENCODE_SIGN_IN_BROWSER, OPENCODE_SIGN_IN_EXTERNAL, OPENCODE_SIGN_IN_WAIT,
    OPENCODE_SIGN_IN_FINISH, OPENCODE_SIGN_IN_REOPEN, OPENCODE_SIGN_IN_CANCEL, OPENCODE_SIGN_OUT]
  return () => { for (const channel of channels) ipc.removeHandler(channel) }
}
