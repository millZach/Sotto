import type { z } from 'zod'
import { CURSOR_SIGN_IN_CANCEL, CURSOR_SIGN_IN_READ, CURSOR_SIGN_IN_REOPEN, CURSOR_SIGN_IN_START, CURSOR_SIGN_IN_WORDS, CURSOR_SIGN_OUT, cursorSignInDoneSchema,
  cursorSignInRequestSchema, cursorSignInStartSchema, cursorSignInViewSchema } from '../../shared/cursorSignIn'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { CursorSignIn } from './cursorSignIn'

/**
 * The main window's bridge to Cursor's sign-in (ADR-0125). Cursor's Owl answer decides whether the handlers exist:
 * stable registers nothing. Every request is checked, a request that fails its schema answers that the sign-in is not
 * available rather than echoing what was sent, and every answer is checked on the way out, so the page's address never
 * reaches the window.
 */
export function registerCursorSignInIpc(ipc: IpcMainAdapter, signIn: CursorSignIn | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!signIn) return () => undefined
  const handle = <T>(channel: string, schema: z.ZodType<T>, refused: unknown, run: (request: unknown) => Promise<unknown>): void => {
    ipc.handle(channel, async (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Sign Cursor in from the main Sotto window.')
      let answer: unknown
      try { answer = await run(args[0]) } catch { answer = refused }
      return schema.parse(answer)
    })
  }
  const notRunning = { ok: false, message: CURSOR_SIGN_IN_WORDS.notRunning }
  handle(CURSOR_SIGN_IN_START, cursorSignInStartSchema, { message: CURSOR_SIGN_IN_WORDS.notRunning }, () => signIn.start())
  handle(CURSOR_SIGN_IN_READ, cursorSignInViewSchema.nullable(), null, request => signIn.read(cursorSignInRequestSchema.parse(request).id))
  handle(CURSOR_SIGN_IN_REOPEN, cursorSignInDoneSchema, notRunning, request => signIn.reopen(cursorSignInRequestSchema.parse(request).id))
  handle(CURSOR_SIGN_IN_CANCEL, cursorSignInDoneSchema, notRunning, request => signIn.cancel(cursorSignInRequestSchema.parse(request).id))
  handle(CURSOR_SIGN_OUT, cursorSignInDoneSchema, notRunning, () => signIn.signOut())
  const channels = [CURSOR_SIGN_IN_START, CURSOR_SIGN_IN_READ, CURSOR_SIGN_IN_REOPEN, CURSOR_SIGN_IN_CANCEL, CURSOR_SIGN_OUT]
  return () => { for (const channel of channels) ipc.removeHandler(channel); signIn.close() }
}
