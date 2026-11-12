import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { gitHubSignInSchema, PLUGINS_GITHUB_SIGN_IN, type GitHubSignIn } from '../../shared/plugins'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against a schema built once rather than on every call. */
const noArguments = z.tuple([])

/**
 * Settings › Plugins' channels (ADR-0205), answered for the main window only. Registered only while the `plugins` Owl
 * feature is on, so stable answers nothing. What goes back is checked on the way out and never carries a secret.
 */
export function registerPluginsIpc(ipc: IpcMainAdapter, plugins: { readonly gitHubSignIn: () => Promise<GitHubSignIn> }, senders: () => readonly TrustedIpcSender[]): () => void {
  ipc.handle(PLUGINS_GITHUB_SIGN_IN, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Settings in the main Sotto window.`)
    noArguments.parse(args)
    return gitHubSignInSchema.parse(await plugins.gitHubSignIn())
  })
  return () => { ipc.removeHandler(PLUGINS_GITHUB_SIGN_IN) }
}
