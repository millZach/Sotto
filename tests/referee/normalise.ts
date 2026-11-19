// The values that differ between two honest runs of the same host, and what the referee puts in their place.
//
// Each rule is a place a wrong host could hide a wrong value, so each is as narrow as the difference it covers, and each
// says why it exists. `docs/verification/2026-11-19-referee-harness.md` lists them for a reader of the recordings.

export interface RunPlaces {
  /** The run's data folder, which the host's projects and working folders sit in. */
  readonly data: string
  /** The repository checkout the fakes run from. */
  readonly repo: string
}

/** One rule, as the documentation and a failure name it. */
export interface NormalisationRule { readonly name: string; readonly why: string }

export const NORMALISATION_RULES: readonly NormalisationRule[] = [
  { name: 'folders', why: 'The data folder is made afresh for each run and the checkout sits wherever it was cloned, so each is written <data> and <repo>, wherever a string holds it.' },
  { name: 'ids', why: 'IDs a host or a fake makes with randomUUID differ on every run, and so do the IDs the OpenCode fake makes in OpenCode\'s own shape (a short lowercase prefix such as per or msg, an underscore and 26 hexadecimal digits, from the time and random bytes). Each distinct one becomes <id:N>, numbered by where it first appears in the run\'s compared material, so a value that should name the same thing twice still has to, and one that names something else still differs.' },
  { name: 'digest IDs', why: 'Adapters name activity records, requests and messages by a SHA-256 of the provider\'s own IDs (`codex-activity-…`, `grok-request-…`, `muse-approval-…`, `grok-assistant-…`), which are random, so 64 hexadecimal digits that end an ID after a word and a hyphen are named as an ID is. A digest that stands alone, such as an attachment\'s, is of fixed bytes and is left as it is.' },
  { name: 'detail revisions', why: 'A thread detail\'s revision counts the host\'s updates to it, and how many there are depends on how the provider\'s events were batched. In a detail (an object with threadId, messages and revision) it is written <revision>; the referee checks as each arrives that revisions only increase and that every delta follows the revision held.' },
  { name: 'catalog revisions', why: 'A shell names its model catalog by a revision the host counts up each time the catalog changes, and how many times it changes while providers connect at start differs from run to run. `host.modelsRevision` is written <revision>; the referee checks as each shell arrives that a catalog left out names a revision the client was sent.' },
  { name: 'answer echoes', why: 'A send\'s answer carries the shell as it is when the command returns, and the provider\'s acknowledgement may land before or after that. It writes the thread record\'s lastUserMessageId, lastTurn, activities and summary, and for OpenCode, whose echo settles a send before its acknowledgement, its status (the host service contract\'s `sendAnswerRunning`). In the answer to a `manual-send` only, those four fields, and for OpenCode the status, are left out of its thread records; the same fields are compared in what every client holds once the step is over. Every other command\'s answer is compared whole.' },
  { name: 'empty monitoring', why: 'Claude Code\'s adapter writes a thread\'s monitoring as an empty list when it last read the thread from the CLI\'s output, and leaves it out when it last read it from the transcript, and which comes last differs from run to run (#2698). An empty list and none mean the same to a client, so `monitoring: []` on a thread record is left out.' },
  { name: 'key order', why: 'A JSON object\'s keys have no order the protocol promises, and the host builds some objects in a different order from run to run, so keys are put in order before anything is named or compared.' },
  { name: 'times', why: 'Wall-clock instants differ on every run. An ISO-8601 instant becomes <time>, and so does a number between 10^12 and 10^13, which is an instant in milliseconds from 2001 to 2286; nothing the protocol counts reaches that size.' },
  { name: 'latencies', why: 'A delivery records how long its own send took on this machine (localFeedbackMs, providerLatencyMs). Those two fields, and no other, are written <ms>.' },
  { name: 'secrets', why: 'The pairing code, the client token, the session and the admin bearer are random by design. They are written <secret> where the HTTP answers and the request envelope carry them.' },
  { name: 'listener', why: 'A host listens on a port it is given by the system and runs as a process it does not choose, so health\'s port and pid are written <port> and <pid>.' },
]

/** `value` without the named keys. */
const without = (value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[a-z]{2,4}_[0-9a-f]{26}\b|(?<=[a-z]-)[0-9a-f]{64}\b/giu
const ISO_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/gu
const SECRET_KEYS: ReadonlySet<string> = new Set(['session', 'token', 'adminToken'])
const LATENCY_KEYS: ReadonlySet<string> = new Set(['localFeedbackMs', 'providerLatencyMs'])

/**
 * Normalises values in the order the run's material is compared, naming each UUID the first time it is met. One instance
 * covers one run, so the same UUID gets the same name everywhere in it.
 */
export class Normaliser {
  private readonly names = new Map<string, string>()
  private readonly folders: [string, string][]

  constructor(private readonly places: RunPlaces) {
    // The longer folder first, so a data folder inside the checkout is not half replaced.
    this.folders = ([[places.data, '<data>'], [places.repo, '<repo>']] as [string, string][]).sort((a, b) => b[0].length - a[0].length)
  }

  /** A normaliser that goes on from the names this one has given, without giving this one any new names. */
  copy(): Normaliser {
    const copy = new Normaliser(this.places)
    for (const [id, name] of this.names) copy.names.set(id, name)
    return copy
  }

  private string(value: string): string {
    let text = value
    for (const [folder, name] of this.folders) text = text.split(folder).join(name)
    text = text.replace(ISO_INSTANT, '<time>')
    return text.replace(IDS, id => {
      const key = id.toLowerCase()
      let name = this.names.get(key)
      if (!name) { name = `<id:${this.names.size + 1}>`; this.names.set(key, name) }
      return name
    })
  }

  /** A copy of `value` with every rule applied. `secretKeys` are written <secret> wherever they appear as a key. */
  value(value: unknown, secretKeys: ReadonlySet<string> = SECRET_KEYS): unknown {
    if (typeof value === 'string') return this.string(value)
    if (typeof value === 'number') return value >= 1e12 && value < 1e13 ? '<time>' : value
    if (Array.isArray(value)) return value.map(item => this.value(item, secretKeys))
    if (value === null || typeof value !== 'object') return value
    const out: Record<string, unknown> = {}
    const detail = 'threadId' in value && 'messages' in value && typeof (value as { revision?: unknown }).revision === 'number'
    // Keys are normalised too: a record keyed by thread ID names its thread there.
    for (const [key, item] of Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      out[this.string(key)] = secretKeys.has(key) && typeof item === 'string' ? '<secret>'
        : LATENCY_KEYS.has(key) && typeof item === 'number' ? '<ms>'
          : (detail && key === 'revision') || (key === 'modelsRevision' && typeof item === 'number') ? '<revision>' : this.value(item, secretKeys)
    }
    // A thread record: what it says about itself, as the empty monitoring rule describes.
    if ('id' in out && 'projectId' in out && 'modelId' in out && Array.isArray(out.monitoring) && out.monitoring.length === 0) delete out.monitoring
    return out
  }

  /** A send's answer, with the fields a provider's acknowledgement writes left out of its thread records. */
  sendAnswer(result: unknown, provider: string): unknown {
    const echoes = ['lastUserMessageId', 'lastTurn', 'activities', 'summary', ...provider === 'opencode' ? ['status'] : []]
    const host = (result as { host?: { threads?: unknown } } | null)?.host
    if (!host || !Array.isArray(host.threads)) return result
    const threads = host.threads.map(thread => thread === null || typeof thread !== 'object' ? thread
      : without(thread as Record<string, unknown>, echoes))
    return { ...(result as object), host: { ...host, threads } }
  }

  /** An HTTP answer's body, with the pairing code and the listener's port and pid written as the rules say. */
  http(path: string, body: unknown): unknown {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return this.value(body)
    const copy = { ...(body as Record<string, unknown>) }
    if (path === '/v1/admin/pairing-code' && typeof copy.code === 'string') copy.code = '<secret>'
    if (path === '/v1/health') { if (typeof copy.port === 'number') copy.port = '<port>'; if (typeof copy.pid === 'number') copy.pid = '<pid>' }
    return this.value(copy)
  }
}
