import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { ProviderSignInRefusal } from '../../host/providerSignIn'
import { providerSignInResultSchema } from '../../shared/hostProviders'
import { LOCAL_PROVIDER_SIGN_IN, localSignInRequestSchema } from '../../shared/localProviderSignIn'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { LocalProviderSignIn } from './localProviderSignIn'

const signInArguments = z.tuple([localSignInRequestSchema])

/**
 * The main window's bridge to this computer's provider sign-ins (ADR-0200). Every request is checked, and every answer
 * is checked on the way out, so the page's address never reaches the window. A refusal's sentence is the dialog's to
 * show; anything else that goes wrong says only that the sign-in is not available, rather than echoing what was sent.
 */
export function registerLocalProviderSignInIpc(ipc: IpcMainAdapter, signIn: LocalProviderSignIn | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!signIn) return () => undefined
  ipc.handle(LOCAL_PROVIDER_SIGN_IN, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Sign a provider in from the main Sotto window.`)
    const parsed = signInArguments.safeParse(args)
    if (!parsed.success) throw new Error(t`That sign-in is not available right now. Nothing was changed.`)
    try { return providerSignInResultSchema.parse(await signIn.request(parsed.data[0])) }
    catch (error) {
      // A refusal's sentence is written to be shown; nothing else is.
      if (error instanceof ProviderSignInRefusal) throw new Error(error.message, { cause: error })
      throw new Error(t`That sign-in is not available right now. Nothing was changed.`, { cause: error })
    }
  })
  return () => { ipc.removeHandler(LOCAL_PROVIDER_SIGN_IN); signIn.close() }
}
