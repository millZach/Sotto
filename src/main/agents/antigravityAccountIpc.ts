import { t } from '@lingui/core/macro'
import { ANTIGRAVITY_ACCOUNT_WORDS, ANTIGRAVITY_ENTERPRISE_SIGN_IN, ANTIGRAVITY_SIGN_OUT, antigravityAccountDoneSchema, type AntigravityAccountDone } from '../../shared/antigravityAccount'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

export interface AntigravityAccount {
  /** Answers why Antigravity did not connect once signed in, or undefined when it did. */
  signInWithBrowser(): Promise<string | undefined>
  signOut(): Promise<void>
}

/**
 * The main window's bridge to Antigravity's account actions (ADR-0211). Every answer is checked on the way out, and a
 * failure answers Sotto's own sentence, never `agy`'s words.
 */
export function registerAntigravityAccountIpc(ipc: IpcMainAdapter, account: AntigravityAccount | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!account) return () => undefined
  const handle = (channel: string, failed: string, run: () => Promise<AntigravityAccountDone>): void => {
    ipc.handle(channel, async event => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Sign Antigravity in from the main Sotto window.`)
      let answer: AntigravityAccountDone
      try { answer = await run() } catch { answer = { ok: false, message: failed } }
      return antigravityAccountDoneSchema.parse(answer)
    })
  }
  handle(ANTIGRAVITY_ENTERPRISE_SIGN_IN, ANTIGRAVITY_ACCOUNT_WORDS.enterpriseFailed, async () => {
    const failure = await account.signInWithBrowser()
    return failure ? { ok: false, message: failure.slice(0, 600) } : { ok: true }
  })
  handle(ANTIGRAVITY_SIGN_OUT, ANTIGRAVITY_ACCOUNT_WORDS.signOutFailed, async () => { await account.signOut(); return { ok: true } })
  return () => { ipc.removeHandler(ANTIGRAVITY_ENTERPRISE_SIGN_IN); ipc.removeHandler(ANTIGRAVITY_SIGN_OUT) }
}
