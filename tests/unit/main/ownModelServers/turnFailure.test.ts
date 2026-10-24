// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isHeaderTimeout, ownServerTurnFailure } from '../../../../src/main/ownModelServers/turnFailure'
import { ownServerTurnText, ownServerTurnWords } from '../../../../src/shared/ownModelServers'

describe('how one of the user’s own servers let a turn down', () => {
  it.each([
    // OpenCode 2.1.4 against a refused port, after its ten retries.
    ['a refused connection', { type: 'provider.transport', message: 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?' }, 'unreachable'],
    ['a name not found', { type: 'provider.transport', message: 'getaddrinfo ENOTFOUND spark-head' }, 'unreachable'],
    // OpenCode 2.1.4 after 300 seconds with no response headers.
    ['OpenCode’s five minutes with no first byte', { type: 'provider.transport', message: 'Timed out waiting for response headers' }, 'timeout'],
    ['a timeout of another route', { type: 'provider.timeout', message: 'Request timed out' }, 'timeout'],
    ['a key turned down', { type: 'provider.auth', status: 401, message: 'Invalid API key.' }, 'key-refused'],
    ['a key forbidden', { type: 'provider.invalid-request', status: 403, message: 'Forbidden' }, 'key-refused'],
    ['vLLM and SGLang without the model', { type: 'provider.invalid-request', status: 404, message: 'The model `m` does not exist.' }, 'model-gone'],
    ['Ollama without the model', { type: 'provider.invalid-request', status: 404, message: 'model "llama3" not found, try pulling it first' }, 'model-gone'],
    ['vLLM’s context refusal', { type: 'provider.invalid-request', status: 400,
      message: 'This model\'s maximum context length is 163840 tokens. However, you requested 170000 tokens (165000 in the messages, 5000 in the completion).' }, 'too-long'],
    ['SGLang’s context refusal', { type: 'provider.invalid-request', status: 400,
      message: 'The input (170000 tokens) is longer than the model\'s context length (163840 tokens).' }, 'too-long'],
    ['llama.cpp’s context refusal', { type: 'provider.invalid-request', status: 400, message: 'the request exceeds the available context size, try increasing it' }, 'too-long'],
    ['TGI’s context refusal', { type: 'provider.invalid-request', status: 422,
      message: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 8192. Given: 8000 `inputs` tokens and 1024 `max_new_tokens`' }, 'too-long'],
    ['Ollama’s context refusal', { type: 'provider.invalid-request', status: 413, message: 'the input length exceeds the context length' }, 'too-long'],
    ['a body too large for the server', { type: 'provider.invalid-request', status: 413, message: 'Payload Too Large' }, 'too-long'],
    ['OpenCode’s compaction that could not make the thread fit', { type: 'compaction.failed',
      message: 'The compaction request cannot be reduced further without losing the latest exchange or checkpoint' }, 'too-long'],
  ])('reads %s', (_name, error, kind) => {
    expect(ownServerTurnFailure(error)).toBe(kind)
  })

  it.each([
    ['a refusal of another kind', { type: 'provider.invalid-request', status: 400, message: 'Invalid tool schema' }],
    ['a server that stalled part-way through its answer', { type: 'provider.transport', message: 'Timed out waiting for response data' }],
    ['a compaction that failed for another reason', { type: 'compaction.failed', message: 'Compaction failed' }],
    ['a server error after the retries', { type: 'provider.internal', status: 503, message: 'Service Unavailable' }],
    ['a content filter', { type: 'provider.content-filter', message: 'Blocked' }],
    ['an error with no type', { message: 'Something happened' }],
    ['no error', undefined],
    ['an error that is not an object', 'provider.transport'],
  ])('leaves %s to OpenCode’s general words', (_name, error) => {
    expect(ownServerTurnFailure(error)).toBeUndefined()
  })

  it('tells OpenCode’s wait for a first byte from every other transport error', () => {
    expect(isHeaderTimeout({ type: 'provider.transport', message: 'Timed out waiting for response headers' })).toBe(true)
    expect(isHeaderTimeout({ type: 'provider.transport', message: 'Timed out waiting for response data' })).toBe(false)
    expect(isHeaderTimeout({ type: 'provider.transport', message: 'ECONNREFUSED: Unable to connect.' })).toBe(false)
    expect(isHeaderTimeout(undefined)).toBe(false)
  })

  it('keeps the words Zach chose, with the server, model and address filled in', () => {
    const turn = { name: 'Sparks', model: 'DeepSeek V4.1 Flash', host: 'spark-head:8888' }
    expect(ownServerTurnText('unreachable', turn)).toBe('Sparks didn’t answer. OpenCode tried it 10 times over about a minute and a half. Nothing in the thread was lost. Check that Sparks is on and this computer can reach spark-head:8888, then try again.')
    expect(ownServerTurnText('timeout', turn)).toBe('Sparks didn’t start answering within 5 minutes. It took the message but sent nothing back. It may be busy, stuck or still reading a very long prompt. Nothing in the thread was lost. Check Sparks, then try again.')
    expect(ownServerTurnText('key-refused', turn)).toBe('Sparks turned down its key. Nothing in the thread was lost. In Settings › Providers › Your own model servers, remove Sparks and add it again with the right key, then try again.')
    expect(ownServerTurnText('model-gone', turn)).toBe('Sparks no longer has DeepSeek V4.1 Flash. Nothing in the thread was lost. Pick another model in the model menu below, or load DeepSeek V4.1 Flash on Sparks again, then try again.')
    expect(ownServerTurnText('too-long', turn)).toBe('This thread is too long for DeepSeek V4.1 Flash. Your last message and the thread before it are more than the model takes at once. Nothing in the thread was lost. OpenCode threads can’t be compacted in Sotto, so pick a model with more context and try again, or start a new thread.')
    expect(ownServerTurnWords('key-refused', turn).title).toBe('Sparks turned down its key.')
  })
})
