import { z } from 'zod'

/**
 * Signing Sotto's OpenCode in to a model source (#1104, ADR-0087): the OpenCode tile's Model sources block and its Add a
 * model source dialog. Everything runs in main on a short-lived OpenCode server with Sotto's own OpenCode folder. A key
 * goes from the dialog to main once and from main to that server once; nothing here carries one back. The renderer learns
 * each source's name, its ways to sign in, how it is signed in and its model count, never a credential.
 */

/** Passed to the main window's preload only while OpenCode's Owl feature is on; without it there is no bridge. */
export const OPENCODE_RENDERER_ARGUMENT = '--sotto-opencode-enabled'
/**
 * Passed to the main window's preload while OpenCode's Owl feature is on, whether or not this computer runs its local host:
 * a host's OpenCode is signed in from Settings > Hosts through its own bridge (#1107).
 */
export const OPENCODE_HOSTS_RENDERER_ARGUMENT = '--sotto-opencode-hosts'
export const OPENCODE_SOURCES_READ = 'sotto:opencode:sources'
export const OPENCODE_SIGN_IN_KEY = 'sotto:opencode:sign-in-key'
export const OPENCODE_SIGN_IN_BROWSER = 'sotto:opencode:sign-in-browser'
export const OPENCODE_SIGN_IN_EXTERNAL = 'sotto:opencode:sign-in-external'
export const OPENCODE_SIGN_IN_WAIT = 'sotto:opencode:sign-in-wait'
export const OPENCODE_SIGN_IN_FINISH = 'sotto:opencode:sign-in-finish'
export const OPENCODE_SIGN_IN_REOPEN = 'sotto:opencode:sign-in-reopen'
export const OPENCODE_SIGN_IN_CANCEL = 'sotto:opencode:sign-in-cancel'
export const OPENCODE_SIGN_OUT = 'sotto:opencode:sign-out'

/** The common model sources, shown first in the dialog, in this order (Zach's pick, October 16, 2026). */
export const COMMON_MODEL_SOURCES = ['anthropic', 'openai', 'openrouter', 'github-copilot', 'google', 'xai'] as const
/** The sentence under every key field. */
export const KEY_SENTENCE = 'Sotto’s OpenCode keeps the key in its own folder, and Sotto keeps no copy.'
/** The same for a host's OpenCode (#1107): the key crosses the host connection once and is kept only there. */
export const hostKeySentence = (host: string): string =>
  `The key goes to Sotto’s OpenCode on ${host} once, which keeps it in its own folder there. Sotto keeps no copy on either computer.`
/** The longest key Sotto passes on. Real keys are well under this; a longer paste is something else. */
export const OPENCODE_KEY_MAX = 4_096

const sourceId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u)
const name = z.string().min(1).max(200)
const words = z.string().min(1).max(600)
const methodId = z.string().min(1).max(128)

/** One question a way to sign in asks first, in the part of OpenCode's form fields Sotto draws: words, or one choice. */
export const modelSourceFieldSchema = z.object({
  key: z.string().min(1).max(64), title: name, description: z.string().max(400).optional(), required: z.boolean(),
  placeholder: z.string().max(200).optional(), default: z.string().max(400).optional(), pattern: z.string().max(200).optional(),
  options: z.array(z.object({ value: z.string().min(1).max(200), label: name, description: z.string().max(200).optional() }).strict()).max(32).optional(),
  /** Shown only while another field holds this value, such as GitHub Enterprise's address. */
  when: z.object({ key: z.string().min(1).max(64), value: z.string().max(200) }).strict().optional(),
}).strict()
export type ModelSourceField = z.infer<typeof modelSourceFieldSchema>
/**
 * A way to sign in, in Sotto's words. `key` is a pasted key; `browser` is OpenCode's sign-in page, which tells when it
 * starts whether it shows a code, asks for one, or finishes by itself; `external` uses a sign-in already on this
 * computer (an AWS profile, gcloud). Methods OpenCode calls legacy, and its environment variables, are left out.
 */
export const modelSourceMethodSchema = z.object({
  id: methodId, kind: z.enum(['key', 'browser', 'external']), label: name,
  form: z.array(modelSourceFieldSchema).max(8).optional(),
}).strict()
export type ModelSourceMethod = z.infer<typeof modelSourceMethodSchema>
export const modelSourceSchema = z.object({
  id: sourceId, name, methods: z.array(modelSourceMethodSchema).max(8),
  /** How Sotto's OpenCode is signed in to it, such as "API key" or "ChatGPT account"; absent when it is not. */
  signedIn: z.object({ how: name }).strict().optional(),
  models: z.number().int().min(0).max(100_000),
}).strict()
export type ModelSource = z.infer<typeof modelSourceSchema>
export const modelSourcesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), zenModels: z.number().int().min(0).max(100_000), sources: z.array(modelSourceSchema).max(1_000) }).strict(),
  z.object({ status: z.literal('refused'), message: words }).strict(),
])
export type ModelSources = z.infer<typeof modelSourcesSchema>

const answerSchema = z.record(z.string().min(1).max(64), z.string().max(400)).refine(value => Object.keys(value).length <= 8)
export const signInKeyRequestSchema = z.object({ sourceId, key: z.string().min(1).max(OPENCODE_KEY_MAX), answer: answerSchema.optional() }).strict()
export type SignInKeyRequest = z.infer<typeof signInKeyRequestSchema>
export const signInMethodRequestSchema = z.object({ sourceId, methodId, answer: answerSchema.optional() }).strict()
export type SignInMethodRequest = z.infer<typeof signInMethodRequestSchema>
const attemptId = z.string().min(1).max(200)
export const signInAttemptRequestSchema = z.object({ attemptId }).strict()
export const signInFinishRequestSchema = z.object({ attemptId, code: z.string().min(1).max(2_048) }).strict()
export const signOutRequestSchema = z.object({ sourceId }).strict()

/**
 * A browser sign-in that is waiting. `mode` is OpenCode's: `code` waits for the code the page shows, `auto` finishes by
 * itself, with `code` set when the page asks for the one shown here. `page` is the address without its query, for
 * reading; main keeps the address it opens.
 */
export const signInAttemptSchema = z.object({
  id: attemptId, sourceId, mode: z.enum(['auto', 'code']), code: z.string().min(1).max(64).optional(),
  page: z.string().min(1).max(300), expiresAt: z.number().int().nonnegative().optional(),
}).strict()
export type SignInAttempt = z.infer<typeof signInAttemptSchema>
/**
 * Why a refusal was made, where the window acts on it and not only shows its words: `code-refused` is a pasted code the
 * source did not accept, and the dialog asks for another; `finishes-on-host` is a browser sign-in that sends the browser back
 * to OpenCode on the host's own machine, which the dialog then stops offering (#1107); `answer-lost` is a host that did not
 * answer, which may have signed in or out all the same, so the window reads its model sources again and shows them. A refusal
 * without one is told in its words alone, and a reason this build does not know reads as none.
 */
export const signInRefusalReasonSchema = z.enum(['code-refused', 'finishes-on-host', 'answer-lost'])
export type SignInRefusalReason = z.infer<typeof signInRefusalReasonSchema>
const refused = z.object({ status: z.literal('refused'), message: words, reason: signInRefusalReasonSchema.optional().catch(undefined) }).strict()
/** The sign-ins changed. `warning` says what did not follow them, such as a model list that could not be read again. */
const changed = z.object({ status: z.literal('ok'), sources: modelSourcesSchema, warning: words.optional() }).strict()
export const signInResultSchema = z.discriminatedUnion('status', [changed, refused])
export type SignInResult = z.infer<typeof signInResultSchema>
export const signInStartSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('waiting'), attempt: signInAttemptSchema }).strict(), refused])
export type SignInStart = z.infer<typeof signInStartSchema>
/** Where a waiting sign-in stands: still waiting, done, or over without saving anything. */
export const signInWaitSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  changed,
  z.object({ status: z.literal('expired'), message: words }).strict(),
  refused,
])
export type SignInWait = z.infer<typeof signInWaitSchema>
/**
 * Done, refused, or, for opening a page, a browser that did not open: then `address` is the page OpenCode gave, to open
 * by hand. It is the sign-in page's own address, which carries no key or code.
 */
export const signInDoneSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('ok') }).strict(), refused,
  z.object({ status: z.literal('not-opened'), message: words, address: z.string().max(4_096).regex(/^https:\/\//u) }).strict()])
export type SignInDone = z.infer<typeof signInDoneSchema>

/**
 * A host's OpenCode signed in from this computer (#1107, ADR-0037): one `opencode-sign-in` request per call, each the same
 * call the desktop's own dialog makes of main, answered by the host's own sign-in on its own Sotto OpenCode folder. `page`
 * stands in for opening the page: the host has no browser, so it answers with the page's address, which this computer's
 * main checks and opens, and never hands the window. A key crosses the connection once, in `key`, and goes no further than
 * the host's OpenCode.
 */
/**
 * The calls the window's request to main (`hostOpenCodeCallSchema`) and main's request to the host share, one schema each, so
 * the two cannot drift apart. Each boundary adds its own way to open a waiting sign-in's page: the window has main `reopen`
 * it, and main asks the host for its address with `page`.
 */
export const OPENCODE_SIGN_IN_CALLS = [
  z.object({ action: z.literal('sources') }).strict(),
  z.object({ action: z.literal('key'), request: signInKeyRequestSchema }).strict(),
  z.object({ action: z.literal('browser'), request: signInMethodRequestSchema }).strict(),
  z.object({ action: z.literal('external'), request: signInMethodRequestSchema }).strict(),
  z.object({ action: z.literal('wait'), request: signInAttemptRequestSchema }).strict(),
  z.object({ action: z.literal('finish'), request: signInFinishRequestSchema }).strict(),
  z.object({ action: z.literal('cancel'), request: signInAttemptRequestSchema }).strict(),
  z.object({ action: z.literal('sign-out'), request: signOutRequestSchema }).strict(),
] as const
export const opencodeHostCallSchema = z.discriminatedUnion('action', [...OPENCODE_SIGN_IN_CALLS,
  z.object({ action: z.literal('page'), request: signInAttemptRequestSchema }).strict()])
export type OpenCodeHostCall = z.infer<typeof opencodeHostCallSchema>
/** A waiting sign-in's page as a host answers `page`: its https address, for this computer's main to open, or a refusal. */
export const signInPageSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), address: z.string().max(4_096).regex(/^https:\/\//u) }).strict(), refused])
export type SignInPage = z.infer<typeof signInPageSchema>
/** What each shared call is answered with, by action, at both boundaries. */
export const OPENCODE_SIGN_IN_ANSWERS = {
  sources: modelSourcesSchema, key: signInResultSchema, browser: signInStartSchema, external: signInResultSchema, wait: signInWaitSchema,
  finish: signInWaitSchema, cancel: signInDoneSchema, 'sign-out': signInResultSchema,
} as const satisfies Record<z.infer<(typeof OPENCODE_SIGN_IN_CALLS)[number]>['action'], z.ZodType>
/** What a host answers each call with, by action: the shared answers, and the page's address for `page`. */
export const OPENCODE_HOST_ANSWERS = { ...OPENCODE_SIGN_IN_ANSWERS, page: signInPageSchema } as const satisfies Record<OpenCodeHostCall['action'], z.ZodType>
export type OpenCodeHostAnswer<A extends OpenCodeHostCall['action']> = z.infer<(typeof OPENCODE_HOST_ANSWERS)[A]>

export interface OpenCodeSignInBridge {
  sources(): Promise<ModelSources>
  signInWithKey(request: SignInKeyRequest): Promise<SignInResult>
  startBrowserSignIn(request: SignInMethodRequest): Promise<SignInStart>
  useExternalSignIn(request: SignInMethodRequest): Promise<SignInResult>
  wait(request: { attemptId: string }): Promise<SignInWait>
  finish(request: { attemptId: string; code: string }): Promise<SignInWait>
  reopen(request: { attemptId: string }): Promise<SignInDone>
  cancel(request: { attemptId: string }): Promise<SignInDone>
  signOut(request: { sourceId: string }): Promise<SignInResult>
}

/** The words each outcome is told in, shared by main and the tile. */
export const SIGN_IN_WORDS = {
  notRunning: 'Sotto’s OpenCode is not running, so nothing was signed in. Connect OpenCode, then try again.',
  keyRefused: (source: string) => `OpenCode could not sign in to ${source} with that key, so nothing was saved. Check the key in your ${source} account and paste it again.`,
  expired: (source: string) => `The ${source} sign-in page expired before you finished, so nothing was saved. Open the sign-in page again to start over.`,
  failed: (source: string) => `The ${source} sign-in did not finish, so nothing was saved. Open the sign-in page again to start over.`,
  startFailed: (source: string) => `OpenCode could not start the ${source} sign-in, so nothing was saved. Try again in a moment, or choose another way to sign in.`,
  codeRefused: (source: string) => `${source} did not accept that code, so nothing was saved. Copy the code from the ${source} page and paste it again.`,
  formRefused: (source: string) => `OpenCode needs every question answered before it signs in to ${source}. Nothing was saved. Fill them in and try again.`,
  unsafePage: 'OpenCode gave a sign-in page that is not a secure https address, so Sotto did not open it and nothing was saved.',
  pageNotOpened: 'Your browser did not open the sign-in page. Nothing was saved. Open this address in your browser yourself, or press Open the page again.',
  /** A key's acknowledgement was lost and the list read again says it was not saved. */
  keyNotSaved: (source: string) => `Sotto could not tell whether OpenCode saved the ${source} key, so it read OpenCode’s sign-ins again: ${source} is not signed in, so nothing was saved. Paste the key again.`,
  /** A key's acknowledgement was lost and the list could not be read again either. */
  keyUnknown: (source: string) => `Sotto could not tell whether OpenCode saved the ${source} key, and could not read OpenCode’s sign-ins to find out. Close this and look under Model sources: ${source} is listed there if it was saved. If it is not, paste the key again.`,
  /** The sign-ins changed and every thread moves to them, but the model list could not be read again. */
  catalogUnread: 'Sotto could not read OpenCode’s model list again, so the model menu may be out of date. Each thread still moves to the new sign-ins when it next goes idle. Press Refresh OpenCode to read the list again.',
  signOutFailed: (source: string) => `Sotto could not sign out of ${source}, so it is still signed in. Try again.`,
  unknownSource: 'OpenCode no longer lists that model source, so nothing was signed in. Close this and open it again.',
  signedIn: (source: string, models: number) => `Signed in to ${source}. ${models === 0 ? 'OpenCode lists none of its models yet, so none are in the model menu.'
    : `${models === 1 ? 'Its model is' : `Its ${models} models are`} in the model menu, under OpenCode.`}`,
  /** OpenCode keeps a key without trying it (checked against 2.0.31), so a wrong one shows only when a thread uses it. */
  keyUnchecked: (source: string) => `OpenCode tries the key the first time a thread uses one of its models. If ${source} refuses it then, sign out here and paste the key again.`,
  signedOut: (source: string, key: boolean) => `Signed out of ${source}. Its ${key ? 'key' : 'sign-in'} is gone from Sotto’s OpenCode.`,
} as const

/**
 * A host whose answer to a sign-in call was lost (#1107): it may have saved the key, finished the sign-in or signed out all
 * the same, so this computer never says nothing changed. Where the call names a source, main reads the host's model sources
 * again and says what they show; otherwise the window reads them again and shows them.
 */
export const HOST_ANSWER_LOST = {
  /** The list read again shows the change took. */
  took: (host: string, source: string, signedIn: boolean): string =>
    `${host} did not answer at first, so Sotto read its model sources again: ${source} is signed ${signedIn ? 'in' : 'out'} there.`,
  /** The list read again shows it did not. */
  notTaken: (host: string, source: string, signingIn: boolean): string => signingIn
    ? `${host} did not answer, so Sotto read its model sources again: ${source} is not signed in there, so nothing was saved. Try again.`
    : `${host} did not answer, so Sotto read its model sources again: ${source} is still signed in there. Try again.`,
  /** A call that names no source: the window reads the list again under the tiles. */
  untold: (host: string): string =>
    `${host} did not answer, so Sotto could not tell whether anything was signed in or out there. It is reading ${host}’s model sources again; look under them before you try again.`,
  /** The list could not be read again either. */
  unknown: (host: string): string =>
    `${host} did not answer, so Sotto could not tell whether anything was signed in or out there, and could not read its model sources to find out. Check that ${host} is connected, then look under its model sources before you try again.`,
  /** Reading the list itself got no answer; a read changes nothing. */
  unread: (host: string): string => `${host} did not answer, so Sotto could not read its model sources. Nothing was changed. Check that ${host} is connected, then try again.`,
  /** A pasted code whose answer was lost while the sign-in still waits: the host may never have had it, so it is asked for again. */
  code: (host: string): string => `${host} did not answer, so Sotto could not tell whether it took the code. The sign-in is still waiting. Paste the code again.`,
  /** Asking for a waiting sign-in's page got no answer, so the page did not open. */
  page: (host: string): string => `${host} did not answer, so the sign-in page did not open. Nothing was saved. Press Open the page again.`,
} as const

/**
 * A host that sends no OpenCode row, one from before #1107 or one whose OpenCode is held: it has no OpenCode tile, and this
 * says what would give it one. This computer's version of the host is an Owl one whenever this computer offers OpenCode.
 */
export const opencodeNotOnHost = (host: string): string =>
  `OpenCode does not run on ${host}’s host. To use it there, put this computer’s version of the host on ${host}, stop the host and connect again.`
/** A host from before #1107 does not list `opencode-sign-in`: its tile says so, and nothing is sent to it. */
export const opencodeHostNeedsUpdate = (host: string): string =>
  `The host on ${host} cannot sign OpenCode in to model sources from here. Nothing was changed. Put this computer’s version of the host on ${host}, stop the host and connect again.`
/**
 * A browser sign-in OpenCode finishes by sending the browser back to its own machine (checked against 2.0.31: every `auto`
 * sign-in without a code, whose page names a `localhost` or `127.0.0.1` address to come back to). A browser on this
 * computer cannot reach OpenCode on the host, so on a host it is cancelled as it starts, and only a key, a pasted code or
 * a device code signs in.
 */
export const opencodeSignInComesBack = (host: string): string =>
  `This way of signing in finishes by sending your browser back to OpenCode on ${host}, which the browser on this computer cannot reach. Nothing was saved. Choose another way to sign in, such as a key.`
/** Whether an address OpenCode gave is one Sotto opens: https, with a host name and no user name or password in it. */
export function isOpenCodeSignInPage(address: string): boolean {
  try { const url = new URL(address); return url.protocol === 'https:' && !url.username && !url.password && Boolean(url.hostname) } catch { return false }
}
