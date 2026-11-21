import { t } from '@lingui/core/macro'
import { ANTIGRAVITY_ACCOUNT_WORDS, ANTIGRAVITY_CANCEL_INSTALL, ANTIGRAVITY_ENTERPRISE_SIGN_IN, ANTIGRAVITY_INSTALL, ANTIGRAVITY_INSTALL_PROGRESS, ANTIGRAVITY_REMOVE_DOWNLOADED, ANTIGRAVITY_SIGN_OUT,
  antigravityAccountDoneSchema, antigravityInstallProgressSchema, type AntigravityAccountDone } from '../../shared/antigravityAccount'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

export interface AntigravityAccount {
  /** Answers why Antigravity did not connect once signed in, or undefined when it did. */
  signInWithBrowser(): Promise<string | undefined>
  signOut(): Promise<void>
  /** Answers why Antigravity is not installed and connected afterwards, or undefined when it is. */
  install(): Promise<string | undefined>
  installProgress(): string | undefined
  cancelInstall(): boolean
  removeDownloaded(): Promise<string>
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
  handle(ANTIGRAVITY_INSTALL, ANTIGRAVITY_ACCOUNT_WORDS.installFailed, async () => { const failure = await account.install(); return failure ? { ok: false, message: failure.slice(0, 600) } : { ok: true } })
  handle(ANTIGRAVITY_CANCEL_INSTALL, ANTIGRAVITY_ACCOUNT_WORDS.notRunning, async () => ({ ok: account.cancelInstall() }))
  handle(ANTIGRAVITY_REMOVE_DOWNLOADED, ANTIGRAVITY_ACCOUNT_WORDS.removeFailed, async () => ({ ok: true, message: (await account.removeDownloaded()).slice(0, 600) }))
  ipc.handle(ANTIGRAVITY_INSTALL_PROGRESS, async event => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Install Antigravity from the main Sotto window.`)
    const text = account.installProgress()
    return antigravityInstallProgressSchema.parse(text ? { installing: true, text: text.slice(0, 600) } : { installing: false })
  })
  const channels = [ANTIGRAVITY_ENTERPRISE_SIGN_IN, ANTIGRAVITY_SIGN_OUT, ANTIGRAVITY_INSTALL, ANTIGRAVITY_CANCEL_INSTALL, ANTIGRAVITY_REMOVE_DOWNLOADED, ANTIGRAVITY_INSTALL_PROGRESS]
  return () => { for (const channel of channels) ipc.removeHandler(channel) }
}
