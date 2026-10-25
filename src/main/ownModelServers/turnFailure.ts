import type { OwnServerTurnFailure } from '../../shared/agentActivity'

/**
 * How one of the user's own model servers let an OpenCode turn down (ADR-0124, October 24 amendment), read from the
 * error OpenCode ends the turn with (`session.execution.failed`'s `error`, a `SessionError`: `type`, `message`, `status`,
 * `response.body`). Only `type`, `status` and `message` are read. `message` can carry the server's own text and
 * `response.body` is its raw answer, so neither is kept, returned or logged: the answer is one of five kinds, or
 * undefined for a failure that is none of them, which keeps OpenCode's general words.
 *
 * What OpenCode sends, read in 2.0.31's source and seen live on 2.1.4 against a fake server (October 23, 2026):
 * - a refused or unreachable server, after its ten retries: `provider.transport`, "ECONNREFUSED: …", no status;
 * - no response headers within OpenCode's 300 seconds: `provider.transport`, "Timed out waiting for response headers".
 *   OpenCode retries that up to three more times; Sotto stops the turn at the first (`isHeaderTimeout`);
 * - a key turned down: `provider.auth`, status 401 (or 403), never retried;
 * - a model the server does not have: `provider.invalid-request`, status 404 ("The model `x` does not exist." from vLLM;
 *   "model 'x' not found" from Ollama), never retried;
 * - a prompt longer than the model's context: `provider.invalid-request`, status 400, 413 or 422, with one of the
 *   sentences OpenCode itself reads as a context overflow (`packages/ai/src/provider-error.ts`), or `compaction.failed`
 *   when OpenCode's own compaction could not make the thread fit.
 */
export interface OpenCodeTurnError { readonly type?: unknown; readonly status?: unknown; readonly message?: unknown }

/**
 * The sentences servers refuse an over-long prompt with, as OpenCode's own overflow list has them: vLLM ("maximum context
 * length is N tokens"), SGLang ("is longer than the model's context length"), llama.cpp ("exceeds the available context
 * size"), TGI ("`inputs` tokens + `max_new_tokens` must be <= N", "`inputs` must have less than N tokens") and Ollama
 * ("the input length exceeds the context length").
 */
const TOO_LONG = [
  /maximum context length is \d+ tokens/iu,
  /exceeds (?:the )?(?:model's )?maximum context length/iu,
  /exceeds the available context size/iu,
  /longer than the model's context length/iu,
  /`inputs` tokens \+ `max_new_tokens` must be <= \d+/iu,
  /`inputs` must have less than \d+ tokens/iu,
  /context[_ ]length[_ ]exceeded/iu,
  /input length.*exceeds.*context length/iu,
  /input is too long for (?:the )?(?:requested|selected) model/iu,
  /too large for the model's configured input limit/iu,
  /prompt exceeds max length/iu,
]
/** OpenCode's own words when its compaction could not make a thread fit the model (`compaction.ts`). */
const CANNOT_COMPACT = /cannot be reduced further/iu
/** OpenCode's HTTP transport giving up on a server that took the request and sent no headers (`route/transport/http.ts`). */
const HEADER_TIMEOUT = /timed out waiting for response headers/iu

const fields = (error: unknown): { readonly kind: string; readonly code: number | undefined; readonly said: string } | undefined => {
  if (error === null || typeof error !== 'object') return undefined
  const { type, status, message } = error as OpenCodeTurnError
  return { kind: typeof type === 'string' ? type : '', code: typeof status === 'number' ? status : undefined, said: typeof message === 'string' ? message.slice(0, 4_000) : '' }
}

/** OpenCode gave up waiting for the server's first byte, after its 300 seconds. */
export function isHeaderTimeout(error: unknown): boolean {
  const read = fields(error)
  return read !== undefined && (read.kind === 'provider.timeout' || (read.kind === 'provider.transport' && HEADER_TIMEOUT.test(read.said)))
}

export function ownServerTurnFailure(error: unknown): OwnServerTurnFailure | undefined {
  const read = fields(error)
  if (read === undefined) return undefined
  const { kind, code, said } = read
  if (kind === 'provider.auth' || code === 401 || code === 403) return 'key-refused'
  if (kind === 'compaction.failed') return CANNOT_COMPACT.test(said) ? 'too-long' : undefined
  if (code === 413 || ((code === 400 || code === 422 || kind === 'provider.invalid-request') && TOO_LONG.some(pattern => pattern.test(said)))) return 'too-long'
  if (code === 404) return 'model-gone'
  if (isHeaderTimeout(error)) return 'timeout'
  // A server that stopped part-way through its answer timed out too, but it had started answering: not these words.
  if (kind === 'provider.transport') return /timed out/iu.test(said) ? undefined : 'unreachable'
  return undefined
}
