// The fake providers as the referee harness drives them: from outside the host, through files alone.
//
// A host in another language cannot be reached in process, so nothing here calls an adapter. A driver action finds the
// fake's native session through two records the host keeps in its data folder, which every host keeps the same way
// (docs/plans/2026-11-14-rust-native-port.md, "Same files, both ways"): `threads.json`, whose bindings name the adapter's
// own ID for a Sotto thread, and the adapter's `<provider>-threads.json`, which names the native session for that ID.
// It then writes the action where that provider's fake reads one (`tests/fixtures/fake*.mjs`).
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId } from '../../src/shared/agents'

/**
 * The Sotto version every referee host reports, Owl so that OpenCode and Cursor, Owl providers (ADR-0087, ADR-0128), are
 * hosted and every held feature is on. A host under test reports it as well, or the recordings' `sottoVersion` differs.
 */
export const REFEREE_OWL_VERSION = '0.1.44-owl.20261118.2'

/** Where one fake reads its driver actions and how a host's records name its session. */
interface FakeLayout {
  /** The adapter's saved records, keyed by the adapter's own thread ID. */
  readonly record: string
  /** The field of a saved record that holds the native session ID. */
  readonly native: string
  /** `shared`: one `control.json` naming its session by `identity`. `session`: `control-<native>.json`. */
  readonly control: 'shared' | 'session'
  readonly identity?: 'threadId' | 'sessionId'
}

/**
 * Every provider a host takes that has a fake program (`HOST_PROVIDERS` in `src/shared/hostProviders.ts`). Hermes is a
 * host provider too and has no fake program yet, so it has no recording; Pi and DeepSeek Harness are held on every host
 * (ADR-0138, `heldOnHost`), so a host starts nothing for them.
 */
export const REFEREE_FAKES = {
  codex: { record: 'codex-threads.json', native: 'codexThreadId', control: 'shared', identity: 'threadId' },
  claude: { record: 'claude-threads.json', native: 'sessionId', control: 'session' },
  grok: { record: 'grok-threads.json', native: 'grokSessionId', control: 'shared', identity: 'sessionId' },
  devin: { record: 'devin-threads.json', native: 'devinSessionId', control: 'session' },
  muse: { record: 'muse-threads.json', native: 'museSessionId', control: 'shared', identity: 'sessionId' },
  opencode: { record: 'opencode-threads.json', native: 'sessionId', control: 'shared', identity: 'sessionId' },
  cursor: { record: 'cursor-threads.json', native: 'cursorSessionId', control: 'shared', identity: 'sessionId' },
} as const satisfies Partial<Record<ProviderId, FakeLayout>>

export type RefereeProvider = keyof typeof REFEREE_FAKES
export const REFEREE_PROVIDERS = Object.keys(REFEREE_FAKES) as RefereeProvider[]

/** One action a scenario asks of a fake: the same vocabulary as the contract's driver (`AdapterFixture['driver']`). */
export type DriverAction =
  | { readonly type: 'complete'; readonly thread: string; readonly text: string }
  | { readonly type: 'question'; readonly thread: string; readonly text: string }
  | { readonly type: 'permission'; readonly thread: string; readonly text: string }

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

/** The native session of a Sotto thread as the host's records name it now, or a sentence saying which record lacks it. */
async function recordedSession(data: string, provider: RefereeProvider, threadId: string): Promise<string | Error> {
  const layout: FakeLayout = REFEREE_FAKES[provider]
  const registry = await readJson(join(data, 'threads.json')).catch(() => undefined) as { bindings?: { threadId: string; sessionId: string }[] } | undefined
  const adapterId = registry?.bindings?.find(binding => binding.threadId === threadId)?.sessionId
  if (!adapterId) return new Error(`The host's threads.json binds no session to thread ${threadId}, so the fake cannot be driven.`)
  const records = await readJson(join(data, layout.record)).catch(() => undefined) as Record<string, Record<string, unknown>> | undefined
  const native = records?.[adapterId]?.[layout.native]
  return typeof native === 'string' ? native : new Error(`The host's ${layout.record} names no ${layout.native} for session ${adapterId}.`)
}

/**
 * The native session of a Sotto thread. A host may write its records a little after the thread shows running, so they are
 * read again until they name it; the deadline is generous, and a host that never writes them fails with the sentence.
 */
export async function nativeSession(data: string, provider: RefereeProvider, threadId: string, deadlineMs = 15_000): Promise<string> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const found = await recordedSession(data, provider, threadId)
    if (typeof found === 'string') return found
    if (Date.now() > deadline) throw found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * What a fake is told before the host starts it, through the script file it reads at start. The Codex fake numbers the
 * requests it sends from its process ID unless told a base, so it is told one: the numbers then reach the wire the same
 * on every run.
 */
export async function prepareFake(data: string, provider: RefereeProvider): Promise<void> {
  if (provider === 'codex') await writeFile(join(data, 'script.json'), JSON.stringify({ requestIdBase: 1000 }))
}

/** Hands the fake one action for a thread, as its control file takes it. */
export async function drive(data: string, provider: RefereeProvider, action: DriverAction): Promise<void> {
  const layout: FakeLayout = REFEREE_FAKES[provider]
  const native = await nativeSession(data, provider, action.thread)
  const value = Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'thread'))
  const body = { id: randomUUID(), ...(layout.identity ? { [layout.identity]: native } : {}), ...value }
  await writeFile(join(data, layout.control === 'shared' ? 'control.json' : `control-${native}.json`), JSON.stringify(body))
}
