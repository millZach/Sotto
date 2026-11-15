import { t } from '@lingui/core/macro'
import { PI_SIGN_IN, piSignInCallSchema } from '../../shared/piSignIn'
import { modelSourcesSchema, signInDoneSchema, signInResultSchema, signInStartSchema, signInWaitSchema } from '../../shared/opencodeSignIn'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import { PI_SIGN_IN_WORDS, type PiSignIn } from './piSignIn'

function words(message: string): string {
  switch (message) {
    case PI_SIGN_IN_WORDS.failed: return t`Pi could not finish signing in. Check the account and try again. Your threads are kept.`
    case PI_SIGN_IN_WORDS.unavailable: return t`Pi is not available for sign-in. Install Pi and try again. Your threads are kept.`
    case PI_SIGN_IN_WORDS.busy: return t`Another Pi sign-in is still open. Finish or cancel it first.`
    case PI_SIGN_IN_WORDS.expired: return t`The Pi sign-in expired. Open the sign-in page again to start over.`
    case PI_SIGN_IN_WORDS.page: return t`The Pi sign-in page could not be opened. Try Open the page again.`
    case PI_SIGN_IN_WORDS.gone: return t`This Pi sign-in is no longer waiting. Open the sign-in page again to start over.`
    case PI_SIGN_IN_WORDS.signOut: return t`Pi could not confirm sign-out. Check its model sources before trying again.`
    default: return message
  }
}
export function registerPiSignInIpc(ipc: IpcMainAdapter, calls: PiSignIn | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!calls) return () => undefined
  ipc.handle(PI_SIGN_IN, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Sign in to model sources from the main Sotto window.`)
    const parsed = piSignInCallSchema.safeParse(args[0])
    if (!parsed.success) return { status: 'refused', message: words(PI_SIGN_IN_WORDS.failed) }
    const request = parsed.data
    try {
      let result
      switch (request.action) {
        case 'sources': result = modelSourcesSchema.parse(await calls.sources()); break
        case 'key': result = signInResultSchema.parse(await calls.signInWithKey(request.request)); break
        case 'browser': result = signInStartSchema.parse(await calls.startBrowserSignIn(request.request)); break
        case 'wait': result = signInWaitSchema.parse(await calls.wait(request.request)); break
        case 'finish': result = signInWaitSchema.parse(await calls.finish(request.request)); break
        case 'reopen': result = signInDoneSchema.parse(await calls.reopenPage(request.request)); break
        case 'cancel': result = signInDoneSchema.parse(await calls.cancel(request.request)); break
        case 'sign-out': result = signInResultSchema.parse(await calls.signOut(request.request)); break
      }
      return 'message' in result ? { ...result, message: words(result.message) } : result
    } catch { return { status: 'refused', message: words(PI_SIGN_IN_WORDS.failed) } }
  })
  return () => ipc.removeHandler(PI_SIGN_IN)
}
