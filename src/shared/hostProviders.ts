import { z } from 'zod'
import { PROVIDER_LABELS, providerIdSchema, type AgentProviderStatus, type ProviderId, type ProviderProblem } from './agents'

/**
 * A host's providers from this computer (ADR-0037): the tiles under a connected host's row in Settings > Hosts, the
 * host's own connect, disconnect and refresh for one of its providers, and a provider's sign-in, run on the host by its
 * own client and finished by the user in this computer's browser.
 */

/** How long a sign-in lives on the host before its client is stopped and what it printed is dropped. */
export const PROVIDER_SIGN_IN_LIFETIME_MS = 15 * 60_000

/**
 * The two ways a provider's client signs in without a terminal. `device-code`: it prints a page and a short code, the
 * user enters the code on that page, and the client finishes by itself (Codex, Grok Build). `paste-code`: it prints a
 * page, the page shows a code once the user signs in, and the client waits for that code (Claude Code).
 */
export const providerSignInShapeSchema = z.enum(['device-code', 'paste-code'])
export type ProviderSignInShape = z.infer<typeof providerSignInShapeSchema>

/**
 * Where a sign-in stands. `starting` until the client has printed its page; `waiting` for the user; `finishing` while a
 * pasted code is with the client; then `connected`, `refused` (the client did not accept a pasted code), `failed`
 * (anything else ended it) or `ended` (cancelled, or past its fifteen minutes).
 */
export const providerSignInStageSchema = z.enum(['starting', 'waiting', 'finishing', 'connected', 'refused', 'failed', 'ended'])
export type ProviderSignInStage = z.infer<typeof providerSignInStageSchema>

/** Which providers sign in from this computer, and how. Devin's sign-in needs a terminal, so its tile shows the command. */
export const PROVIDER_SIGN_IN_SHAPES: Readonly<Record<ProviderId, ProviderSignInShape | null>> = {
  codex: 'device-code', grok: 'device-code', claude: 'paste-code', devin: null,
}
/** What Devin's tile says to run on the host: its sign-in for a machine reached over SSH, where a browser cannot come back to it. */
export const DEVIN_SIGN_IN_COMMAND = 'devin auth login --force-manual-token-flow'

/**
 * Each provider's install page as its maker publishes it, the same pages the host's install brief cites
 * (`src/main/hosts/hostProviderBrief.ts`). First-run setup opens one in the browser on a press, for a provider this
 * computer does not have or has too old.
 */
export const PROVIDER_INSTALL_GUIDES: Readonly<Record<ProviderId, string>> = {
  codex: 'https://github.com/openai/codex',
  claude: 'https://code.claude.com/docs/en/setup',
  grok: 'https://docs.x.ai/build/overview',
  devin: 'https://docs.devin.ai/cli',
}

/**
 * The only pages a host's sign-in may open, by provider: https, one of these names exactly, no port, no user. They are
 * the pages each client printed when its sign-in was run: Codex's `https://auth.openai.com/codex/device`, Grok Build's
 * `https://accounts.x.ai/oauth2/device`, and Claude Code's `https://claude.com/cai/oauth/authorize`, which older
 * versions printed on `claude.ai`. A page anywhere else is not opened, and the sign-in says to finish it on the host.
 */
export const PROVIDER_SIGN_IN_PAGES: Readonly<Record<ProviderId, readonly string[]>> = {
  codex: ['auth.openai.com'], grok: ['accounts.x.ai'], claude: ['claude.com', 'claude.ai'], devin: [],
}
export function isProviderSignInPage(provider: ProviderId, value: string): boolean {
  if (value.length > 4096 || /\s/u.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.port === '' && !url.username && !url.password && PROVIDER_SIGN_IN_PAGES[provider].includes(url.hostname)
  } catch { return false }
}

/**
 * One sign-in as the host tells the client that started it, and nobody else. `url` and `code` are there only while it
 * waits for the user and are never logged or written down on either side; `page` is the name of the page's host, which
 * the dialog says the user is awaited on. `message` says what happened when it did not end connected.
 */
/** The longest sentence a sign-in's `message` carries; the host shortens a longer one rather than send what fails the schema. */
export const SIGN_IN_MESSAGE_MAX = 600
export const hostSignInSchema = z.object({
  id: z.uuid(), provider: providerIdSchema, shape: providerSignInShapeSchema, stage: providerSignInStageSchema,
  url: z.string().min(1).max(4096).optional(), code: z.string().min(1).max(64).optional(), page: z.string().min(1).max(253).optional(),
  expiresInMinutes: z.number().int().min(1).max(60).optional(), message: z.string().min(1).max(SIGN_IN_MESSAGE_MAX).optional(),
}).strict()
export type HostSignIn = z.infer<typeof hostSignInSchema>
/** What the window is given: the host's view without the page's address, which only main holds, and only to open it. */
export type ProviderSignInView = Omit<HostSignIn, 'url'>

/** The longest code Sotto hands a client. Claude Code's is a code and a state joined by `#`, well under this. */
export const PASTED_CODE_MAX = 2048

/** What Settings > Hosts asks of one of a saved host's providers. `id` is the saved host's. */
export const hostProviderActionSchema = z.object({
  id: z.uuid(), provider: providerIdSchema, action: z.enum(['connect', 'disconnect', 'refresh']),
}).strict()
export type HostProviderAction = z.infer<typeof hostProviderActionSchema>
/** How a provider action went: nothing when the host took it, else the host's own sentence, naming the host. */
export interface HostProviderActionResult { readonly error?: string }

export const hostSignInRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), id: z.uuid(), provider: providerIdSchema }).strict(),
  z.object({ type: z.literal('read'), id: z.uuid(), signInId: z.uuid() }).strict(),
  z.object({ type: z.literal('code'), id: z.uuid(), signInId: z.uuid(), code: z.string().min(1).max(PASTED_CODE_MAX) }).strict(),
  z.object({ type: z.literal('cancel'), id: z.uuid(), signInId: z.uuid() }).strict(),
  /** Open sign-in page: main asks the host for the page and opens it, checked, in the default browser. */
  z.object({ type: z.literal('open'), id: z.uuid(), signInId: z.uuid() }).strict(),
])
export type HostSignInRequest = z.infer<typeof hostSignInRequestSchema>

/**
 * A provider job (ADR-0035, amended for #461): an agent in a thread on this computer installs, updates or fixes one
 * provider on one connected host, from that provider's tile. `install` is for a provider the host did not find,
 * `update` for one older than Sotto's floor, `fix` for one installed where the host cannot find or start it.
 */
export const hostProviderJobCaseSchema = z.enum(['install', 'update', 'fix'])
export type HostProviderJobCase = z.infer<typeof hostProviderJobCaseSchema>
/**
 * The job a provider's status calls for, or undefined when none fits: connected, connecting, turned off and not signed in
 * need no agent. An error without a problem code reads as can't be started (an adapter that threw a plain error), so it
 * is a fix, the same as the tile's "Can't be started". The tile and the job's start both decide with this.
 */
export function hostProviderJobCase(status: AgentProviderStatus | undefined): HostProviderJobCase | undefined {
  if (status?.connection !== 'error') return undefined
  const problem: ProviderProblem = status.problem ?? 'cannot-start'
  return problem === 'not-installed' ? 'install' : problem === 'too-old' ? 'update' : problem === 'cannot-start' ? 'fix' : undefined
}
/**
 * Whether a host has found a provider and can start it, which is where a provider job ends: it connected, or it
 * started and said it is not signed in. Signing in is the user's, from the tile (ADR-0037).
 */
export function hostProviderFound(status: AgentProviderStatus | undefined): boolean {
  return status?.connection === 'connected' || status?.connection === 'error' && status.problem === 'signed-out'
}
/**
 * Every word a provider job's case puts in the app, in one place: the thread's and the dialog's title, what the agent
 * does and is doing, the tile's button, the dialog's main button and the working tile's state line.
 */
export const HOST_PROVIDER_JOB_WORDS: Readonly<Record<HostProviderJobCase, {
  readonly title: string; readonly does: string; readonly doing: string; readonly button: string; readonly start: string; readonly working: string
}>> = {
  install: { title: 'Install', does: 'installs', doing: 'installing', button: 'Have my agent install it', start: 'Start install', working: 'Agent is installing it' },
  update: { title: 'Update', does: 'updates', doing: 'updating', button: 'Have my agent update it', start: 'Start update', working: 'Agent is updating it' },
  fix: { title: 'Fix', does: 'fixes', doing: 'fixing', button: 'Have my agent fix it', start: 'Start fix', working: 'Agent is fixing it' },
}
/** The job's thread and dialog title: "Install Devin on forge". */
export function hostProviderJobTitle(jobCase: HostProviderJobCase, provider: ProviderId, host: string): string {
  return `${HOST_PROVIDER_JOB_WORDS[jobCase].title} ${PROVIDER_LABELS[provider]} on ${host}`
}
/**
 * A provider job as Settings > Hosts shows it: which saved host (`hostId`, its saved ID) and provider, the thread working
 * on it and its model. `starting` until the thread has its brief, `running` while it works, then `found` once the host
 * finds the provider, `stopped` on Stop, or `failed` when the thread did not start working, with the reason.
 */
export interface HostProviderJobState {
  readonly id: string
  readonly hostId: string
  readonly host: string
  readonly provider: ProviderId
  readonly case: HostProviderJobCase
  /** The job's thread as the window addresses it. Absent until the thread exists. */
  readonly threadId?: string | undefined
  readonly threadTitle: string
  readonly modelName: string
  readonly phase: 'starting' | 'running' | 'found' | 'stopped' | 'failed'
  readonly error?: string | undefined
}

/**
 * Update from a provider tile, or Update all from the host's client updates (#480): `update` puts the clients in that
 * host's own one-at-a-time update line, and `cancel` takes one that is still waiting out of it. The host's shell says
 * how each goes. `id` is the saved host's.
 */
export const hostClientUpdateRequestSchema = z.object({
  id: z.uuid(), action: z.enum(['update', 'cancel']), providers: z.array(providerIdSchema).min(1).max(4),
}).strict()
export type HostClientUpdateRequest = z.infer<typeof hostClientUpdateRequestSchema>

export const HOSTS_PROVIDER_ACTION = 'hosts:provider-action'
export const HOSTS_UPDATE_CLIENTS = 'hosts:update-clients'
export const HOSTS_SIGN_IN = 'hosts:sign-in'
